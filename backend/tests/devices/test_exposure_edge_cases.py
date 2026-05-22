"""
露出（exposure）に関する境界値・異常値テスト。

目的:
 - 現在の `CameraController.set_exposure()` / `get_exposure()` の既存挙動を明確にし、
     将来の仕様変更（例: サーバー側でのバリデーション・クランプ導入）時に差分が分かるようにする。

テスト対象の前提:
 - `set_exposure(ms)` はミリ秒単位の値を受け取り、現在の実装では受け取った値をそのまま内部状態
     (`exposure_ms`) に保持する（Mock 環境では変換なしで返す）。
 - 実機では `get_exposure_range()` により有効範囲 (min,max,step) を取得できる場合がある。

検証内容:
 - 小数値（12.5ms）がそのまま適用されること
 - 負数や極大値を設定した場合、現行実装では拒否せずそのまま設定される（ドキュメント化）

注意事項:
 - 将来的にサーバー側でクランプや例外を返す仕様に変更する場合、このテストは期待値を更新する必要があります。
"""
import sys
from pathlib import Path
import time

backend_path = Path(__file__).parents[2]
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

import importlib.util


def _load_camera_controller_class():
    module_path = Path(__file__).parents[2] / "devices" / "camera_controller.py"
    spec = importlib.util.spec_from_file_location("devices.camera_controller", str(module_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CameraController


def test_exposure_accepts_various_values():
    CameraController = _load_camera_controller_class()
    ctrl = CameraController()
    assert ctrl.connect() is True

    min_ms, max_ms, step_ms = ctrl.get_exposure_range()

    # 正常域: 小数値がそのまま適用されることを確認
    val = 12.5
    assert ctrl.set_exposure(val) == val
    assert ctrl.get_exposure() == val

    # 負数の挙動: サーバー側で自動クランプする方針に変更したため、
    # 最小値に丸められることを確認する。
    neg = -5.0
    applied_neg = ctrl.set_exposure(neg)
    assert applied_neg == min_ms
    assert ctrl.get_exposure() == min_ms

    # 極大値: exposure_range の上限を超える値を与えた場合、上限にクランプされることを確認
    huge = max_ms * 10
    applied_huge = ctrl.set_exposure(huge)
    assert applied_huge == max_ms
    assert ctrl.get_exposure() == max_ms