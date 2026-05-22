"""
Gain の境界値テスト: 範囲外入力に対してクランプされることを検証する。

- set_gain が上限を超える値を受けた場合、get_gain() が gain_max を返す
- set_gain が下限を下回る値を受けた場合、get_gain() が gain_min を返す

意図:
- UI から誤った（あるいは古い実装に基づく）値が送られた場合でも、
  サーバー側で安全にクランプされることを契約として保証する。
"""

import sys
from pathlib import Path

# backend パスを解決して imports を可能にする
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


def test_gain_clamps_to_max_and_min():
    CameraController = _load_camera_controller_class()
    ctrl = CameraController()

    # 接続してモック状態を作る
    assert ctrl.connect() is True

    gmin, gmax = ctrl.get_gain_range()

    # 上限を超える値を設定 -> クランプされて gmax になる
    ctrl.set_gain(gmax + 1000.0)
    assert ctrl.get_gain() == gmax

    # 下限を下回る値を設定 -> クランプされて gmin になる
    ctrl.set_gain(gmin - 1000.0)
    assert ctrl.get_gain() == gmin