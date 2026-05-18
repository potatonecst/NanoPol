# 1. システム概要 (Overview)

### 1.1 目的

対物レンズ下のナノ粒子（~150nm）からの散乱光強度を、1/4波長板の回転角度ごとに精密測定する。
長時間・多点測定に対応し、実験の**「完全なトレーサビリティ（再現性・検証性）」**を確保するデータ管理機能を有する。

### 1.2 ハードウェア制御仕様

  * **回転ステージ (GSC-01):**
      * **実装状況:** **実装済み (Implemented)**
      * 通信: RS-232C (9600bps, Data 8, Stop 1, Parity None).
      * フロー制御: **Hardware (RTS/CTS=True)** (実装に基づき変更).
      * コマンド: `M:` (相対移動), `G:` (駆動), `Q:` (状態確認), `H:` (原点復帰).
      * **動作モード:**
          * **Windows:** 実機接続を試行。接続失敗時はエラー (500) を返す。
          * **Non-Windows (Mac/Linux):** 自動的に **Mockモード** で動作し、仮想的な応答を返す。
  * **カメラ (Thorlabs DCC1545M / モノクロ / uc480):**
      * **実装状況:** **実装済み (Implemented)**
      * ドライバ: IDS `uc480`. Python 側のアクセスは `pylablib.devices.uc480` (pylablib) を用いて行います。
      * ライブラリ移行メモ: 既存の `pyueye` ベース実装は `camera_controller_old.py` に残し、フォールバックとして保持しています。現在の本流は `pylablib` です。
      * デフォルト設定: フロントエンドのデフォルト `cameraMode` は `Monochrome` です（`src/constants/constants.ts` やスキーマで一致確認済み）。
      * センサー: 1280x1024 CMOS, 10-bit ADC.
      * データ取得: **16-bit コンテナ** (`uint16`) として取得・保存。