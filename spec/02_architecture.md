# 2. アーキテクチャ (Architecture)

### 2.1 技術スタック

  * **Frontend:** React 18, TypeScript, Vite.
      * **UI Lib:** shadcn/ui, Tailwind CSS, Lucide React (Icons).
      * **State:** **Zustand** (`src/store/useAppStore.ts`) - 接続状態、デバイス設定、システムビジー状態を一元管理。
          * **パフォーマンス最適化設計:**
              * **書き込み:** タイマーや通信のコールバック等、Reactの描画外での更新にはフックを介さず `useAppStore.setState()` を直接使用する。
              * **読み取り:** 複数値を監視する場合は `useShallow` を用いて、高頻度で更新される値（`currentAngle`等）による無駄な再レンダリングを防ぐフィルターとする。
              * **一時参照:** 非同期関数等でその瞬間の状態を知る場合は、描画をトリガーしない `useAppStore.getState()` を用いる。
      * **Viz:** Recharts (Planned).
  * **Middleware:** Tauri v2.
      * **Communication:** `fetch` API を用いて `localhost:8000` の FastAPI サーバー (Device Control) と通信。
      * **Native Capabilities:** `tauri-plugin-fs` (設定保存・フォルダ作成), `tauri-plugin-dialog` (フォルダ選択) を使用。
  * **Backend:** Python 3.11 + FastAPI.
      * **Server:** `uvicorn` (Dev mode).
      * **Device Control:**
          * `backend/devices/stage_controller.py`: GSC-01 制御ロジック (実装済み)。
          * `backend/devices/camera_controller.py`: DCC1645C 制御 (未実装 - Planned)。
              * **責務の分離:**
                  * `get_raw_image()`: メモリから生データ (Numpy array) を取得。保存・解析用。
                  * `capture_jpeg()`: 生データを JPEG に変換して返す。UI プレビュー用。
              * **並行処理対策:** `threading.Lock` を導入し、複数リクエスト時の競合を防止。
              * **配信方式:** ライブビュー用エンドポイント (`/camera/video_feed`) は MJPEG ストリーミングを採用し、ポーリング負荷を軽減。
      * **Logging:** `backend/utils/logger.py` による一元管理。

### 2.2 ログ・ステータス管理 (Logging & Status)

FrontendとBackendで状態を同期し、ユーザーに透明性を提供する設計。

  * **Backend Logger:**
      * `backend/utils/logger.py` の `logger` シングルトンを使用。
      * 出力先: 標準出力, ファイル (`logs/system.log`), メモリ内バッファ (`RingBuffer`).
  * **Frontend Integration:**
      * **Polling:** Frontendは定期的に `GET /system/logs` を叩き、直近のログを取得して `LogPanel` に表示。
      * **Action Logging:** ユーザー操作（ボタンクリック等）も `POST /system/logs` 経由でBackendに送信し、記録を一元化する。
  * **Operation Feedback:**
      * ステージ移動などの長時間操作は、開始時 (`Moving...`) と完了時 (`Moved`, `Stopped`) にログを出力。
      * エラー発生時は `toast` 通知と共に、詳細ログをBackendに記録。
      * **LogPanel Behavior:**
          * **Smart Auto-Scroll:** ログ更新時、ユーザーが**最下部（最新）を表示している場合のみ**自動スクロールする。過去ログ閲覧中（スクロールアップ時）は勝手に動かさない。
          * **Scroll Button:** 過去ログ閲覧中は「最新へ戻る（↓）」ボタンを表示し、ワンクリックで最下部へ移動可能にする。
          * **State Reset:** パネルを閉じる（Collapsing）際は、最大化状態をリセットし、次回は通常サイズで開く。

### 2.3 座標系と精度 (Coordinate System)

  * **基準:** **左上基準 (Top-Left Origin)** `(0, 0)`.
  * **計算ロジック (Planned):**
      * 重心計算: **Float** 保持。
      * ROI移動: **Int** 丸め。
  * **ステージ座標:**
      * 単位: **Degree (度)**。
      * 内部計算: パルス (`int`) ⇔ 角度 (`float`) の変換を `StageController` 内で隠蔽。
      * デフォルト設定: **400 pulses/degree** (Half step mode default).

### 2.4 デバイス制御の実装詳細 (Device Control Details)

  * **通信プロトコル (Stage):**
      * **Timeout:** 1.0秒 (Hardcoded in `stage_controller.py`).
      * **Flow Control:** `rtscts=True`.
      * **Mock Mode:** 
          * **Non-Windows:** 自動的にMockモードとして動作。
          * **Windows:** 実機接続を試行。接続に失敗した場合は **Mockにフォールバックせず、エラー (500 Internal Server Error)** を返す。
  * **Mock Camera Behavior (MJPEG):**
      * **統一されたインターフェース:** Mockモード時も、本番環境と全く同じMJPEGストリーミングエンドポイント (`/camera/stream`) を提供する。
      * **フロントエンドのメリット:** フロントエンドは環境（本番/Mock）を意識せず、常に `<img src="/camera/stream" />` タグで映像を表示できる。静止画ポーリングやCanvas描画への切り替えロジックを排除し、コードを簡素化する。
      * **生成映像:**
          * バックエンドは擬似的なフレームを連続生成し、`multipart/x-mixed-replace` で配信する。
          * **内容:** テストパターン（カラーバー、グリッド等）またはランダムノイズ画像。
          * **情報:** 現在のタイムスタンプや "MOCK MODE" というテキストを画像内に描画し、動作中であることを視覚的に分かりやすくする。
          * **フレームレート:** 本番環境に近いレート（例: 10-15 fps）をエミュレートする。
  * **エラーハンドリング:**
      * FastAPIの `HTTPException` を使用。
      * 500: デバイス内部エラー (接続失敗、応答なし)。
      * 400: 不正なパラメータ (範囲外の角度など)。

### 2.5 死活監視（ハートビート）と自己修復
システムはバックエンドとフロントエンドの寿命の違いを吸収するため、以下の監視機構を備える。
  * **ポーリング:** フロントエンドは起動時から 3秒間隔 で `/health` API を叩き続ける。
  * **エラー検知:** 通信エラー時は Zustand の `isBackendConnected` を即座に `false` とし、UIを Offline に切り替える。
  * **自己修復 (Self-Healing):** バックエンドのプロセスが再起動・復帰した際、自動的に最新のデバイス接続状態（ステージ・カメラの接続有無）を再取得し、ユーザーの操作なしで Zustand ストアと UI を完全な Ready 状態へ復元する。

### 2.6 デバイス監視アーキテクチャ（ポーリング）
  * **Stage Polling (`useStagePolling.ts`):** 
      * `isStageConnected` が `true` の間、0.1秒(100ms)間隔で `/stage/position` をポーリングする。
      * 物理ステージの `currentAngle` と `isStageBusy`, `isMeasuring` のステータスを Zustand ストアに直接（`setState`で）反映し続ける。
      * パフォーマンスを考慮し、ReactのUI描画サイクルからは完全に独立した処理として実装し、無駄な再レンダリングを引き起こさない設計としている。