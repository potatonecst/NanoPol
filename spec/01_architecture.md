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

### 2.2 座標系と精度 (Coordinate System)

  * **基準:** **左上基準 (Top-Left Origin)** `(0, 0)`.
      * 画像処理 (OpenCV) および UI描画 (Canvas/SVG) の標準に準拠。
  * **ROI定義:** `(x, y, w, h)`。`x, y` は左上の整数座標。
  * **計算ロジック:**
      * 重心計算: **Float (浮動小数点)** で保持。サブピクセル精度を確保。
      * ROI移動: 移動量（差分）を **四捨五入して整数 (Int)** に丸めて適用。
  * **表示補正:** 画面上の十字マーク等は、ピクセル中心 `(x+0.5, y+0.5)` に描画する。
