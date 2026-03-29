# 5. データ保存仕様 (Data Management)

> **Note:** 本ドキュメントに記載されているデータ構造および保存ロジックは、現時点では **未実装 (Planned)** です。

### 5.1 ディレクトリ階層

階層構造: `[Base] / [YYYYMMDD] / [SampleName] / ...`

  * **[Base]:** Settingsモードで設定されたルートパス。
      * **Default:** `~/Documents/NanoPol` (ユーザーのドキュメントフォルダ内)。
      * **Config:** `AppConfig/config.json` に保存された `outputDirectory` の値を使用。
  * **[YYYYMMDD]:** 測定実行日の日付で自動生成。

```text
📂 D:\Data \
     └─📂 20251207 \
          └─📂 Sample_1 \
               │
               ├── 📄 settings.json        # ★全測定履歴マスター
               │
               ├── 📂 images /             # 本番画像ルート
               │    ├── 1_Left_Front_001 / # 1回目の試行 (IDと連動)
               │    │    ├── 000.0deg.tif  # ★重要: Rawデータから生成された可逆圧縮画像 (TIFF/PNG)
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

### 5.4 フロントエンド状態管理 (Runtime State)

`src/store/useAppStore.ts` (Zustand) にて管理される一時的なUI状態。

*   **接続状態:** `isStageConnected`, `isCameraConnected`, `stagePort`, `cameraId`.
*   **カメラ制御:** `exposureTime`, `gain`, `cameraResolution`.
*   **ビュー制御:** `zoomLevel`, `panOffset`.
*   **ステージ設定:** `stageSettings` (StepMode, PulsesPerDegree, Speed config).
*   **システム状態:** `isSystemBusy` (排他制御用).

### 5.5 CSV形式

ワイド形式。
`Angle, Timestamp, ROI1_Max, ROI1_Sum, ROI2_Max, ROI2_Sum, ImagePath`

```