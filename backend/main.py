from fastapi import FastAPI, HTTPException, Response, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from pydantic import BaseModel
from serial.tools import list_ports
import sys
import os
import asyncio
import json
from pathlib import Path
from datetime import datetime, timezone

from utils.logger import logger, log_buffer
from devices.stage_controller import StageController
from devices.camera_controller import CameraController

# グローバルインスタンスの作成
# アプリケーション全体で1つのコントローラーを共有します（シングルトンパターン）
# これにより、どのAPIエンドポイントから呼び出されても、常に同じハードウェア状態を操作・参照できます。
stage = StageController()
camera = CameraController()

class SystemState:
    """フロントエンドへ即座に返すための状態キャッシュ（メモリ）"""
    def __init__(self):
        self.current_angle = 0.0
        self.is_busy = False       # ハードウェア: ステージが物理的に移動・回転中か
        self.is_measuring = False  # ソフトウェア: Sweep等の自動測定シーケンスが実行中か

app_state = SystemState()

async def stage_monitor_loop():
    """【常時監視タスク】0.1秒ごとにステージの角度を聞き、キャッシュとカメラに最新値を配ります。

    Returns:
        None
    """
    logger.info("[SYSTEM] Stage monitor loop started.")
    while True:
        try:
            # asyncio.sleep はイベントループを止めずに待機する標準の非同期関数です。
            await asyncio.sleep(0.1)
            if stage.is_connected:
                # シリアル通信はI/O待ちが発生するため、to_threadで別スレッドとして実行しAPIをブロックさせない
                pos, busy = await asyncio.to_thread(stage.get_status)
                sampled_at_ms = datetime.now(timezone.utc).timestamp() * 1000.0
                app_state.current_angle = pos
                app_state.is_busy = busy
                
                # カメラのCSV記録用にも常に最新の角度を供給し続ける
                camera.current_angle = pos
                camera.current_angle_timestamp_ms = sampled_at_ms
        except asyncio.CancelledError:
            break # サーバー終了時にタスクがキャンセルされたらループを抜ける
        except Exception as e:
            logger.debug(f"[SYSTEM] Monitor error: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    【ライフサイクル管理】FastAPIアプリケーションの起動・終了時の処理を定義します。
    
    yield の前のコードはサーバー起動時（startup）に実行され、
    yield の後のコードはサーバー終了時（shutdown、Ctrl+Cなど）に実行されます。
    これにより、アプリケーション終了時にハードウェアリソースを安全かつ確実に解放できます。
    
    Args:
        app (FastAPI): FastAPIのアプリケーションインスタンス。

    Returns:
        AsyncGenerator: 起動・終了処理を管理するコンテキスト。
    """
    logger.info("[SYSTEM] Backend Starting...")
    
    # 常時監視タスクの起動
    # asyncio.create_task は、非同期関数をバックグラウンドで並行実行させる標準機能です。
    monitor_task = asyncio.create_task(stage_monitor_loop())
    
    # ここでサーバーが起動し、リクエストの受付を開始します。
    yield # ここでサーバーがリクエストを受け付け続ける（稼働状態）
    
    # サーバー終了時(shutdown)の処理
    # Ctrl+Cなどで停止した際に、開いているリソース（COMポート、カメラ）を確実に閉じます。
    logger.info("[SYSTEM] Backend Shutting Down...")
    
    # 監視タスクの停止
    monitor_task.cancel()
    
    # 強制的に切断処理
    logger.info("[SYSTEM] Releasing Stage Conection...")
    if stage.is_connected:
        stage.close()
    
    logger.info("[SYSTEM] Releasing Camera Conection...")
    if camera.is_connected:
        camera.disconnect()
    
    logger.info("[SYSTEM] Cleanup Complete.")

app = FastAPI(title="NanoPol Backend", version="0.1.0", lifespan=lifespan)

# ==========================================
# CORS (Cross-Origin Resource Sharing) の設定
# ==========================================
# Tauriのフロントエンド（React: 通常は localhost:1420 や tauri://localhost）から、
# このバックエンドサーバー（localhost:14201）へのHTTPリクエストを許可するためのセキュリティ設定です。
# 
# 【重要】allow_credentials=True（認証情報の送信許可）に設定する場合、
# Web標準のセキュリティ仕様により allow_origins=["*"]（全許可）は使用できずエラーになります。
# そのため、Tauriアプリが使用する固有のオリジンを明示的にリストアップして許可します。
# CORSの許可オリジンを一元管理します。
# この配列を CORSMiddleware 設定と起動時ログ出力の両方で共通利用することで、
# 「実際に許可している値」と「ログで表示している値」の不一致を防ぎます。
allowed_origins = [
    "http://localhost:1420",  # 開発中のTauriフロントエンド (Viteローカルサーバー)
    "tauri://localhost",      # ビルド後のTauriアプリ (macOS / Linux)
    "https://tauri.localhost",# ビルド後のTauriアプリ (Windows HTTPS)
    "http://tauri.localhost"  # ビルド後のTauriアプリ (Windows HTTP)
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True, # クッキーや認証情報の送信を許可します。
    allow_methods=["*"], # GET, POST, OPTIONSなど、全てのHTTPメソッドを許可します。
    allow_headers=["*"], # 全てのHTTPヘッダーの送信を許可します。
)

# ==========================================
# CORS ログ出力（スタートアップ確認用）
# ==========================================
# 起動直後に「現在のCORS許可設定」を必ず1回表示します。
# 運用時に問題が発生した際、設定ファイルや環境変数を追わなくても
# コンソールログだけで有効なオリジン一覧を確認できるようにするためです。
logger.info("[STARTUP] CORS allow_origins configured:")
for origin in allowed_origins:
    logger.info(f"[STARTUP] [OK] {origin}")

# ==========================================
# OPTIONS リクエスト ログ用ミドルウェア
# ==========================================
@app.middleware("http")
async def log_cors_requests(request: Request, call_next):
    """CORS preflight（OPTIONS）リクエストの往復情報をログに出力する。"""
    # CORS障害の初動切り分けでは、まず「どのOriginが来たか」を確認する必要があります。
    # ここで request.headers["origin"] を記録することで、
    # フロント実際のOriginと allow_origins の不一致を即座に判断できます。
    origin = request.headers.get("origin", "N/A")
    method = request.method
    path = request.url.path
    
    if method == "OPTIONS":
        # preflight受信ログ: ブラウザが本リクエスト前に送る検証要求。
        # ここが出ない場合は、クライアント側で到達していない可能性が高いです。
        logger.debug(f"[CORS PREFLIGHT] {method} {path} Origin={origin}")
    
    response = await call_next(request)
    
    if method == "OPTIONS":
        # preflight応答ログ: ステータスと Access-Control-Allow-Origin を確認します。
        # Status が 400/500、または Allow-Origin が NOT SET の場合は CORS 設定不整合の可能性が高いです。
        allow_origin = response.headers.get("access-control-allow-origin", "NOT SET")
        if response.status_code >= 400 or allow_origin == "NOT SET":
            logger.warning(
                f"[CORS RESPONSE] Status={response.status_code} Allow-Origin={allow_origin} "
                f"Method={method} Path={path} Origin={origin}"
            )
        else:
            logger.debug(
                f"[CORS RESPONSE] Status={response.status_code} Allow-Origin={allow_origin} "
                f"Method={method} Path={path} Origin={origin}"
            )
    
    return response

# ==========================================
# リクエストボディの型定義 (Pydantic Models)
# ==========================================
# クライアント（フロントエンド）からPOST送信されるJSONデータの構造を定義します。
# FastAPIはこれらのモデルを使用して、自動的に以下の処理を行います：
# 1. データの型変換（例: 文字列 "123" を 整数 123 に変換）
# 2. バリデーション（必須項目が欠けていたり、型が間違っている場合は自動でHTTP 422エラーを返す）
# 3. OpenAPI(Swagger UI) ドキュメントの自動生成

class ConnectStageRequest(BaseModel):
    port: str # 接続先のCOMポート名（例: "COM3", "/dev/ttyUSB0"）

class MoveAbsoluteRequest(BaseModel):
    angle: float # 目標とする絶対角度（度）

class MoveRelativeRequest(BaseModel):
    delta: float # 現在位置からの相対的な移動量（度）

class StopStageRequest(BaseModel):
    immediate: bool = False # Trueの場合は非常停止（即時停止）、Falseの場合は減速停止

class SetSpeedRequest(BaseModel):
    min_pps: int = 500 # 最小速度（パルス/秒）。初速として使用されます。
    max_pps: int # 最大速度（パルス/秒）
    accel_time_ms: int = 200 # 最小速度から最大速度に到達するまでの加減速時間（ミリ秒）

class UpdateConfigRequest(BaseModel):
    pulses_per_degree: int # 1度回転させるために必要なモーターのパルス数（分解能）

class CameraConfigRequest(BaseModel):
    exposure_ms: float
    gain: int

class CameraConnectRequest(BaseModel):
    camera_id: int = 0

class SystemSettingsRequest(BaseModel):
    settings: dict # config.json の内容を含む、任意のキー・バリュー設定データ

class SaveSnapshotRequest(BaseModel):
    filepath: str # スナップショット画像を保存する絶対パス

class LogPostRequest(BaseModel):
    level: str # ログレベル（"ERROR", "WARNING", "INFO" など）
    message: str # 記録するログメッセージ

# ==========================================
# システム関連 API
# ==========================================

@app.get("/health")
def health_check(request: Request):
    """
    【フロントエンド起動時の生存確認用API】
    バックエンドサーバーが正常に起動しているか、および各ハードウェアの現在の接続状態を返します。
    
    Args:
        request (Request): 呼び出し元の HTTP リクエスト。origin や host の記録に使います。

    Returns:
        dict: ステータス、ステージの接続状態、カメラの接続状態、動作モード（Mock/Real）。
    """
    # 接続切り分け用: UI/WebViewから到達しているかを system.log だけで判定できるようにする
    # Request.headers は受信した HTTP ヘッダ群へのアクセス手段です。
    logger.info(
        "[HEALTH] %s %s origin=%s host=%s",
        request.method,
        request.url.path,
        request.headers.get("origin", "-"),
        request.headers.get("host", "-"),
    )

    return {
        "status": "OK",
        "stage_connected": stage.is_connected,
        "camera_connected": camera.is_connected,
        "mode": "Mock" if stage.is_mock_env else "Real"
    }

@app.post("/system/reset")
def system_reset():
    """
    【強制リセットAPI】
    システムに異常が発生した際などに、すべてのハードウェアデバイス（ステージ・カメラ）の
    接続を強制的に切断し、リソースを解放します。

    Returns:
        dict: リセット結果のステータスとメッセージ。
    """
    logger.warning("[SYSTEM] FORCE RESET TRIGGERD")
    
    # Python では if obj: で None/空/False 相当をまとめて判定できます。
    if stage:
        stage.close()
    if camera:
        camera.disconnect()
    
    return {"status": "success", "message": "All connections forcefully reset."}

@app.get("/system/ports")
def get_system_ports():
    """
    PCに現在接続されているシリアル（COM）ポートの一覧を取得します。
    
    Returns:
        dict: 利用可能なポート名のリスト（例: ["COM1", "COM3"]）。Mock環境時はダミーを返します。
    """
    if stage.is_mock_env:
        return {
            "ports": [
                "COM1（Mock）",
                "COM3（Mock）",
                "COM4（Mock）",
            ],
        }
    
    # 実機環境ならOSからCOMポート一覧を取得
    ports = [p.device for p in list_ports.comports()]
    
    if not ports:
        return {"ports": []}
    
    return {"ports": ports}

@app.post("/system/settings")
def update_system_settings(req: SystemSettingsRequest):
    """
    システム全体（カメラ・ステージ）のデフォルト設定を一括で更新・反映します。
    フロントエンドの設定画面（SettingsView）で「Save Settings」が押された際に呼び出されます。

    Args:
        req (SystemSettingsRequest): フロントエンドの config.json の内容。

    Returns:
        dict: 更新結果のステータス。
    """
    camera.update_settings(req.settings)
    
    if "defaultSpeedMin" in req.settings:
        stage.set_speed(
            req.settings["defaultSpeedMin"],
            req.settings["defaultSpeedMax"],
            req.settings["defaultAccelTime"]
        )
    return {"status": "success"}

# ==========================================
# ステージ制御関連 API
# ==========================================

@app.post("/stage/connect")
def connect_stage(req: ConnectStageRequest):
    """
    指定されたCOMポートを使用して、回転ステージ（OptoSigma GSC-01）とのシリアル接続を確立します。
    
    【設計のポイント】
    FastAPIでは、I/O待ちが発生する通信処理を `async def` ではなく通常の `def` で定義することで、
    内部の別スレッド（スレッドプール）で実行され、他のAPIリクエストをブロック（停止）させません。
    """
    try:
        stage.connect(req.port)
        
        mode = "Mock" if stage.is_mock_env else "Real"
        
        logger.info(f"Connected to stage on {req.port} (Mode: {mode})")
        return {
            "status": "success",
            "mode": mode,
            "message": f"Connected to {req.port} (mode)"
        }
    except Exception as e:
        # HTTPException: フロントエンドに明示的なエラーを伝えるためのFastAPIの機能です。
        # 500 (Internal Server Error): サーバーやハードウェア側で予期せぬ問題が発生したことを示します。
        # 400 (Bad Request): クライアント（フロントエンド）からのリクエスト内容が間違っている場合に使います。
        # 503 (Service Unavailable): デバイスが接続されていないなど、現在サービスが提供できない状態を示します。
        
        # 接続失敗時は500エラーを返し、フロントエンド側でcatchさせる
        logger.error(f"Stage Connection Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/stage/config")
def stage_update_config(req: UpdateConfigRequest):
    """
    ステージの分解能（1度回転させるのに必要なパルス数）などの内部設定を更新します。
    このAPIは、ステージが未接続の状態でも実行可能です。
    """
    stage.update_settings(req.pulses_per_degree)
    
    return {
        "status": "success",
        "message": "Configuration updated",
    }

@app.post("/stage/home")
def stage_home():
    """
    ステージを機械的な原点（ホーム位置）に復帰させます。（H:1 コマンドの発行）
    
    Raises:
        HTTPException (400): ステージが未接続の場合。
        HTTPException (500): 機器からの応答がエラーであった場合。
    """
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")
    
    success = stage.home()
    # コマンド送信の成功可否をチェック
    if not success:
        raise HTTPException(status_code=500, detail="Homing failed")
    
    pos, _ = stage.get_status()
    
    return {
        "status": "success",
        "current_angle": pos,
    }

@app.post("/stage/move/absolute")
def stage_move_absolute(req: MoveAbsoluteRequest):
    """
    ステージを指定した絶対角度（0〜360度などの固定位置）へ移動させます。
    """
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")
    
    success = stage.move_absolute(req.angle)
    #成功可否をチェック
    if not success:
        raise HTTPException(status_code=500, detail="Absolute move failed")
    
    pos, _ = stage.get_status()
    
    return {
        "status": "success",
        "current_angle": pos,
    }

@app.post("/stage/move/relative")
def stage_move_relative(req: MoveRelativeRequest):
    """
    ステージを現在の位置から、指定した角度分だけ相対的に移動させます（プラスで正転、マイナスで逆転）。
    """
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")
    
    success = stage.move_relative(req.delta)
    #成功可否をチェック
    if not success:
        raise HTTPException(status_code=500, detail="Relative move failed")
    
    pos, _ = stage.get_status()
    
    return {
        "status": "success",
        "current_angle": pos,
    }

@app.post("/stage/stop")
def stage_stop(req: StopStageRequest):
    """
    ステージの移動を直ちに、または減速して停止させます。
    """
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")
    
    if not stage.stop(immediate=req.immediate):
        raise HTTPException(status_code=500, detail="Stop command failed")
    
    pos, _ = stage.get_status()
    
    return {
        "status": "success",
        "current_angle": pos,
    }

@app.post("/stage/config/speed")
def stage_set_speed(req: SetSpeedRequest):
    """
    ステージの駆動速度（初速、最高速度、加減速時間）を設定します。
    """
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")
    
    if not stage.set_speed(req.min_pps, req.max_pps, req.accel_time_ms):
        raise HTTPException(status_code=500, detail="Failed to set speed")
    
    return { "status": "success" }

@app.get("/stage/position")
def stage_get_position():
    """
    システム（ステージ等）の最新のステータスを取得します。
    フロントエンドから高頻度（例: 200msごと）でポーリングされることを想定しています。
    """
    if not stage.is_connected:
        return {
            "status": "disconnected",
            "current_angle": "--",
            "is_busy": False,
            "is_measuring": False
        }
    
    # 【超重要】シリアル通信を叩かず、常時監視タスクが更新しているキャッシュを即座に返す！
    return {
        "status": "success",
        "current_angle": app_state.current_angle,
        "is_busy": app_state.is_busy,
        "is_measuring": app_state.is_measuring,
    }

# ==========================================
# カメラ制御・画像保存関連 API
# ==========================================

@app.post("/camera/connect")
def connect_camera(req: CameraConnectRequest):
    """
    指定されたカメラIDでデバイスを初期化し、メモリを確保して、
    画像を超高速で取得し続けるバックグラウンドスレッド（特急レーン）を起動します。
    """
    logger.info(f"[CMD] Connect Camera ID {req.camera_id}")
    
    success = camera.connect(req.camera_id)
    if not success:
        raise HTTPException(status_code=500, detail="Camera connection failed")
        
    mode = "Mock" if camera.is_mock_env else "Real"
    return {"status": "success", "mode": mode, "message": f"Connected to Camera {req.camera_id} ({mode})"}

@app.post("/camera/disconnect")
def disconnect_camera():
    """
    カメラの接続を安全に切断し、メモリ解放とスレッドの停止を行います。
    """
    camera.disconnect()
    return {"status": "success"}

@app.post("/camera/config")
def config_camera(req: CameraConfigRequest):
    """
    カメラの露出時間（ミリ秒）とハードウェアゲイン（0-100）を設定します。
    """
    if not camera.is_connected:
        raise HTTPException(status_code=400, detail="Camera not connected")
        
    camera.set_exposure(req.exposure_ms)
    camera.set_gain(req.gain)
    return {"status": "success"}

@app.get("/system/cameras")
def get_cameras():
    """
    PCに接続されている対応カメラ（Thorlabs/uEye）の一覧を取得します。
    """
    cameras_list = camera.get_available_cameras()
    return {"cameras": cameras_list}

@app.get("/camera/video_feed")
def video_feed():
    """
    【各駅停車レーン】カメラのプレビュー映像をブラウザ向けにMJPEG形式でストリーミング配信します。
    
    FastAPIの StreamingResponse を使用し、HTTPの `multipart/x-mixed-replace` ヘッダーを
    設定することで、1つの接続を開いたまま次々と新しいJPEG画像をクライアントに送信（Push）し続けます。
    これにより、Webブラウザの `<img>` タグのsrcにこのURLを指定するだけで、動画として表示されます。
    """
    if not camera.is_connected:
        raise HTTPException(status_code=503, detail="Camera not connected")
    
    return StreamingResponse(
        camera.generate_frames(), 
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@app.post("/camera/snapshot")
def take_snapshot():
    """
    【Snapshot撮影トリガー】
    撮影ボタンが押された瞬間のフレームを取得します。
    設定により、自動保存されたファイルパスを返すか、
    ダイアログでのパス指定を待つために `{"status": "pending"}` を返します。
    """
    if not camera.is_connected:
        raise HTTPException(status_code=503, detail="Camera not connected")
        
    result = camera.take_snapshot()
    if result == "PENDING":
        return {"status": "pending", "message": "Waiting for save path"}
    elif result is not None:
        return {"status": "saved", "filepath": result}
    else:
        raise HTTPException(status_code=500, detail="Failed to take snapshot")

@app.post("/camera/snapshot/save")
def save_pending_snapshot(req: SaveSnapshotRequest):
    """
    フロントエンドの保存ダイアログでユーザーが指定したパスを受け取り、
    メモリ上に一時保持（PENDING）していたSnapshot画像を実際にディスクに書き込みます。
    """
    success = camera.save_pending_snapshot(req.filepath)
    if success:
        return {"status": "saved", "filepath": req.filepath}
    raise HTTPException(status_code=500, detail="Failed to save snapshot")

@app.post("/camera/record/start")
def start_recording():
    """
    【動画記録開始】
    マルチページTIFFへの超高速直書き（SSDへの追記）を開始します。
    設定が「8-bit TIFF」の場合は、開始と同時にハードウェアモードを切り替えます。
    """
    if not camera.is_connected:
        raise HTTPException(status_code=503, detail="Camera not connected")
        
    success = camera.start_recording()
    if success:
        return {"status": "recording", "filepath": camera.record_filepath}
    raise HTTPException(status_code=500, detail="Failed to start recording")

@app.post("/camera/record/stop")
def stop_recording():
    """
    【動画記録停止】
    TIFFファイルの書き込みを終了し、必要に応じてMP4変換処理（貨物レーン）を非同期で開始します。
    """
    filepath = camera.stop_recording()
    if filepath is not None:
        return {"status": "stopped", "filepath": filepath}
    raise HTTPException(status_code=400, detail="Not currently recording")

# ==========================================
# ログ関連 API
# ==========================================

@app.get("/system/logs")
def get_logs():
    """
    バックエンド内部のメモリバッファ（collections.deque）に蓄積された
    直近のログメッセージリストを返します。フロントエンドのログパネル表示用です。
    """
    return {"logs": list(log_buffer)}

@app.post("/system/logs")
def post_log(req: LogPostRequest):
    """
    フロントエンド側（React）で発生したエラーや操作イベントをバックエンドに送信し、
    Python側の `logger` に統合してファイル（nanopol.log）に書き出します。
    """
    msg = f"[UI] {req.message}"
    
    if req.level.upper() == "ERROR":
        logger.error(msg)
    elif req.level.upper() == "WARNING":
        logger.warning(msg)
    else:
        logger.info(msg)
    
    return {"status": "success"}

def write_backend_port_hint(app_data_dir: str | None, port: int) -> None:
    """
    Tauri連携用のポートヒントファイル (`backend_port.json`) をAppDataに保存します。

    Rustのログ受信が遅延/取りこぼしした場合でも、フロントエンドが
    AppData経由でポート番号を取得して復旧できるようにする保険経路です。
    JSONにすることで、ポート番号だけでなく更新時刻やPIDも持たせられます。

    Args:
        app_data_dir: `NANOPOL_APP_DATA_DIR` の値。None/空なら何もしません。
        port: 動的割り当てされたバックエンドの待受ポート。

    Returns:
        None
    """
    # 起動元がTauriでない場合はAppDataの保存先がないため何もしない
    if not app_data_dir:
        return

    # AppData配下にヒントファイルを作成（上書き）して最新ポートを共有する
    os.makedirs(app_data_dir, exist_ok=True)

    # 一時ファイルへ完全なJSONを書き、最後に置き換えることで途中書き込みを避ける
    hint_path = Path(app_data_dir) / "backend_port.json"
    tmp_path = hint_path.with_suffix(".json.tmp")

    hint_payload = {
        "port": port,
        "pid": os.getpid(),
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }

    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(hint_payload, f, ensure_ascii=False)

    os.replace(tmp_path, hint_path)
    logger.info(f"[SYSTEM] Wrote backend port hint to {hint_path}")

if __name__ == "__main__":
    import uvicorn
    import socket
    import os
    
    # Tauri(Rust)経由で起動されたかどうかの判定（環境変数の有無）
    is_tauri = os.getenv("NANOPOL_APP_DATA_DIR") is not None
    
    if is_tauri:
        # 1. OSに完全に空いているポートを自動で探させる
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # port=0 指定でOSに空きポート割り当てを委譲する
        sock.bind(("127.0.0.1", 0)) # ポート0を指定するとOSが空きポートを割り当てます
        port = sock.getsockname()[1] # 割り当てられたポート番号を取得
        sock.close() # 一旦ソケットを閉じて、Uvicornに席を譲ります
        # 2. 確保したポート番号を標準出力に書き出す（ここでTauri/Rustが検知する）
        # flush=True をつけることで、バッファに溜めずに即座にパイプに流し込みます。
        print(f"[PORT] {port}", flush=True)
        import sys
        # 出力先差異に備えてstderrにも同じ通知を流す
        print(f"[PORT] {port}", file=sys.stderr, flush=True)

        # 3. Rust側のログ受信取りこぼしに備え、AppDataにポートヒントを書き込む
        try:
            app_data_dir = os.getenv("NANOPOL_APP_DATA_DIR")
            # React側の保険経路が読めるよう、ポートヒントを永続化
            write_backend_port_hint(app_data_dir, port)
        except Exception as e:
            # ヒント書き込み失敗は致命ではないため起動継続する
            logger.warning(f"[SYSTEM] Failed to write backend port hint: {e}")
    else:
        # 開発中の手動起動時は、固定ポート(14201)を使用する
        port = 14201
    
    # 3. 決定したポートでFastAPIサーバーを起動
    uvicorn.run(app, host="127.0.0.1", port=port)