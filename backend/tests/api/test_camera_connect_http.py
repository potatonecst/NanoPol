"""
HTTP 統合テスト（FastAPI TestClient を使用）

目的:
- 実際の HTTP エンドポイントとして `/camera/connect` を呼び出し、
  レスポンスに `exposure_range` と `gain_range` が含まれることを検証します。
- これにより、ルーティング、Pydantic バリデーション、レスポンスシリアライズ
  などの FastAPI 層で発生する不整合を検出できます。

実行方法:
source backend/.venv/bin/activate
pytest backend/tests/api/test_camera_connect_http.py -q
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
    """`backend/main.py` をロードしてモジュールを返すヘルパー。"""
    module_path = Path(__file__).parents[2] / "main.py"
    spec = importlib.util.spec_from_file_location("backend.main", str(module_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# アプリ読み込み（TestClient の引数として ASGI app が必要）
main = _load_main_module()
app = main.app
client = TestClient(app)


def test_camera_connect_http_exposure_and_gain():
    """`/camera/connect` の統合テスト。

    概要:
    - TestClient を使って実際に HTTP POST を行い、API 層（ルーティング / Pydantic / JSON）を通した
      レスポンスが期待どおりであることを検証します。

    検証ポイント:
    1) HTTP レスポンスコードが 200（成功）であること。
    2) レスポンス JSON の `status` フィールドが `success` であること。
    3) 機器能力として返される `exposure_range` が存在し、
       - `min_ms` と `max_ms` を持ち、数値として妥当（非負、最大 >= 最小）であること。
       - オプションの `step_ms` が返る場合は正の数であること。
    4) モック環境では `gain_range` も返る想定なので、`min`/`max` を持ち、`min <= max` を満たすこと。

    これらはフロントエンドでスライダーや入力フィールドを初期化するための契約（contract）であり、
    API 変更による不整合を早期に検出する目的があります。
    """
    payload = {"camera_id": 0}
    r = client.post("/camera/connect", json=payload)
    assert r.status_code == 200, f"expected 200 but got {r.status_code}"

    body = r.json()
    # API 層が成功を示す 'success' を返していることを確認
    assert body.get("status") == "success"

    # exposure_range の検証
    # exposure_range の存在と値レンジを検証
    # フロントはこれを元にスライダーの min/max/step を決める
    assert "exposure_range" in body, "exposure_range is expected in response"
    er = body["exposure_range"]
    assert "min_ms" in er and "max_ms" in er
    min_ms = float(er["min_ms"])  # ミリ秒単位の最小露光
    max_ms = float(er["max_ms"])  # ミリ秒単位の最大露光
    # 値の妥当性: 最小は非負、最大は最小以上
    assert min_ms >= 0.0
    assert max_ms >= min_ms
    # オプションの step_ms（単位刻み）が返るなら正の数であること
    if "step_ms" in er:
      assert float(er["step_ms"]) > 0.0

    # gain_range の検証（モック環境では返る想定）
    # gain_range の検証（モック環境では返る想定）
    # ハードウェアによっては gain_range を返さない場合があるため、
    # モックで返ることを前提にしています。返らない実装も許容される場合は
    # このアサートを緩和してください。
    assert "gain_range" in body, "gain_range is expected in response in mock environment"
    gr = body["gain_range"]
    assert "min" in gr and "max" in gr
    gmin = float(gr["min"])  # ゲインの下限（倍率など）
    gmax = float(gr["max"])  # ゲインの上限
    # 値の妥当性: min は max 以下であること
    assert gmin <= gmax
