# 開発バックログ & TODO (Roadmap)

本ドキュメントは、仕様書に定義されているが未実装の機能や、今後の開発タスクを管理するためのチェックリストです。

## 🎯 次の目標 (Next Actions)
- [ ] **Auto Mode フロントエンド実装 (Session Management)**
  - `Table` によるセッション一覧表示。
  - `Calendar` & `Popover` による日付選択 (Date Picker) の実装。
  - `Sample Name` の自動採番ロジックと新規作成フローの実装。

## 🔧 ハードウェア制御 (Backend / Python)
- [ ] **2x2 ソフトウェアビニングの実装**
  - `camera_controller.py` にて、16-bit RAW (Bayer) 取得時に 2x2 の 4画素 (R, G, G, B) を単純加算するロジックを追加。
- [ ] **カメラパラメータの強制固定**
  - 測定のリニアリティを担保するため、カメラ接続時に `Gamma=1.0` 固定、`AWB=Off`、RGB各ゲイン固定のコマンドを発行する。

## 🖥️ フロントエンド機能 (Frontend / React)
- [ ] **Auto Mode 実装 (Category Selection)**
  - `Category Card` による測定箇所の選択メニュー実装。
  - `settings.json` の履歴に基づく「✅ 完了」バッジの表示。
- [ ] **Auto Mode 実装 (Measurement Execution)**
  - `ResizablePanelGroup` による映像とグラフの上下分割レイアウト。
  - `recharts` を使用した散乱強度リアルタイムグラフの実装。
  - `Measurement Manager` パネル（パラメータ入力、Pre-Scan、実行）。
- [ ] **CameraPanel の拡張操作**
  - 映像上でのマウスホイールズーム、ドラッグによるパン（移動）機能。
- [ ] **ROI (関心領域) の管理機能**
  - 映像上での Ctrl+Click による ROI 作成。
  - ROI のドラッグ移動・リサイズ操作。

## 🧠 測定ロジック・解析 (Logic / Algorithms)
- [ ] **オートセンタリング (反復重心法)**
  - プレスキャン時に、指定された ROI の輝度重心を計算して枠を自動補正するアルゴリズム。
- [ ] **Step & Shoot 自動測定シーケンス**
  - ステージ回転 → 整定 → スナップショット撮影 → 解析 → 次へ のループ処理。

## 📦 事後処理・その他 (Post-processing & Misc)
- [ ] **動画変換 (TIFF to MP4)**
  - 録画終了後（貨物レーン）に、巨大なマルチページ TIFF を読み込んで MP4 を生成する。
- [ ] **ドロップフレーム補完 (Drop-frame Interpolation)**
  - MP4変換時、CSVのタイムスタンプを参照してコマ落ち区間をコピーフレームで埋める処理。
- [ ] **Help Mode の実装**
  - 操作マニュアルやショートカットの表示（UIのモックはあるが未接続）。
