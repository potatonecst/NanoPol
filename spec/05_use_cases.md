# 6. ユースケース (Use Cases)

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
