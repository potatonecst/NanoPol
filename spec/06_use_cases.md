# 6. ユースケース (Use Cases)

> **Note:** ここに記載されたユースケースは、将来実装予定の機能 (Auto Mode等) に基づくものです。

### Case 1: 新規サンプルの測定開始

1.  **Devices:** 機器接続完了。
2.  **Session Management:** セッション管理画面で、`Sample Name` に `Sample_1` が自動入力されているのを確認し、`Create & Start` をクリック。
3.  **Category Selection:** カテゴリ選択画面に切り替わる。`[1. Left / Front]` を選択。
4.  **Measurement Execution:** 測定実行画面へ。レーザーパワー入力、ROI設定、プレスキャンを行い、本番測定を開始。

### Case 2: アプリ再起動後の復旧 (本日分)

1.  **Session Management:** 今日の日付が選択されている状態で、セッション一覧テーブルから `Sample_1` を探し、`Resume` ボタンをクリック。
2.  **Category Selection:** `settings.json` が読み込まれ、カテゴリ選択画面に復帰。
      * カテゴリ選択ボタンには、中断前に完了していた項目のステータスアイコン（Check）が表示されている。
3.  **Resume:** 未完了のステップを選択して測定を続行。

### Case 3: 過去データのロードと再開

1.  **Session Management:** `Date Picker` で過去の測定日を選択、または `Browse` ボタンから対象のフォルダ（`settings.json` が含まれる場所）を選択。
2.  **Restore:** 指定したフォルダのセッション情報がロードされ、カテゴリ選択画面へ遷移。
3.  **History:** 過去のROI設定や測定済みの項目が正確に復元される。
