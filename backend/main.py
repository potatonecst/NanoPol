from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from pydantic import BaseModel
from serial.tools import list_ports
import sys
import os

from utils.logger import logger, log_buffer
from devices.stage_controller import StageController
from devices.camera_controller import CameraController

# グローバルインスタンスの作成
# アプリケーション全体で1つのコントローラーを共有します（シングルトンパターン）
stage = StageController()
camera = CameraController()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 【ライフサイクル管理】
    # サーバー起動時(startup)の処理
    logger.info("[SYSTEM] Backend Starting...")
    
    yield # ここでサーバーがリクエストを受け付け続ける（稼働状態）
    
    # サーバー終了時(shutdown)の処理
    # Ctrl+Cなどで停止した際に、開いているリソース（COMポート、カメラ）を確実に閉じます。
    logger.info("[SYSTEM] Backend Shutting Down...")
    
    # 強制的に切断処理
    logger.info("[SYSTEM] Releasing Stage Conection...")
    if stage.is_connected:
        stage.close()
    
    logger.info("[SYSTEM] Releasing Camera Conection...")
    if camera.is_connected:
        camera.disconnect()
    
    logger.info("[SYSTEM] Cleanup Complete.")

app = FastAPI(title="NanoPol Backend", version="0.1.0", lifespan=lifespan)

# CORS (Cross-Origin Resource Sharing) 設定
# フロントエンド(localhost:1420)とバックエンド(localhost:8000)のポートが違うため、
# ブラウザのセキュリティ制限を緩和して通信を許可します。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # 開発中は全て許可。本番では"http://localhost:1420"等に絞るべき
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Pydanticモデル定義 ---
# リクエストボディのデータ構造と型を定義します。
# FastAPIはこれを使って自動的にバリデーション（入力チェック）を行います。

class ConnectStageRequest(BaseModel):
    port: str

class MoveAbsoluteRequest(BaseModel):
    angle: float

class MoveRelativeRequest(BaseModel):
    delta: float

class StopStageRequest(BaseModel):
    immediate: bool = False

class SetSpeedRequest(BaseModel):
    min_pps: int = 500
    max_pps: int
    accel_time_ms: int = 200

class UpdateConfigRequest(BaseModel):
    pulses_per_degree: int

class CameraConfigRequest(BaseModel):
    exposure_ms: float
    gain: int

class CameraConnectRequest(BaseModel):
    camera_id: int = 0

class LogPostRequest(BaseModel):
    level: str
    message: str

#---システムAPI---

@app.get("/health")
def health_check():
    # フロントエンド起動時に叩く生存確認用API
    # 現在の接続状態とモード（Mock/Real）を返します。
    return {
        "status": "OK",
        "stage_connected": stage.is_connected,
        "camera_connected": camera.is_connected,
        "mode": "Mock" if stage.is_mock_env else "Real"
    }

@app.post("/system/reset")
def system_reset():
    # 強制リセット: 全てのデバイス接続を強制的に開放する
    logger.warning("[SYSTEM] FORCE RESET TRIGGERD")
    
    #ここに実機のリソース開放処理を書く
    if stage:
        stage.close()
    if camera:
        camera.disconnect()
    
    return {"status": "success", "message": "All connections forcefully reset."}

@app.get("/system/ports")
def get_system_ports():
    # Mock環境ならダミーのポートリストを返す
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

#---ステージ関連API---

# ステージ接続
# 注意: FastAPIでは `async def` ではなく `def` で定義すると、スレッドプールで実行されます。
# シリアル通信のようなブロッキングI/Oを含む処理は `def` の方が安全です。
@app.post("/stage/connect")
def connect_stage(req: ConnectStageRequest):
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
        # 接続失敗時は500エラーを返し、フロントエンド側でcatchさせる
        logger.error(f"Stage Connection Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/stage/config")
def stage_update_config(req: UpdateConfigRequest):
    # 接続されていなくても設定値（パルス換算レートなど）は更新できるようにする
    stage.update_settings(req.pulses_per_degree)
    
    return {
        "status": "success",
        "message": "Configuration updated",
    }

@app.post("/stage/home")
def stage_home():
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
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")
    
    if not stage.set_speed(req.min_pps, req.max_pps, req.accel_time_ms):
        raise HTTPException(status_code=500, detail="Failed to set speed")
    
    return { "status": "success" }

@app.get("/stage/position")
def stage_get_position():
    if not stage.is_connected:
        return {
            "status": "disconnected",
            "current_angle": "--"
        }
    
    pos, is_busy = stage.get_status()
    
    return {
        "status": "success",
        "current_angle": pos,
        "is_busy": is_busy,
    }

#---カメラ関連API---

@app.post("/camera/connect")
def connect_camera(req: CameraConnectRequest):
    #カメラ接続リクエスト
    logger.info(f"[CMD] Connect Camera ID {req.camera_id}")
    
    success = camera.connect(req.camera_id)
    if not success:
        raise HTTPException(status_code=500, detail="Camera connection failed")
        
    mode = "Mock" if camera.is_mock_env else "Real"
    return {"status": "success", "mode": mode, "message": f"Connected to Camera {req.camera_id} ({mode})"}

@app.post("/camera/disconnect")
def disconnect_camera():
    camera.disconnect()
    return {"status": "success"}

@app.post("/camera/config")
def config_camera(req: CameraConfigRequest):
    if not camera.is_connected:
        raise HTTPException(status_code=400, detail="Camera not connected")
        
    camera.set_exposure(req.exposure_ms)
    camera.set_gain(req.gain)
    return {"status": "success"}

@app.get("/system/cameras")
def get_cameras():
    cameras_list = camera.get_available_cameras()
    return {"cameras": cameras_list}

@app.get("/camera/video_feed")
def video_feed():
    # MJPEGストリーミングのエンドポイント
    # multipart/x-mixed-replace 形式で、画像を次々と送り続けます。
    if not camera.is_connected:
        raise HTTPException(status_code=503, detail="Camera not connected")
    
    return StreamingResponse(
        camera.generate_frames(), 
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@app.get("/camera/snapshot")
def get_snapshot():
    # 現在のフレームを1枚だけキャプチャしてJPEG画像として返す
    if not camera.is_connected:
        # 未接続時は404または503だが、UIがポーリングしている場合は
        # 404を返すとエラーログが出るので、黒画像などを返す実装もアリ。
        # ここではシンプルにエラー
        raise HTTPException(status_code=503, detail="Camera not connected")
        
    jpeg_bytes = camera.capture_frame()
    if jpeg_bytes is None:
        raise HTTPException(status_code=500, detail="Capture failed")
        
    return Response(content=jpeg_bytes, media_type="image/jpeg")

#---ログ関連API---

@app.get("/system/logs")
def get_logs():
    # メモリバッファにある直近のログを取得（UIポーリング用）
    return {"logs": list(log_buffer)}

@app.post("/system/logs")
def post_log(req: LogPostRequest):
    # フロントエンドからの操作ログ（ボタンクリック等）をバックエンドのloggerに統合して記録
    msg = f"[UI] {req.message}"
    
    if req.level.upper() == "ERROR":
        logger.error(msg)
    elif req.level.upper() == "WARNING":
        logger.warning(msg)
    else:
        logger.info(msg)
    
    return {"status": "success"}

if __name__ == "__main__":
    # 開発用サーバー起動（ポート8000）
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)