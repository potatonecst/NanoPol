# 5. データ保存仕様 (Data Management)

本ドキュメントでは、自動測定におけるデータ構造および保存ロジックについて定義する。

### 5.1 ディレクトリ階層

階層構造: `[Base] / AutoMeasurementData / [YYYYMMDD] / [SampleName] / ...`

  * **[Base]:** Settingsモードで設定されたルートパス。
      * **Default:** `~/Documents/NanoPol` (ユーザーのドキュメントフォルダ内)。
      * **Config:** `AppConfig/config.json` に保存された `outputDirectory` の値を使用。
  * **AutoMeasurementData:** 手動操作（SnapshotsやManual Sweep）のデータと区別するための、自動測定専用のルートフォルダ。
  * **[YYYYMMDD]:** 測定実行日の日付（ローカルタイム）で自動生成。

```text
📂 [Settingsの outputDirectory] (例: ~/Documents/NanoPol)
     └─📂 AutoMeasurementData \
          └─📂 20260601 \
               └─📂 Sample_1 \
                    │
                    ├── 📄 settings.json        # ★サンプル全体の測定履歴マスター（目次）
                    │
                    ├── 📂 1_Left_Front_001 /   # 1回目の試行（カテゴリ + 枝番ID）
                    │    ├── 📄 1_Left_Front_001.csv  # 光強度の測定データ (Angle, Timestamp, ROI_Sum/Max)
                    │    ├── 📄 measurement_details.json # ★この測定時の詳細メタデータとPre-Scan履歴
                    │    │
                    │    ├── 📂 prescan /             # Pre-Scan時の証拠保全データ
                    │    │    ├── attempt_1.tif       # 失敗したPre-Scanの画像（飽和などの証拠）
                    │    │    ├── attempt_1.csv       # 失敗したPre-Scanの光強度データ
                    │    │    ├── attempt_2.tif       # 最終的に採用されたPre-Scanの画像
                    │    │    └── attempt_2.csv       # 最終的に採用されたPre-Scanの光強度データ
                    │    │
                    │    └── 📂 images /              # 本番測定のマルチページTIFF保存先
                    │         └── measurement.tif     # 生データ (8-bit or 16-bit 無加工)
                    │
                    ├── 📂 1_Left_Front_002 /   # やり直し(Redo)時の新しい試行データ
                    │    └── ...
                    │
                    └── 📂 2_Left_Rear_001 /    # 次の条件の測定データ
                         └── ...
```

### 5.2 自動採番ロジック

新規作成時、バックエンドが当日のフォルダ内をスキャンする。

  * `Sample_1` が存在 → `Sample_2` を初期値としてUIに提案。
  * ユーザーはそのまま連番で作成することも、任意の名前（例: `Au_150nm`）に変更することも可能。

### 5.3 settings.json (Master Record)

サンプルの「実験ノート」としての役割を持つ。各測定セッションの**マクロな進行状況、開始・終了時刻、およびセッション再開用の最新ROI設定**を記録する。

```json
{
  "app_version": "0.1.0",
  "sample_name": "Sample_1",
  "created_at": "2026-06-01T10:00:00Z",
  "measurements": [
    {
      "id": "1_Left_Front_001",           // フォルダ名・CSV名と一致
      "step_category": "1_Left_Front",
      "status": "cancelled",              // 失敗・中断時は cancelled または failed
      "timestamp_start": "2026-06-01T10:05:00Z", // 本番測定（Step&Shoot）を開始した時刻
      "timestamp_end": "2026-06-01T10:06:15Z"
    },
    {
      "id": "1_Left_Front_002",
      "step_category": "1_Left_Front",
      "status": "completed",              // やり直して成功した
      "timestamp_start": "2026-06-01T10:10:00Z",
      "timestamp_end": "2026-06-01T10:12:00Z"
    }
  ],
  "rois": [
    {
      "index": 1,
      "x": 500.0,
      "y": 400.0,
      "size": 11
    }
  ]
}
```

### 5.4 measurement_details.json (Detailed Metadata)

各測定の枝番フォルダ（例: `1_Left_Front_001/`）内に保存される詳細な証拠データ。
**Pre-Scan の試行履歴（失敗・成功時の環境スナップショット）** と、最終的に本番測定で**固定（ロック）された ROI の座標**を記録する。このフォルダだけをコピーすれば解析に必要な情報が全て揃う（ポータビリティ）。

```json
{
  "measurement_id": "1_Left_Front_001",
  "is_prescan": false,
  "final_environment": {
    "metadata": {
      "laser_power_mw": 10.5,
      "fiber_pos_x": 100,
      "fiber_pos_y": 200
    },
    "camera": {
      "exposure_time_ms": 100.0,
      "gain": 1.0,
      "input_bpp": 8 // 動的飽和判定やデータ型の基準となる重要な値
    }
  },
  "prescan_history": [
    {
      "attempt": 1,
      "status": "failed",
      "environment": {
        "metadata": { "laser_power_mw": 10.5, "fiber_pos_x": null, "fiber_pos_y": null },
        "camera": { "exposure_time_ms": 500.0, "gain": 5.0, "input_bpp": 8 }
      },
      "reason": "Contrast check failed (Flat noise)" // 飽和やノイズでアライメント失敗
    },
    {
      "attempt": 2,
      "status": "success",
      "environment": {
        "metadata": { "laser_power_mw": 10.5, "fiber_pos_x": 100, "fiber_pos_y": 200 },
        "camera": { "exposure_time_ms": 100.0, "gain": 1.0, "input_bpp": 8 }
      },
      "message": "Centroid calculated successfully"
    }
  ],
  "rois": [
    {
      "index": 1,
      "initial": { "x": 500, "y": 400, "size": 11 }, // ユーザーが手動で置いた初期位置
      "final_aligned": { 
        "x": 502,            // 整数（画像切り出し用）
        "y": 399,            // 整数（画像切り出し用）
        "size": 11,
        "optical_centroid_x": 502.345, // 小数（真のサブピクセル重心座標、科学データ用）
        "optical_centroid_y": 398.812
      } 
    }
  ]
}
```

### 5.4 フロントエンド状態管理 (Runtime State)

`src/store/useAppStore.ts` (Zustand) にて管理される一時的なUI状態。

*   **接続・監視状態:** `isBackendConnected`, `isStageConnected`, `isCameraConnected`, `stagePort`, `cameraId`.
*   **カメラ制御:** `exposureTime`, `gain`, `cameraResolution`.
*   **ビュー制御:** `zoomLevel`, `panOffset`.
*   **ステージ設定:** `stageSettings` (StepMode, PulsesPerDegree, Speed config).
*   **システム状態:** `isSystemBusy` (排他制御用), `isStageBusy` (ステージ物理動作中), `isMeasuring` (自動測定中).

### 5.5 CSV形式

ワイド形式。
`Angle, Timestamp, ROI1_Max, ROI1_Sum, ROI2_Max, ROI2_Sum, ImagePath`

```