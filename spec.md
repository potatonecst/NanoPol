Written by Gemini

### 完全版 システム詳細仕様書 (v9.0)

-----

# 偏光測定システム (NanoPol Controller) 詳細仕様書

**Version:** 9.0 (Final Architecture)
**Date:** 2025/12/07
**Hardware:** OptoSigma GSC-01 (Stage), Thorlabs DCC1645C (Camera)

-----

## 1\. システム概要 (Overview)

### 1.1 目的

対物レンズ下のナノ粒子（\~150nm）からの散乱光強度を、1/4波長板の回転角度ごとに精密測定する。
長時間・多点測定に対応し、実験の\*\*「完全なトレーサビリティ（再現性・検証性）」\*\*を確保するデータ管理機能を有する。

### 1.2 ハードウェア制御仕様

  * **回転ステージ (GSC-01):**
      * 通信: RS-232C (9600bps, Data 8, Stop 1, Parity None).
      * フロー制御: **None (RTS/CTS=False)** を推奨。
      * コマンド: `M:` (相対移動), `G:` (駆動), `Q:` (状態確認), `H:` (原点復帰).
  * **カメラ (DCC1645C):**
      * ドライバ: IDS uEye (`uc480`).
      * ライブラリ: `pyueye` (Python).
      * センサー: 1280x1024 CMOS, 10-bit ADC.
      * データ取得: **16-bit コンテナ** (`uint16`) として取得・保存。

-----

## 2\. アーキテクチャ (Architecture)

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

-----

## 3\. 画面遷移とUI仕様 (UI Flow & Layout)

### 3.1 アプリ起動時の挙動

  * **初期画面:** **🔌 Devices Mode** を表示。
      * まず機器接続を行わせるため。
  * **保存先設定:** 初回起動時にデフォルト保存先（例: `D:\Data`）がない場合、設定を促す。

### 3.2 メイン画面レイアウト (Main Layout)

画面左端のアイコンバーでモードを切り替える。

```text
[ Global Header (Fixed 50px) ] --------------------------------------------------+
| 📊 NanoPol Controller  Status: Ready              [?]Help  [🌙]Theme  [📷 Snap] |
+---+----------------------------+-----------------------------------------------+
| N | [ SIDEBAR PANEL ]          | [ MAIN VIEW AREA (Resizable) ]                |
| a | (モードにより変化)          |                                               |
| v |                            | +-------------------------------------------+ |
|   |                            | | [1] Camera Live View                    | |
| B |                            | |                                           | |
| a |                            | |      [ROI 1]       [ROI 2]              | |
| r |                            | |         □             □                 | |
|   |                            | |                                           | |
| 🔌|                            | |           (Overlay Controls)              | |
|   |                            | |          [ ⚙️ Exposure / Gain ]           | |
| 🛠️|                            | +-------------------------------------------+ |
|   |                            |  ( || Drag to resize )                        |
| 📉|                            | +-------------------------------------------+ |
|   |                            | | [2] Realtime Graph                        | |
| ⚙️|                            | |                                           | |
|   |                            | | Intensity (Auto Scale)                    | |
|   |                            | | ^                                         | |
|   |                            | | |__________> Angle                        | |
|   |                            | +-------------------------------------------+ |
+---+----------------------------+-----------------------------------------------+
| [Status Bar] 🟢 [INFO] Ready. (Click to expand logs)                           |
+--------------------------------------------------------------------------------+
```

-----

### 3.3 各モードの詳細仕様

#### ① 🔌 Devices Mode (接続管理)

  * **Stage Panel:**
      * Port Select (COMx), Baudrate (9600).
      * `[Connect]` / `[Disconnect]`.
      * Status Indicator (Connected/Error).
  * **Camera Panel:**
      * ID Select.
      * `[Connect]` / `[Disconnect]`.
  * **Troubleshoot:**
      * `[Force Reset Ports]`: 強制的にシリアルポートとカメラハンドルを開放する緊急ボタン。

#### ② 🛠️ Manual Mode (調整)

  * **Stage Control:**
      * `Current Angle`: 特大フォント表示。
      * `Jog`: `[<<<]`, `[<]`, `[>]`, `[>>>]` ボタン。
      * `Absolute`: 入力欄 + `[GO]`, `[HOME]`.
  * **Camera View:**
      * Autoモードと共通のコンポーネントを使用（ROI表示あり）。

#### ③ 📉 Auto Mode (自動測定)

サイドバーの状態遷移でフローを管理する。

**【State 0: セッション開始 (Session Entry)】**
Autoモードに入った最初の状態。サイドバーに表示。

  * **Base Folder:** `D:\Data` (設定から自動反映)
  * **Date Folder:** `20251207` (自動生成)
  * **[ 📄 新規測定 (New) ]**
      * `Sample Name`: `Sample_1` (自動採番で重複回避。編集可)。
      * `[Create & Start]` ボタン。
  * **[ 📂 つづきから (Load) ]**
      * 既存のサンプルフォルダを選択。
      * `settings.json` を読み込み、**State A** へ遷移。

**【State A: 測定選択 (Selection)】**

  * **履歴リスト (History):** 過去の測定（ID, ステータス）を表示。
  * **次アクション選択:**
      * `[ 1. Left / Front ]`
      * `[ 2. Right / Front ]`
      * `[ 3. Left / Back ]`
      * `[ 4. Right / Back ]`
      * `[ 5. Custom ]`
      * `[ Finish Experiment ]` (State 0に戻る)
  * **遷移:** ボタン選択 → **State B** へ。

**【State B: 準備・実行 (Setup & Run)】**

  * **Header:** `Target: 1. Left / Front` (クリックでState Aに戻る)。
  * **Instruction:** 「レーザーを左、サンプルを手前にセット」。
  * **Input (Mandatory):**
      * `Laser Power`: `[ ] mW` (空欄・必須)。
      * `Fiber Pos`: `X:[ ] Y:[ ]` (前回値保持・必須)。
  * **Action Buttons:**
      * `[<] [>]`: **Mini Jog** (微調整用)。
      * `[📷 Test Shot]`: 1枚撮影・ROI解析値表示。
      * `[🔍 Pre-Scan]`: **必須**。ROIオートセンタリング。
      * `[▶ START MEASUREMENT]`: 本番開始。
  * **Progress:**
      * 実行中: `Angle / 360`, プログレスバー。
      * `[🛑 ABORT / PAUSE]`: 緊急停止。

#### ④ ⚙️ Settings Mode (設定)

  * **Path Settings:**
      * `Default Base Folder`: 測定データ保存のルートパス (例: `D:\Data`)。
  * **Device Settings:** パルス/度 換算値 (Default: 5000), タイムアウト設定。

-----

## 4\. 機能ロジック詳細 (Logic Specification)

### 4.1 ROI 管理・操作

  * **作成:** `Ctrl + Click`。初期サイズ **33x33 px** (奇数)。
  * **編集:**
      * **移動:** 内部ドラッグ。
      * **リサイズ:** ハンドルドラッグで **中心固定・対称拡大縮小**。
  * **表示:** ROI ID番号、枠、中心十字を表示。
  * **右クリックメニュー:** 「数値入力」「削除」。
  * **Zoom/Pan:** カメラビュー上でホイール拡大、背景ドラッグ移動。

### 4.2 オートセンタリング (反復重心法)

`[🔍 Pre-Scan]` 時に実行。

1.  **探索:** 現在のROI中心から `Size * 2` の範囲を切り出し。
2.  **閾値:** `Threshold = MaxPixel * 0.2` (背景ノイズ除去)。
3.  **計算:** 輝度重心 $(X_c, Y_c)$ を算出。
4.  **移動:** 現在の中心との差分を **四捨五入(Int)** し、ROIを移動。
5.  **反復:** ズレがなくなるまで、または最大5回繰り返す。
6.  **複数対応:** 全てのROIに対して個別に実行。

### 4.3 測定フロー (Step & Shoot)

1.  **検証:** `Laser Power`, `Fiber Pos` 入力済みか？ プレスキャン済みか？ (未実施ならアラート)。
2.  **ループ (0°〜360°):**
      * **移動:** GSC-01 (`M:`/`G:`) → 停止確認 (`Q:` polling) → **整定 0.5秒**。
      * **撮影:** `pyueye` 画像取得 (16-bit)。
      * **保存:** 生データを **16-bit TIFF** で保存。
      * **解析:** 全ROIの `Sum`, `Max` を計算。
      * **更新:** グラフプロット、プログレスバー更新。
3.  **飽和監視:**
      * `Max >= SaturationLimit` (10bit: 1023 or 16bit: 65535) の場合、**一時停止ダイアログ** を表示。
      * 選択肢: `[中断して保存]` `[無視して続行]` `[設定を変えてやり直し]`。
4.  **終了処理:**
      * `settings.json` ステータス更新。
      * **グラフ保存:** 最終グラフを画像として保存。
      * **再解析 (Refine):** 全画像から真の重心を再計算し、CSVを更新。

-----

## 5\. データ保存仕様 (Data Management)

### 5.1 ディレクトリ階層

階層構造: `[Base] / [YYYYMMDD] / [SampleName] / ...`

```text
📂 D:\Data \
 └─📂 20251207 \                       # 日付フォルダ
      └─📂 Sample_1 \                  # サンプル名フォルダ
           │
           ├── 📄 settings.json        # ★全測定履歴マスター
           │
           ├── 📂 images /             # 本番画像ルート
           │    ├── 1_Left_Front_001 / # 1回目の試行 (IDと連動)
           │    │    ├── 000.0deg.tif
           │    │    └── 📂 analysis /
           │    │         ├── heatmap_ref.tif
           │    │         └── graph_ref.png
           │    └── ...
           │
           ├── 📂 prescan_raw /        # プレスキャン画像ルート
           │    ├── 1_Left_Front_001 / ...
           │    └── ...
           │
           ├── 📄 1_Left_Front_001.csv # ★正データ (Refined)
           ├── 📄 1_Left_Front_001_mon.csv
           └── ...
```

### 5.2 自動採番ロジック

新規作成時、`D:\Data\20251207` 内をスキャン。

  * `Sample_1` が存在 → `Sample_2` を初期値に設定。
  * `Sample_2` も存在 → `Sample_3` ...
  * これにより、ユーザーが意図せず上書きすることを防ぐ。

### 5.3 settings.json (Master Record)

時系列リスト形式。ROIの変遷（初期→モニター→リファイン）を全て記録。

```json
{
  "app_version": "1.0.0",
  "sample_name": "Sample_1",
  "measurements": [
    {
      "id": "1_Left_Front_001",           // フォルダ名・CSV名と一致
      "step_category": "1_Left_Front",
      "timestamp_start": "14:30:00",
      "timestamp_end": "14:32:15",
      "status": "completed",              // or "aborted"
      "laser_power_mw": 10.5,
      "fiber_pos": { "x": 100, "y": 200 },
      "rois": [
        {
          "id": 1,
          "initial": { "x": 500, "y": 400, "w": 33, "h": 33 }, // 手動
          "monitor": { "x": 505, "y": 402, "w": 33, "h": 33 }, // プレスキャン後
          "refined": { "x": 504, "y": 401, "w": 33, "h": 33 }  // 測定後再計算
        }
      ]
    }
  ]
}
```

### 5.4 CSV形式

ワイド形式。
`Angle, Timestamp, ROI1_Max, ROI1_Sum, ROI2_Max, ROI2_Sum, ImagePath`

-----

## 6\. ユースケース (Use Cases)

### Case 1: 新規サンプルの測定開始

1.  **Devices:** 機器接続完了。
2.  **Auto Mode:** サイドバーに「新規/つづき」が表示される。
3.  **New:** `Sample Name` に `Sample_1` が自動入力されているのを確認し、`Create`。
4.  **State A:** サイドバーが「測定選択」に切り替わる。`[1. Left / Front]` を選択。
5.  **State B:** 準備画面へ。レーザーパワー入力、プレスキャン、開始。

### Case 2: アプリ再起動後の復旧

1.  **Auto Mode:** `Load` を選択し、`D:\Data\20251207\Sample_1` フォルダを選ぶ。
2.  **Restore:** `settings.json` が読み込まれ、**State A (測定選択)** に復帰。
      * 履歴リストには、落ちる前に完了していた `1_Left_Front_001` が表示されている。
3.  **Resume:** 次のステップから測定を続行できる。

-----

この仕様書（v9.0）に基づき、開発を開始します。