"""
切断時（disconnect）に関する安全性テスト。

目的:
 - 録画中（`is_recording == True`）に `disconnect()` が呼ばれた場合でも、
     キャプチャスレッドやファイルハンドルが安全にクローズされ、リソースリークや例外が発生しないことを保証する。

検証ポイント:
 - `start_recording()` が True を返し `is_recording` が True にセットされること
 - 別スレッドから `disconnect()` を呼んで capture loop が停止すること（`is_connected=False`）
 - 録画フラグ `is_recording` が適切に解除されること

注意:
 - Mock 環境では実際のファイル書き込みが発生するため、ファイルI/O周りの副作用を確認するテストを追加する場合は
     一時ディレクトリに出力するか、モック用のファイルオブジェクトを注入して副作用を抑えることを検討してください。
"""
import sys
from pathlib import Path
import time
import threading

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


def test_disconnect_while_recording_stops_cleanly():
    CameraController = _load_camera_controller_class()
    ctrl = CameraController()
    assert ctrl.connect() is True

    # 録画開始: 正常に録画モードへ遷移することを検証
    ok = ctrl.start_recording()
    assert ok is True
    assert ctrl.is_recording is True

    # 別スレッドで短時間後に切断を行う（capture loop が稼働中の想定）
    def do_disconnect():
        time.sleep(0.05)
        ctrl.disconnect()

    t = threading.Thread(target=do_disconnect)
    t.start()
    t.join(timeout=2.0)

    # 切断後は内部状態が適切に更新されていることを検証
    assert ctrl.is_connected is False
    assert ctrl.is_recording is False