"""
`/camera/config` と `/camera/disconnect` エンドポイントの統合テスト。

テスト内容:
- `test_config_requires_connected_camera`: カメラ未接続時に `/camera/config` が HTTP 400 を返すことを確認
- `test_config_after_connect_applies_settings`: カメラ接続 → 設定適用 が正しく動作することを確認
- `test_disconnect_idempotent`: `/camera/disconnect` を複数回呼んでも問題なく成功することを確認

実行方法:
1. 仮想環境を有効化: `source backend/.venv/bin/activate`
2. テスト実行: `pytest backend/tests/api/test_camera_config_and_disconnect_http.py -q`
"""

from fastapi.testclient import TestClient
from pathlib import Path
import sys
import importlib.util

# backend が import できるようにパスを追加
backend_path = Path(__file__).parents[2]
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))


def _load_main_module():
    module_path = Path(__file__).parents[2] / "main.py"
    spec = importlib.util.spec_from_file_location("backend.main", str(module_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


main = _load_main_module()
app = main.app
client = TestClient(app)


def test_config_requires_connected_camera():
        """未接続状態で `/camera/config` にアクセスすると HTTP 400 を返すことを確認する。

        意図:
        - `/camera/config` はカメラが接続済みであることを前提に動作するため、
            未接続時に不正な変更を受け付けないことを保証します。
        - フロント側が接続確認を怠った場合に備え、バックエンド側で適切なエラーを返すことを検証します。
        """
        # テスト前提を明示: まず確実にカメラを切断して未接続状態を作る
        client.post("/camera/disconnect")

        # 接続済みでない状態で設定を送信
        payload = {"exposure_ms": 10.0, "gain": 1.0}
        r = client.post("/camera/config", json=payload)

        # 未接続なので Bad Request (400) を期待する
        assert r.status_code == 400


def test_config_after_connect_applies_settings():
    """接続後に `/camera/config` を呼ぶと設定が適用されることを確認する。

    意図:
    - `/camera/config` は接続済みのカメラに対して露出とゲインを設定するエンドポイントです。
    - このテストでは、接続→設定→内部状態反映 の一連の流れが正しく動作することを検証します。
    """
    # 1) 接続処理: 接続が成功することをまず確認
    r1 = client.post("/camera/connect", json={"camera_id": 0})
    assert r1.status_code == 200
    body1 = r1.json()
    assert body1.get("status") == "success"

    # 2) 設定適用: exposure と gain を送信して成功を期待
    payload = {"exposure_ms": 15.5, "gain": 2.0}
    r2 = client.post("/camera/config", json=payload)
    assert r2.status_code == 200
    assert r2.json().get("status") == "success"

    # 3) 内部反映確認（直接グローバル camera インスタンスを参照して値が設定されたことを確認）
    #    この確認は統合テストの範囲をやや超えますが、エンドツーエンドでの適用確認として有用です。
    cam = main.camera
    assert abs(cam.get_exposure() - 15.5) < 1e-6
    assert abs(cam.get_gain() - 2.0) < 1e-6


def test_disconnect_idempotent():
        """`/camera/disconnect` の冪等性を検証。

        意図:
        - ユーザー操作やフロントエンドの再送などで切断リクエストが重複して送られても
            サーバーがエラーを返さず安定して動作することを確認します。
        """
        # 1回目の切断: 成功すること
        r1 = client.post("/camera/disconnect")
        assert r1.status_code == 200
        assert r1.json().get("status") == "success"

        # 2回目の切断（既に切断済み）: それでも success を返して安全に処理されること
        r2 = client.post("/camera/disconnect")
        assert r2.status_code == 200
        assert r2.json().get("status") == "success"
