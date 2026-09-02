# 開発バックログ & TODO (Roadmap)

本ドキュメントは、仕様書に定義されているが未実装の機能や、今後の開発タスクを管理するためのチェックリストです。

## 🎯 完了済み機能 (Completed)
- [x] **Auto Mode フロントエンド実装 (Session Management)**
  - [x] `Table` によるセッション一覧表示。
  - [x] `Calendar` & `Popover` による日付選択 (Date Picker) の実装。
  - [x] `Sample Name` の自動採番ロジックと新規作成フローの実装。
- [x] **Auto Mode 実装 (Category Selection)**
  - [x] `Category Card` による測定箇所の選択メニュー実装。
  - [x] `settings.json` の履歴に基づく「✅ 完了」「⚠️ 飽和」バッジの表示。
- [x] **Auto Mode 実装 (Measurement Execution)**
  - [x] `ResizablePanelGroup` による映像とグラフの上下分割レイアウト。
  - [x] `recharts` を使用した散乱強度リアルタイムグラフの実装。
  - [x] `Measurement Manager` パネル（パラメータ入力、Pre-Scan、実行）。
  - [x] **角度範囲プリセット (Angle Range Presets)**: Standard, High-Res, Half, Quarter, Quick Check の1クリック適用と、レイアウトシフトゼロのインライン動的説明バー（Preview/Active/Custom連動・レスポンシブ余白保証）の実装。
- [x] **測定ロジック・アルゴリズム (Logic / Algorithms)**
  - [x] **オートセンタリング (重み付き平均重心法)**: Pre-Scan時のROI自動補正とロック。
  - [x] **Step & Shoot 自動測定シーケンス**: ステージ回転 → 整定待機 → スナップショット → 輝度算出 → CSV/TIFF逐次保存。
- [x] **出力先プリセット (Output Presets)**
  - [x] `SettingsView` での保存先プロファイル管理と `DevicesView` での動的切り替え。

## 🔧 残存タスク (Pending Tasks)

### 1. ハードウェア制御 (Backend / Python)
- [ ] **2x2 ソフトウェアビニングの実装**
  - `camera_controller.py` にて、16-bit RAW (Bayer) 取得時に 2x2 の 4画素 (R, G, G, B) を単純加算するロジックを追加。
- [ ] **カメラパラメータの強制固定**
  - 測定のリニアリティを担保するため、カメラ接続時に `Gamma=1.0` 固定、`AWB=Off`、RGB各ゲイン固定のコマンドを発行する。

### 2. 事後処理・メディア変換 (Post-processing)
- [ ] **動画変換 (TIFF to MP4)**
  - 録画終了後（貨物レーン）に、巨大なマルチページ TIFF を読み込んで MP4 を非同期生成する処理の実装。
- [ ] **ドロップフレーム補完 (Drop-frame Interpolation)**
  - MP4変換時、CSVのタイムスタンプを参照してコマ落ち区間をコピーフレームで埋める処理。

### 3. フロントエンド・ユーザー支援 (Frontend / Docs)
- [ ] **Help Mode の実装**
  - 操作マニュアル、測定フロー図、ショートカット一覧、トラブルシューティングを表示する `HelpView.tsx` の実装。
