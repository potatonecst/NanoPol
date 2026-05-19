# 12. テスト仕様と実行手順 (Testing)

## 目的
テスト仕様書では、開発環境・依存管理・実行手順、およびハードウェア抽象化コンポーネント（`CameraController` 等）の単体テスト方針をまとめます。

## 環境準備
- 推奨ワークフロー（ローカル開発）:
  ```bash
  cd backend
  # プロジェクト仮想環境を作成/同期
  uv sync
  # venv を有効化してからテストを実行
  source .venv/bin/activate
  uv run pytest -q
  ```

- 依存のうち dev/test グループも同期したい場合は `uv` のグループオプションを使ってください（プロジェクトの uv 実装でフラグ名が異なります）。例:
  ```bash
  uv sync --group test --group dev
  ```

  実際の環境では `--group` が有効でした。`uv sync --help` の結果に従って、必要なグループを明示してください。

## VS Code の推奨設定
- ワークスペースにインタープリタを固定することで、ターミナルと拡張が一致します。例（.vscode/settings.json）:
  ```json
  {
    "python.defaultInterpreterPath": "${workspaceFolder}/backend/.venv/bin/python",
    "python.terminal.activateEnvironment": true
  }
  ```

## テストの方針
- ハードウェア依存コードは Mock を用いて検証します。Mock は `backend/tests/mocks/` に配置され、`conftest.py` の autouse fixture で差し替えられます。
- 目的は次の点を早期に検出すること:
  - パブリック API の不一致（メソッド名・戻り値の変更など）
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

## テストの実行例
```bash
cd backend
source .venv/bin/activate
uv run pytest tests/devices/test_camera_controller.py -q
``` 

## トラブルシュート（よくある事象）
- `pytest` が見つからない：`uv sync` が dev/test グループをインストールしていない可能性があります。臨時対応として `python -m pip install pytest` を行った後、`uv sync` のグループオプションを検討してください。
- アクティブな venv が別のパスを指している：`echo $VIRTUAL_ENV` と `which python` を確認し、`.venv` へ切り替えてください。

## ドキュメント整合性
- この仕様書を更新したら、`docs/01_backend_devices.md` の CameraController セクションにリンクを張り、変更履歴を残してください。

---
Last Updated: 2026-05-19
