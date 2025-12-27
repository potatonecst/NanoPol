# 2. アーキテクチャ (Architecture)

### 2.1 技術スタック

  * **Frontend:** React 18, TypeScript, Vite.
      * **UI Lib:** shadcn/ui, Tailwind CSS.
      * **State:** **Zustand** (設定・ROI・進捗をタブ間で永続保持).
      * **Viz:** Recharts (Multi-ROI対応).
  * **Middleware:** Tauri v2.
  * **Backend:** Python 3.11 + FastAPI.
      * **Img Proc:** OpenCV (`cv2`), NumPy, `tifffile`.
      * **Device:** `pyserial`, `pyueye`.
      * **Logging:**
      * **Backend:** `backend/utils/logger.py` の `logger` インスタンスを使用。標準出力(`sys.stdout`)、ファイル(`logs/system.log`)、およびメモリ内バッファ(`log_buffer`)の3箇所に出力される。
      * **Frontend Integration:** Frontendは1秒ごとに `GET /system/logs` をポーリングし、メモリ内バッファに蓄積された直近200件のログを取得・表示する。
      * **Unified Logging:** Frontend側の操作ログも `POST /system/logs` 経由でBackendに送信され、一元管理される。
      * **Implementation Note:** Backend開発時は `print()` ではなく必ず `logger.info()` 等を使用すること。`print()` はバッファに捕捉されない。

### 2.2 座標系と精度 (Coordinate System)

  * **基準:** **左上基準 (Top-Left Origin)** `(0, 0)`.
      * 画像処理 (OpenCV) および UI描画 (Canvas/SVG) の標準に準拠。
  * **ROI定義:** `(x, y, w, h)`。`x, y` は左上の整数座標。
  * **計算ロジック:**
      * 重心計算: **Float (浮動小数点)** で保持。サブピクセル精度を確保。
      * ROI移動: 移動量（差分）を **四捨五入して整数 (Int)** に丸めて適用。
  * **表示補正:** 画面上の十字マーク等は、ピクセル中心 `(x+0.5, y+0.5)` に描画する。

### 2.3 デバイス制御の実装詳細 (Device Control Details)

  * **通信プロトコル:**
      * **Timeout:** 1.0秒 (Hardcoded).
      * **Flow Control:** `rtscts=True` (ハードウェアフロー制御有効). ※Spec v1.1で変更
  * **エラーハンドリング:**
      * 専用のエラーコードは使用せず、例外をキャッチしてHTTP 500/400としてFrontendに通知。
