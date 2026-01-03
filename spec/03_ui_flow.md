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
| [ LOG PANEL ] (Resizable / Collapsible)                                        |
| [INFO] System initialized. Waiting for connection...                           |
+--------------------------------------------------------------------------------+
```

### 3.3 各モードの詳細仕様

#### ① 🔌 Devices Mode (接続管理) - **Implemented**

`src/components/views/DevicesView.tsx`

  * **Stage Controller Panel:**
      * **COM Port:** プルダウン選択 (Backendから取得)。リフレッシュボタンあり。
      * **Action:** `[Connect]` / `[Disconnect]`.
      * **Status:** 接続時は緑色のBadgeとボーダー強調で視覚的に通知。
      * **挙動:** Windows環境では実機接続を試行し、失敗時はエラー通知を行う。非Windows環境ではMock接続となる。
  * **Camera Panel:**
      * **Camera ID:** ID選択 (現在は '1' 固定のMock)。
      * **Action:** `[Connect]` / `[Disconnect]`.
      * **Note:** 現在はBackendのMockエンドポイントに接続するのみ。
  * **Troubleshooting:**
      * `[Force Reset All Connections]`: システム全体の接続状態を強制リセットし、UIロックを解除する緊急ボタン。

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

  * **現状:** プレースホルダー表示のみ。
  * **予定:** `spec.md` v9.0 に準拠した、セッション管理・測定シーケンスUIを実装予定。

#### ④ ⚙️ Settings Mode (設定) - **Planned**

  * **現状:** プレースホルダー表示のみ。
  * **予定:** 保存先パス設定、ステージのパルスレート設定などの永続化管理。