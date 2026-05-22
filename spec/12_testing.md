# 12. テスト仕様 (Testing)

## 目的
テスト仕様書では、何をテスト対象とし、何を合格条件とするかをまとめます。実行コマンドやローカル環境の準備手順、実機ログの読み方は [docs/01_backend_devices.md](docs/01_backend_devices.md)、[docs/02_backend_server.md](docs/02_backend_server.md)、[docs/07_uc480_poc_results.md](docs/07_uc480_poc_results.md) を参照してください。

## テストの方針
- ハードウェア依存コードは Mock を用いて検証します。Mock は `backend/tests/mocks/` に配置され、`conftest.py` の autouse fixture で差し替えられます。
- 目的は次の点を早期に検出すること:
  - パブリック API の不一致（メソッド名・戻り値の変更など）

## 終了処理・ログ保持に関するテスト

- **`/system/shutdown` の受信テスト:** Rust 側からシャットダウン要求を送った際に、Python 側が `Shutdown requested by Tauri sidecar` 相当のログを出力し、`[SYSTEM] Cleanup Complete.` まで到達すること。
- **優雅停止失敗時のフォールバック:** Rust が `/system/shutdown` の応答を得られなかった場合に、Rust 側が `system.log` に追記する補助手段（shutdown note）が動作すること。
- **後始末の完全性:** シャットダウン後に COM ポートやファイルハンドラが OS レベルで解放されていること（`lsof`/`handle` で未解放がないこと）。
  - 主要な画像処理ロジック（Bayer デモザイク、色変換）が期待どおり動くか
  - 例外・エラー分岐（接続失敗時の挙動、idempotency）

## CameraController に対する具体的テスト項目
- `get_available_cameras()` が期待フォーマットのリストを返す
- `connect()` / `disconnect()` の idempotency（複数回呼んでも安定すること）
- `connect()` が実機接続時に `uc480.UC480Camera(cam_id=...)` を生成し、`self.camera` に保持する（実装では `from pylablib.devices import uc480` でインポート済み）
- `set_exposure(ms)` と `get_exposure()` の相互運用性
- `set_gain(val)` と `get_gain()` の相互運用性
- `_get_bayer_color_conversion_code()` の判定ロジック（各 Bayer パターンごとに正しい cv2 コードが返ること）
- `take_snapshot()` が最新フレームを返す・保存する振る舞い（Mock と実機の差は `GET /camera/diagnostics` で確認）
- `start_recording()` が `videos/` 配下に TIFF/CSV を作成し、`stop_recording()` 後に `Recording stopped` が出ること
- `stop_recording()` 後に writer が `None` になっても、キャプチャループが例外なく抜けること

## ドキュメント整合性
- 実行手順・ログの読み方・PoC の検証結果は `docs/01_backend_devices.md`、`docs/02_backend_server.md`、`docs/07_uc480_poc_results.md` に分離して記載します。

---
Last Updated: 2026-05-22
