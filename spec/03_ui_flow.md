# 3. 画面遷移とUI仕様 (UI Flow & Layout)

### 3.1 アプリ起動時の挙動

  * **初期画面:** **🔌 Devices Mode** をデフォルトで表示。
  * **保存先設定:** 初回起動時にデフォルト保存先（例: `D:\Data`）がない場合、設定を促す。（これは、`Settings`モードで実装されるべき将来の機能）
  * **初期化プロセス:**
      * Backendの `/system/ports` をコールし、利用可能なCOMポートをリストアップ。
      * 以前の接続状態は保持されず、起動時は常に切断状態 (Disconnected) から開始する (安全設計)。

### 3.2 メイン画面レイアウト (Main Layout)

`src/App.tsx` および `src/components/AppSidebar.tsx` により構成される。

```text
+--------------------------------------------------------------------------------+
| [ HEADER ]                                                                     |
| 🌊 NanoPol Controller v0.1 | [Status Badge] | [Theme Toggle] | [Rec] [Snapshot]|
+--------------------------------+-----------------------------------------------+
|                                |                                               |
| [ S ] [Devices] (Cable)        |                                               |
| [ I ] [Manual ] (HandMetal)    |                                               |
| [ D ] [Auto   ] (Activity)     |      [ MAIN CONTENT AREA ]                    |
| [ E ] [Setting] (Settings)     |      (React Router Outlet)                    |
| [ B ]                          |                                               |
| [ A ] [Help   ] (HelpCircle)   |                                               |
| [ R ]                          |                                               |
|                                |                                               |
+--------------------------------+-----------------------------------------------+
| [ LOG PANEL ] (Resizable / Collapsible) [↓ New Logs]                         |
| [INFO] System initialized. Waiting for connection...                           |
+--------------------------------------------------------------------------------+
  * **Behavior:**
      * **Smart Auto-Scroll:** 常に最新を表示している場合のみ自動追従。過去ログ閲覧中は停止。
      * **Resume Button:** スクロールアップ時、右下に `[↓]` ボタンを表示し、強制的に最新へ戻れるようにする。
      * **Close Action:** ヘッダー・閉じるボタン押下時は、最大化状態を解除して閉じる（次回Open時はデフォルト高さ）。
```

### 3.3 各モードの詳細仕様

#### ① 🔌 Devices Mode (接続管理) - **Implemented**

`src/components/views/DevicesView.tsx`

  * **Stage Controller Panel:**
      * **COM Port:** プルダウン選択 (Backendから取得)。リフレッシュボタンあり。
      * **Action:** `[Connect]` / `[Disconnect]`.
          * **UI改善:** 接続処理中はボタン内にスピナー (Loader2) を表示し、テキストを "Connecting..." に変更する。
      * **Status:** 接続時は緑色のBadgeとボーダー強調で視覚的に通知。
      * **挙動:** Windows環境では実機接続を試行し、失敗時はエラー通知を行う。非Windows環境ではMock接続となる。
  * **Camera Panel:**
      * **Camera ID:** ID選択 (Backendから動的に取得)。
          * **改善:** リフレッシュボタンで `/system/cameras` (Planned) を叩き、接続可能なカメラIDリストを更新する仕組みを導入。
      * **Action:** `[Connect]` / `[Disconnect]`. 処理中のスピナー表示を追加。
      * **Note:** 現在はBackendのMockエンドポイントに接続するのみ。
  * **Troubleshooting:**
      * `[Force Reset All Connections]`: システム全体の接続状態を強制リセットし、UIロックを解除する緊急ボタン。
  * **Code Quality:**
      * `RefreshButton` などの内部コンポーネントはファイル外または別ファイルに切り出し、不要な再レンダリングを防止する。

#### ② 🛠️ Manual Mode (調整) - **Implemented**

`src/components/views/ManualView.tsx`

  * **レイアウト:** 左側にコントロールパネル、右側にカメラビュー (`CameraPanel`) の2カラム構成。
  * **Stage Control Features:**
      * **Current Angle:** `stageApi.getPosition()` によるリアルタイム表示。
      * **Step Move:** `[+]` `[-]` ボタンで相対移動。ステップ幅は `Input` で指定可能。
      * **Homing:** `[Origin]` ボタンで機械原点復帰 (`H:W`).
      * **Absolute Move:** ターゲット角度を入力して `[Go]` で移動。
      * **Sweep:** `Start`, `End`, `Speed (deg/s)` を指定して連続回転。
          * 内部で `PPS` に変換し、安全速度リミット (`maxSpeedLimitPPS`) を適用。
          * 実行中は `[Stop]` ボタンで中断可能。
      * **Emergency Stop:** `[⚠️]` ボタンで即時停止 (`L:E`). 減速なし。
  * **Camera View:**
      * 現在は `CameraPanel` コンポーネントがあるが、実映像は表示されない (Placeholder)。

#### ③ 📉 Auto Mode (自動測定) - **Planned**

サイドバーの状態遷移でフローを管理する。

**【State 0: セッション開始 (Session Entry)】**
Autoモードに入った最初の状態。サイドバーに表示。

  * **Base Folder:** `D:\Data` (設定から自動反映)
  * **Date Folder:** `YYYYMMDD` (当日日付で自動生成)
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

#### ④ ⚙️ Settings Mode (設定) - **Planned**

  * **Path Settings:**
      * `Default Base Folder`: 測定データ保存のルートパス (例: `D:\Data`)。
  * **Device Settings:**
      * パルス/度 換算値 (Default: 400 pulses/degree)。
      * 通信タイムアウト設定。
  * **UI Settings:**
      * **Sounds:** 完了時・エラー時の通知音 (ON/OFF)。
      * **Safety:** 測定中止時やアプリ終了時の確認ダイアログ表示 (ON/OFF)。