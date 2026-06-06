# 02. APIサーバー・システム層 (Backend Server)

このドキュメントでは、`backend/main.py` および `backend/utils/logger.py` を中心とした、サーバーサイドの実装詳細について解説します。
本システムは **Python (FastAPI)** を採用し、非同期処理と型安全性を重視した設計となっています。

## 1. サーバーアーキテクチャ概要

### 1.1 技術スタック
*   **フレームワーク:** FastAPI
*   **サーバー:** Uvicorn (ASGI)
*   **バリデーション:** Pydantic V2
*   **CORS:** フロントエンド開発環境 (localhost) からのアクセスを許可

### 1.2 アプリケーションライフサイクル (`lifespan`)

FastAPIの `lifespan` イベントハンドラを使用し、サーバー起動時と終了時のリソース管理を厳格に行っています。
これにより、**「サーバーを停止したが、カメラやCOMポートが開いたまま」** というハードウェア制御特有の事故を防いでいます。

#### ライフサイクルフロー

```mermaid
sequenceDiagram
    participant OS
    participant API as FastAPI (Lifespan)
    participant Dev as Devices (Stage/Camera)

    OS->>API: 起動シグナル
    Note over API: startup event
    API-->>OS: 起動完了
    
    OS->>API: 終了シグナル (Ctrl+C)
    Note over API: shutdown event
    
    API->>Dev: stage.close()
    Dev-->>API: Connection Closed
    
    API->>Dev: camera.disconnect()
    Dev-->>API: Connection Closed
    
    API-->>OS: プロセス終了
```

---

## 2. APIエンドポイント設計

### 2.1 Pydanticモデルによる型安全性とバリデーション

リクエストボディは全てPydanticモデル (`BaseModel`) で定義されています。
これは単なる「型の宣言」ではなく、実行時にデータの検証と変換を行う強力な仕組みです。

```python
class MoveAbsoluteRequest(BaseModel):
    angle: float
```

**このコードがもたらす効果:**
1.  **バリデーション:** もしクライアントが `{"angle": "abc"}` を送ってきたら、Pythonのエラーが出る前にFastAPIが `422 Unprocessable Entity` エラーを返します。
2.  **型変換:** もし `{"angle": "45.0"}` (文字列) が送られてきても、自動的に `45.0` (数値) に変換してくれます。
3.  **ドキュメント化:** `/docs` (Swagger UI) に自動的に反映され、API仕様書になります。

### 2.2 グローバルインスタンス管理

`stage_controller` と `camera_controller` のインスタンスは、`main.py` のトップレベルで生成され、アプリケーション全体でシングルトンとして扱われます。

```python
# グローバルインスタンス
stage = StageController()
camera = CameraController()
```

FastAPIは各リクエストを非同期 (`async def`) ではなく、通常の関数 (`def`) として定義することで、スレッドプール内で実行させています。これにより、ブロッキングIOであるシリアル通信や画像キャプチャが他のリクエストを完全にブロックするのを防いでいます。

### 2.3 バックグラウンド監視タスクと状態キャッシュ (Background Monitor)

フロントエンドの高頻度なポーリング（0.1秒間隔）からシリアル通信（COMポート）を保護するため、バックエンド側にも専用の常時監視機構を導入しています。

*   **課題:** FastAPIの `/stage/position` エンドポイント内で毎回 `stage.get_status()` を呼んでシリアル通信を行うと、I/O待ちが発生し、通信が詰まる（ボトルネックになる）問題がありました。
*   **解決策 (キャッシュパターン):**
    1.  `main.py` の上部に `app_state = SystemState()` というメモリ上のグローバルキャッシュを用意しています。
    2.  `lifespan` 起動時に `asyncio.create_task(stage_monitor_loop())` をバックグラウンドタスクとして走らせ、0.1秒ごとにステージに状態を尋ねて `app_state` を最新化し続けます。
    3.  フロントエンドが `/stage/position` を叩いた際は、シリアルデバイスには一切アクセスせず、この `app_state` の中身を即座に（0ミリ秒で）返します。

これにより、APIのレスポンス速度が劇的に向上し、ハードウェアへの負荷も最小限に抑えられています。

### 2.4 Sweep測定のバックグラウンド実行と排他制御 (Thread Safety)

Sweep（連続回転測定）のように数十秒〜数分かかる操作は、FastAPIのAPIスレッド内で直接実行（ブロック）すると、その間フロントエンドからの他の通信（状態ポーリングなど）がすべて停止してしまいます。
これを防ぐため、本システムでは Sweep 操作を**別スレッドによるバックグラウンドタスク**に分離しています。

#### アーキテクチャの要点
1. **API 受付とバリデーション:**
   - `/stage/sweep/run` は入力値から `plan`（計画）と一意な `operation_id` のみを計算します。
   - **安全なバリデーション:** 指定された速度と角度からスイープ時間が「0.2秒未満」になる場合、ファイル作成と停止命令が競合してTIFFファイルが破損するのを防ぐため、HTTP 400 エラーとして即座に拒否します。
   - 問題なければ直ちにタスク（`_run_sweep_operation` スレッド）を起動してHTTP応答を返します。
2. **状態の一元管理と排他制御:**
   - 進行状態（phase, percent, 完了やキャンセル等）は、グローバルな辞書 `app_state.sweep_operation` に格納されます。
   - バックグラウンドタスクとAPI（`/stage/sweep/progress` やキャンセル処理）から同時にアクセスされるため、データ競合を防ぐ専用のロック機構 **`sweep_state_lock`** を導入しています。
3. **安全な更新ヘルパー:**
   - 状態を部分上書きするための `_set_sweep_state()` と、安全に読み取るための浅いコピーを返す `_get_sweep_state_snapshot()` を用い、状態破壊（Race condition）を未然に防いでいます。
4. **ハードウェアとソフトウェアの同期:**
   - `_run_sweep_operation` 内でステージに移動命令 (`move_absolute` 等) を送った直後、別タスクである `stage_monitor_loop` (100ms周期) が `is_busy=True` を検知するまで、明示的に待機します。これにより、「移動が開始される前に完了判定ループをすり抜けてしまう」というレースコンディションを防ぎ、遅延ゼロの正確な録画トリガーを実現しています。


### 2.5 サーバー起動スクリプト (`if __name__ == "__main__"`)

`main.py` の末尾にある起動スクリプトは、Uvicornサーバーを起動するだけでなく、本番環境と開発環境を両立させるための重要な役割を担っています。

*   **役割:** Tauri経由での起動か、手動での起動かを環境変数で判定し、使用するポートを動的に切り替えます。
*   **ヒント出力:** Tauri経由で起動した場合は、確定したポートを AppData の `backend_port.json` に書き出します。
*   **信頼性:** ヒントファイルは一時ファイルに書いた後で原子的に置き換えられるため、途中書き込みの壊れた JSON を読みにくくしています。
*   **詳細:** この動的なポート割り当てとプロセス間連携の詳しい仕組みについては、 **05. プロセス間連携と動的ポート割り当て** を参照してください。

### 2.5.1 開発時の起動例（`uv` を使う）

ローカル開発では `uv run` を用いることで、パッケージ環境を意識せずに実行できます。特に `--reload` を付けるとソース変更を検知して自動再起動されるため、開発効率が上がります。例:

```sh
# 構文チェック
PYTHONPATH=.. uv run python -m py_compile main.py

# インポートテスト
PYTHONPATH=.. uv run python - <<'PY'
from backend.main import camera
print(camera.has_uc480, camera.is_mock_env)
PY
```

### 2.6 ステージ明示的切断エンドポイント (`/stage/disconnect`)

USB抜きやユーザーの「Disconnect」ボタン押下時に、ステージ側での接続状態を明示的に落とすためのエンドポイント。

```http
POST /stage/disconnect
Content-Type: application/json

# 応答例
{"success": true}
```

*   **実装動作:**
    1.  `stage_controller.disconnect()` を呼び出し、シリアルポートを閉じます。
    2.  `stage.is_connected` フラグを `False` に設定します。
*   **重要性:** UI層では「ボタンを押した」というアクション自体は処理できますが、**実際のハードウェア接続を落とす**ことはバックエンド層でのみ可能です。このエンドポイントがないと、UIの状態とバックエンドの実際の状態がズレたままになります。
*   **失敗時:** ハードウェアが既に応答しない場合でも、ポート切断とフラグ落下は必ず完了するよう実装されています。
*   **後続処理:** 切断後、フロントエンドのポーリングループは次の `/health` 問い合わせで `stage_connected: false` を受け取り、自動的にUI状態を同期します。

### 2.7 起動時ログと接続判定の注意点

`system.log` に以下のようなログが出ている場合、Python/FastAPI自体は起動しています。

```text
[SYSTEM] Backend Starting...
[SYSTEM] Stage monitor loop started.
```

この状態でフロントエンドが `Backend Offline` のままの場合、原因はバックエンドクラッシュではなく、動的ポート受け渡し（Python -> Rust -> React）の遅延/未反映である可能性が高いです。

確認ポイント:

1. Pythonが `[PORT] <number>` を通知しているか（stdout/stderr）。
2. Rust sidecar がその通知を受信して共有メモリに格納できているか。
3. React が `get_backend_port` 取得後に `setApiBase` してから `/health` を開始しているか。

※ 実装上、開発環境では `invoke` 失敗時に固定ポートへ即フォールバックしますが、本番環境では即フォールバックせず再試行を継続します。
※ ヒント経由でポートを採用する場合も、フロントエンド側で `/health` probe を通過したものだけを使います。

### 2.7.1 終了時ログの読み方

backend の終了確認では、次のログを順に確認する。

```text
[SYSTEM] Backend Shutting Down...
[SYSTEM] Stage monitor task cancellation requested.
[SYSTEM] Stage monitor task cancelled cleanly.
[SYSTEM] Releasing Stage Conection...
[SYSTEM] Releasing Camera Conection...
[SYSTEM] Cleanup Complete.
```

この並びが出ていれば、Python 側の shutdown 処理は正常に進んでいる。`Cleanup Complete` が出るのにプロセスが残る場合は、Python 内ではなく Tauri 側の kill 経路か、別プロセスの残留を疑う。

### 2.7.2 録画ログの読み方

録画開始時は `record start requested` → `Recording save requested` → `Recording target path` → `Recording started` の順で出る。
停止時は `Recording stopped` が出る。

`Error writing frame to TIFF/CSV` が停止直後に1回だけ出ても、実ファイルが `videos/` に保存されていれば、停止と書き込みの競合であり、保存失敗とは限らない。

### 2.7.3 `/system/shutdown` エンドポイント

バックエンドは `POST /system/shutdown` を実装しています。これは Tauri 側がウィンドウ閉じる際に送信し、Python 側で以下を実行します:

- ログ出力: `[SYSTEM] Shutdown requested by Tauri sidecar.`
- `stage.close()`（接続中のみ）
- `camera.disconnect()`（接続中のみ）
- ロガーハンドラの `flush()` を試みる

このエンドポイントにより、Tauri は子プロセスを `kill()` する前に Python 側へ優雅な終了処理を依頼できます。運用時は `system.log` の末尾に上記メッセージが出ているかを必ず確認してください。

### 2.8 診断エンドポイント (`/stage/diagnostics`, `/camera/diagnostics`)

実機環境での「接続候補が見えない」「Mockに落ちる」問題を短時間で切り分けるため、診断専用APIを追加しています。

#### `GET /stage/diagnostics`

主な返却項目:

*   `stage_connected`, `stage_mode`, `serial_is_open`
*   `has_pyserial`, `pyserial_import_error`
*   `last_error`, `last_connected_port`, `last_baudrate`
*   `available_ports`（現在OSが列挙しているCOMポート一覧）
*   `python_executable`, `is_frozen`

用途:

*   ステージ未接続時に「そもそもCOMポートが見えていない」のか
*   「ポートは見えるが接続失敗」なのか
*   「pyserial import失敗でMock動作」なのか

を即座に判定できます。

#### `GET /camera/diagnostics`

主な返却項目:

*   `camera_connected`, `camera_mode`
*   `has_uc480`, `uc480_import_error`, `bayer_pattern`
*   `windows_dll_candidates`（uc480 DLL 候補パスの存在確認）
*   `python_executable`, `is_frozen`

用途:

*   `uc480` パッケージ不在とドライバ解決失敗の分離
*   配布ビルド（`is_frozen=true`）で実行中の実体確認
*   共用PCで環境を壊さずに「どこが足りないか」を可視化

> 注意: `windows_dll_candidates` は**診断表示用の候補一覧**であり、`uc480` の内部探索経路そのものではありません。

### 2.9 自動測定セッション管理 API (Auto Measurement Sessions)

自動測定（Auto Mode）の進行管理を行うための API です。`backend/utils/data_saver.py` と連携し、ファイルシステム上のディレクトリ構造を管理します。

#### エンドポイント一覧

| メソッド | パス | 役割 | 備考 |
| :--- | :--- | :--- | :--- |
| `GET` | `/measurement/sessions` | 測定セッション一覧取得 | `date_dir` 引数で過去日の参照が可能（省略時は今日）。 |
| `POST` | `/measurement/session` | 新規セッション作成 | フォルダと `settings.json` を生成します |
| `GET` | `/measurement/session/settings` | セッション設定の読込 | 指定フォルダの進捗状況を返します |

#### 設計のポイント
*   **日付指定のスキャン**: `/measurement/sessions?date_dir=YYYYMMDD` をリクエストすることで、過去の実験履歴をフロントエンドからブラウズできます。応答には現在表示中の日付フォルダのフルパス (`selected_dir`) も含まれます。
*   **保存先の参照**: これらの API は、設定画面で保存された `outputDirectory` を `camera.settings` から取得して動作します。
*   **自動採番**: `POST /measurement/session` で名前を空にすると、`Sample_1`, `Sample_2` といった連番が自動的に割り振られます。
*   **不備の検出**: 保存先が設定されていない状態でセッションを作成しようとすると、HTTP 400 エラーを返し、フロントエンドに設定を促します。

---

## 3. ロギングシステム (Logging)

`utils/logger.py` では、Python標準の `logging` モジュールを拡張し、**「ファイル保存」** と **「UI表示」** の両立を実現しています。

### 3.1 ログデータの流れ

以下の図は、システム内でログがどのように発生し、どこへ流れていくかを示しています。

```mermaid
graph LR
    App["FastAPI App / Backend"] --Log出力--> Logger
    
    Logger --保存--> File["ログファイル (OS標準AppData内)"]
    Logger --追加--> Mem["メモリバッファ (deque)"]
    Logger --表示--> Console["コンソール画面"]
    
    subgraph Frontend Interaction
        UI["Frontend UI"] --"Polling (GET /system/logs)"--> API["API Endpoint"]
        API --Read--> Mem
    end
```

### 3.2 ログハンドラの役割

1.  **StreamHandler (Console):**
    *   開発者がターミナルで確認するためのログです。
2.  **TimedRotatingFileHandler (File):**
    *   OS標準の安全なアプリケーションデータフォルダ（Windowsなら `%APPDATA%\nanopol\logs\system.log`、Macなら `~/.nanopol/logs/system.log` 等）に保存されます。
    *   **【高度な連携】** ビルド後の権限エラーを防ぐため、この保存先パスはアプリ起動時に Tauri (Rust) が自動取得し、環境変数 `NANOPOL_APP_DATA_DIR` を通じて Python に渡される設計になっています。
    *   `when="midnight"` 設定により、毎日深夜0時に新しいファイルに切り替わり、古いログはバックアップされます（ローテーション）。これによりログファイルが無限に肥大化するのを防ぎます。
3.  **ListHandler (Memory Buffer):**
    *   **カスタム実装クラス**です。
    *   `collections.deque(maxlen=200)` を使用したリングバッファ構造を持っています。
    *   新しいログが入ってくると、古いログ（201件目）は自動的に捨てられます。これにより、メモリ使用量を一定に保ちながら、最新のログをUIに提供できます。

---

## 4. 開発者向けガイド: FastAPIの仕組み

このセクションでは、初めてWeb APIサーバーを開発する方向けに、`backend/main.py` で使われている重要な概念を解説します。

### デコレータ (`@app.get`, `@app.post`)
関数定義の直前にある `@app.get(...)` のような記述を「デコレータ」と呼びます。
Pythonの文法機能で、直下の関数に対して「特別な機能」を付け加えるものです。
ここでは、FastAPIに対して「このURLにリクエストが来たら、この関数を実行するように登録してくれ」と指示を出しています。

*   `@app.get("/items")`: データを**取得**するときに使います。
*   `@app.post("/items")`: データを**送信・作成**するときに使います。

### Lifespan (ライフスパン) と `yield`
サーバーが「起動してから終了するまで」の一生を管理する仕組みです。
`backend/main.py` では `lifespan` という関数が定義されており、`yield` というキーワードで処理が分かれています。

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 【起動時の処理】
    # データベースへの接続や、初期データの読み込みをここで行います。
    print("サーバー起動！")
    
    yield # ここでサーバーが待機状態になり、リクエストを受け付け続けます。
    
    # 【終了時の処理】
    # Ctrl+Cなどで停止命令が来ると、ここから再開されます。
    # 開きっぱなしのファイルや通信ポートをここで閉じます。
    print("サーバー終了。お疲れ様でした。")
```

この仕組みがないと、サーバーを強制終了したときに、カメラが「使用中」のままロックされてしまい、PCを再起動しないと治らない…といったトラブルが起きます。
本プロジェクトでは、ここで確実に `camera.disconnect()` を呼ぶことで安全性を担保しています。

## テスト対象のAPI

バックエンドの API は、デバイス層の単体テストに加えて HTTP レベルでも確認しています。

- `backend/tests/api/test_camera_connect_http.py`: `/camera/connect` の応答に `exposure_range` と `gain_range` が含まれることを確認します。
- `backend/tests/api/test_camera_config_and_disconnect_http.py`: `/camera/config` の前提条件と、`/camera/disconnect` の idempotency を確認します。
- `backend/tests/api/test_auto_measurement_session_http.py`: 自動測定セッションの作成・一覧取得・設定読込のフローを確認します。
- `backend/tests/test_logger_filter.py`: `/system/logs` の成功アクセスがノイズになりにくいことを確認します。

また、録画停止まわりは `backend/tests/devices/test_disconnect_during_recording.py` で競合を再現して確認しています。

```sh
# 開発サーバー起動（自動再読み込み）
PYTHONPATH=.. uv run python -m uvicorn main:app --reload --host 127.0.0.1 --port 14201
```

注意事項:
- `--reload` は開発専用です。本番や Tauri 経由の起動では使用しないでください。
- `uv run` はプロジェクトルートからの相対パス指定をシンプルにするために便利です。CI や配布環境では直接 `uvicorn` や PyInstaller での実行を検討してください。
