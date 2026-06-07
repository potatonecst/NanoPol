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
      * **Status Badge (ヘッダーインジケーター):** 優先順位順に以下の状態を動的に表示する。
          1. **Backend Offline (赤色・点滅):** バックエンドとの通信が途絶した致命的エラー。
          2. **Measuring / Auto Mode (黄色・点滅):** 自動測定シーケンスを実行中。
          3. **Stage Moving (青色・点滅):** ステージが物理的に回転・移動中。
          4. **All Devices Ready (緑色・点滅):** ステージとカメラの両方が接続され準備完了。
          5. **Stage Ready / Camera Ready (緑色・点滅):** 単一のデバイスのみ接続完了。
          6. **System Ready (グレー・点滅なし):** バックエンド基盤は正常稼働、デバイスの接続を待機中。
          * ※「デバイス未接続」をエラー（赤）ではなく待機（グレー）として扱うことで、バックエンド自体のダウンと明確に区別する。
```

### 3.3 各モードの詳細仕様

#### ① Devices Mode (接続管理) - **Implemented**

`src/components/views/DevicesView.tsx`

  * **Stage Controller Panel:**
      * **COM Port:** プルダウン選択 (Backendから取得)。リフレッシュボタンあり。
      * **Action:** `[Connect]` / `[Disconnect]`.
          * **UI改善:** 接続処理中はボタン内にスピナー (Loader2) を表示し、テキストを "Connecting..." に変更する。
          * **切断仕様:** `[Disconnect]` 押下時はフロントエンドの状態だけを変更せず、必ずバックエンドAPI (`/stage/disconnect`) を呼び出して実機接続を解放する。API成功後にのみ `isStageConnected=false` を反映する。
      * **Status:** 接続時は緑色のBadgeとボーダー強調で視覚的に通知。
      * **挙動:** Windows環境では実機接続を試行し、失敗時はエラー通知を行う。非Windows環境ではMock接続となる。
  * **Camera Panel:**
      * **Camera ID:** ID選択 (Backendから動的に取得)。
          * **実装済み:** リフレッシュボタン、または画面マウント時に `/system/cameras` を叩き、ハードウェアから取得した正確なカメラID・モデル名リストをドロップダウンに表示・更新する。
      * **Action:** `[Connect]` / `[Disconnect]`. 処理中のスピナー表示を追加。
  * **Troubleshooting:**
      * `[Force Reset All Connections]`: システム全体の接続状態を強制リセットし、UIロックを解除する緊急ボタン。
  * **Code Quality:**
      * `RefreshButton` などの内部コンポーネントはファイル外または別ファイルに切り出し、不要な再レンダリングを防止する。

#### ② Manual Mode (調整) - **Implemented**

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
      * **Emergency Stop:** 警告アイコンボタンで即時停止 (`L:E`). 減速なし。
  * **Camera View:**
      * `CameraPanel` コンポーネントにてバックエンドからのMJPEGストリーム (`/camera/video_feed`) を表示する。ズームやパン操作に対応。

#### ③ Auto Mode (自動測定) - **Partially Implemented**

`src/components/views/AutoView.tsx`

サイドバーの状態（フェーズ）遷移でフローを管理する。

**【Session Management (セッション管理)】** - **Implemented**
Autoモードに入った最初のフェーズ。サンプルの新規作成または履歴のロードを行う。

  * **レイアウト:** 左側に操作パネル、右側に `CameraPanel` を表示。
  * **[ New Sample ]**
      * `Sample Name`: 
          * **UI改善:** 明示的なラベル「Sample Name」を追加。
          * **注釈:** ラベルの横に `Optional (Auto-generated if empty)` と表示し、未入力時の自動採番（例: `Sample_1`）を明示。
          * **Placeholder:** `Enter name or leave blank...` とし、ユーザーの迷いを払拭。
      * `[Create & Start]` ボタン (Plusアイコン): 押下するとフォルダを作成し、**Category Selection** へ遷移。
  * **[ Load Session ]**
      * **Date Picker**: `shadcn/ui` の `Calendar` を使用。今日以外の日付のデータもスキャン可能。
      * **Browse Button** (FolderOpenアイコン): OS標準のフォルダ選択ダイアログを開き、任意の位置の `settings.json` をロード。
      * **Session Table**: `shadcn/ui` の `Table` を使用。サンプル名、作成時刻、進捗 (例: 2/4) を一覧表示。
      * `[Resume]` ボタン (ChevronRightアイコン): 1クリックでそのセッションを再開。
  * **遷移:** 選択完了後、**Category Selection** へ遷移。

**【Category Selection (測定項目選択)】** - **Implemented**
どの条件を測定するか選ぶ、実験ノートの目次のようなフェーズ。

  * **サンプル情報:** 選択中のサンプル名を表示。 `[Exit Session]` で最初のフェーズに戻る。
  * **Category Cards:** 以下の4つの測定条件をカード形式で配置（指定順序）。
      1. **Left - Front**: レーザー左入射、プレート手前。
      2. **Right - Front**: レーザー右入射、プレート手前。
      3. **Left - Rear**: レーザー左入射、プレート奥 (Rear)。
      4. **Right - Rear**: レーザー右入射、プレート奥 (Rear)。
      * 測定完了済み項目（`status: completed`）にはステータスアイコン（Check）を表示。
  * **Session History:** セッション内の全測定履歴（ID、開始時刻、最終ステータス）をテーブル形式で一覧表示。
  * **遷移:** カテゴリ選択 → **Measurement Execution** へ。

**【Measurement Execution (測定実行)】**
具体的な測定パラメータの入力と、アライメント、本番測定を行うフェーズ。

  * **レイアウト:** 
      * 左側: パラメータ入力および実行ボタン。
      * 右側: `ResizablePanelGroup` を使用し、上段に `CameraPanel`、下段に `GraphPanel` を配置。
  * **Input (Mandatory):**
      * `Laser Power`: `[ ] mW` (空欄・必須)。
      * `Fiber Pos`: `X:[ ] Y:[ ]` (メモ入力・必須)。
  * **Control Options:**
      * **Auto-start after Pre-Scan** (Toggle): ON の場合、アライメント成功後に本番測定へ自動遷移する（リスク警告あり）。
  * **Action Buttons:**
      * **Mini Jog**: `<` `>` アイコンボタン。ステージを微小角度（相対移動）させてアライメントの最終調整を行う。
      * `[Pre-Scan]` (Searchアイコン): **必須**。ROIオートセンタリングを実行。実行中、最大輝度をリアルタイム表示。
      * `[START MEASUREMENT]` (Playアイコン): 本番開始。
  * **Status & Feedback:**
      * **Countdown**: 自動開始設定時、Pre-Scan 完了後に「Starting in 3...」とカウントダウンを表示。
      * **Max Intensity**: Pre-Scan 中および完了後に検出された最大輝度値を大きく表示。
  * **Graph Panel:**
      * `recharts` を使用。測定中の角度ごとの Sum 輝度をリアルタイムでプロット。
  * **Progress:**
      * 実行中: 現在の角度、残り枚数、プログレスバーを表示。
      * `[ABORT / PAUSE]` (Stopアイコン): 緊急停止。
  * **遷移:** 完了または中断後, **Category Selection** へ戻る。


#### ④ Settings Mode (設定) - **Implemented**

`src/components/views/SettingsView.tsx`

  * **File Save Settings:**
      * **Output Directory:** 測定データの保存先フォルダ。
          * **Default:** `Documents/NanoPol` (OSのドキュメントフォルダ配下)。
          * **Behavior:** 設定保存時にフォルダが存在しない場合、自動的に再帰作成される。
          * **Action:** `[Browse]` BUTTONでネイティブのフォルダ選択ダイアログを開く。
      * **Filename Prefix:** ファイル名の接頭辞 (Default: `scan_`)。
      * **Image Format:** 保存画像のフォーマット (TIFF/PNG/JPG)。
  * **Stage Motion Defaults:**
      * 速度 (Min/Max PPS), 加減速時間 (Accel Time) のデフォルト値設定。
  * **Camera Defaults:**
      * 露光時間 (Exposure), ゲイン (Gain) のデフォルト値設定。
      * これらは主に「起動時/接続直後の初期値」であり、測定中の最終値を直接保証する設定ではない。
      * 測定中（Auto実行中、Step & Shoot 実行中、録画中）は Camera Panel 側の編集UIをロックする。
  * **Persistence & Sync:**
      * 設定は `AppConfig` ディレクトリ（OS標準のアプリ設定場所）にある `config.json` に保存され、次回起動時に自動的に読み込まれる。
      * 保存時 (`[Save Settings]`) およびアプリ起動時、バックエンドの `/system/settings` APIにJSONを送信し、ハードウェアの設定（プレビューのColor/Monoモードなど）に即時反映させる。

#### ⑤ Help Mode (ヘルプ) - **Planned**

  * **用途:** ソフトウェアの操作マニュアル、ショートカットキー一覧、およびトラブルシューティングの表示。
  * **現状:** UIレイアウト（サイドバーの `HelpCircle` アイコン）のみ存在し、ルーティングおよび画面コンポーネントは未接続。

---
*Last Updated: 2026-06-06*