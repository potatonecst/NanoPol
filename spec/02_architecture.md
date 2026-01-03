# 2. アーキテクチャ (Architecture)

### 2.1 技術スタック

  * **Frontend:** React 18, TypeScript, Vite.
      * **UI Lib:** shadcn/ui, Tailwind CSS, Lucide React (Icons).
      * **State:** **Zustand** (`src/store/useAppStore.ts`) - 接続状態、デバイス設定、システムビジー状態を一元管理。
      * **Viz:** Recharts (Planned).
  * **Middleware:** Tauri v2 (Shell only).
      * 現在の通信は主に `fetch` API を用いて `localhost:8000` の FastAPI サーバーと通信する構成。
  * **Backend:** Python 3.11 + FastAPI.
      * **Server:** `uvicorn` (Dev mode).
      * **Device Control:**
          * `backend/devices/stage_controller.py`: GSC-01 制御ロジック (実装済み)。
          * `backend/devices/camera_controller.py`: DCC1645C 制御 (未実装 - Planned)。
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
  * **エラーハンドリング:**
      * FastAPIの `HTTPException` を使用。
      * 500: デバイス内部エラー (接続失敗、応答なし)。
      * 400: 不正なパラメータ (範囲外の角度など)。