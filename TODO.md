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
  - [x] **デフォルト角度範囲プリセットの永続化 (Default Angle Range Preset)**: `SettingsView` の Measurement タブでの初期プリセット設定および `MeasurementManager` との双方向同期。
- [x] **測定ロジック・アルゴリズム (Logic / Algorithms)**
  - [x] **オートセンタリング (重み付き平均重心法)**: Pre-Scan時のROI自動補正とロック。
  - [x] **Step & Shoot 自動測定シーケンス**: ステージ回転 → 整定待機 → スナップショット → 輝度算出 → CSV/TIFF逐次保存。
- [x] **出力先プリセット (Output Presets)**
  - [x] `SettingsView` での保存先プロファイル管理と `DevicesView` での動的切り替え。
- [x] **事後処理・メディア変換 (Post-processing)**
  - [x] **日付別サブフォルダ自動集約**: `snapshots/YYYY-MM-DD/` および `videos/YYYY-MM-DD/` へのファイル自動整理。
  - [x] **動画自動変換 (TIFF to MP4)**: 録画停止後（貨物レーン）に、マルチページTIFFを省メモリストリーミングで読み込み MP4 を非同期生成。
  - [x] **ドロップフレーム補完 (Drop-frame Interpolation)**: CSVのタイムスタンプを参照し、コマ落ち区間に直前フレームを水増し挿入して時間軸を完全同期。
  - [x] **変換サマリー・トレーサビリティ記録 (JSON出力)**: 元フレーム数、補完数、ドロップ箇所、実測時間と動画再生時間の差を `同名.json` に記録。
  - [x] **トースト進捗＆ドロップ状況通知**: `sonner` + `shadcn/ui/progress` によるリアルタイム進捗バー表示と、完了時のドロップ有無（ドロップなし/補完あり）に応じた安全でクリーンなトースト通知。
  - [x] **トースト通知の日本語統一とステージ操作インプレース昇格**: アプリ全体のトースト通知を自然な日本語表現に統一。ステージ移動・原点復帰の開始〜完了・停止を同一ID（`STAGE_TOAST_ID`）で1枠のまま滑らかに状態昇格させ、絶対移動の 0.0°〜360.0° 制限バリデーションを追加。

## 🔧 残存タスク (Pending Tasks)

### 1. ハードウェア制御 (Backend / Python)
- [ ] **2x2 ソフトウェアビニングの実装**
  - `camera_controller.py` にて、16-bit RAW (Bayer) 取得時に 2x2 の 4画素 (R, G, G, B) を単純加算するロジックを追加。
- [ ] **カメラパラメータの強制固定**
  - 測定のリニアリティを担保するため、カメラ接続時に `Gamma=1.0` 固定、`AWB=Off`、RGB各ゲイン固定のコマンドを発行する。

### 2. フロントエンド・ユーザー支援 (Frontend / Docs)
- [ ] **Help Mode の実装**
  - 操作マニュアル、測定フロー図、ショートカット一覧、トラブルシューティングを表示する `HelpView.tsx` の実装。
