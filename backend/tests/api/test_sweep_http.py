"""
Sweep 実行・進捗 API の統合テスト。

検証内容:
- `/stage/sweep/run` が operation_id と plan を返すこと
- `/stage/sweep/progress` が operation_id で対象 Sweep を識別できること
- Sweep 実行中に手動ステージ操作が拒否されること
- 未知の operation_id に対して 404 を返すこと
"""

from fastapi.testclient import TestClient
from pathlib import Path
import importlib.util
import sys
import threading
import time

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


class _SweepTestGuard:
    def __init__(self):
        self._lock = threading.Lock()

    def reset(self):
        with self._lock:
            main.stage.is_connected = True
            main.stage.speed_min_pps = 500
            main.stage.speed_max_pps = 5000
            main.stage.speed_accel_ms = 200
            main.app_state.current_angle = 0.0
            main.app_state.is_busy = False
            main.app_state.is_measuring = False
            main.app_state.last_stage_command = None
            main.app_state.sweep_operation = None


_guard = _SweepTestGuard()


def setup_function():
    _guard.reset()


def teardown_function():
    _guard.reset()


def _patch_fast_sweep(monkeypatch, move_delay: float = 0.05):
    def fake_set_speed(min_pps, max_pps, accel_time_ms):
        return True

    def fake_move_absolute(angle, allow_overflow=False):
        time.sleep(move_delay)
        main.app_state.current_angle = angle
        return True

    def fake_move_relative(delta_angle, current_angle_hint=None):
        time.sleep(move_delay)
        main.app_state.current_angle += delta_angle
        return True

    monkeypatch.setattr(main.stage, "set_speed", fake_set_speed)
    monkeypatch.setattr(main.stage, "move_absolute", fake_move_absolute)
    monkeypatch.setattr(main.stage, "move_relative", fake_move_relative)


def test_sweep_run_returns_operation_and_progress(monkeypatch):
    _patch_fast_sweep(monkeypatch, move_delay=0.03)

    response = client.post(
        "/stage/sweep/run",
        json={"start_deg": 10.0, "end_deg": 80.0, "speed_deg_s": 15.0, "auto_record": False},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "accepted"
    assert "operation_id" in body
    assert body["plan"]["kind"] == "sweep"
    assert body["plan"]["actual_end_deg"] >= body["plan"]["actual_start_deg"]

    operation_id = body["operation_id"]

    progress = client.get("/stage/sweep/progress", params={"operation_id": operation_id})
    assert progress.status_code == 200
    progress_body = progress.json()
    assert progress_body["operation_id"] == operation_id
    assert progress_body["kind"] == "sweep"
    assert progress_body["status"] in {"running", "succeeded"}
    assert 0 <= progress_body["percent"] <= 100

    for _ in range(50):
        latest = client.get("/stage/sweep/progress", params={"operation_id": operation_id})
        assert latest.status_code == 200
        latest_body = latest.json()
        if latest_body["status"] == "succeeded":
            assert latest_body["percent"] == 100
            break
        time.sleep(0.05)
    else:
        raise AssertionError("sweep did not complete in time")


def test_sweep_blocks_manual_move_while_running(monkeypatch):
    _patch_fast_sweep(monkeypatch, move_delay=0.2)

    response = client.post(
        "/stage/sweep/run",
        json={"start_deg": 10.0, "end_deg": 80.0, "speed_deg_s": 15.0, "auto_record": False},
    )
    assert response.status_code == 200

    blocked = client.post("/stage/move/absolute", json={"angle": 12.0, "allow_overflow": False})
    assert blocked.status_code == 409
    assert "Sweep is running" in blocked.json()["detail"]


def test_sweep_progress_rejects_unknown_operation_id(monkeypatch):
    _patch_fast_sweep(monkeypatch, move_delay=0.01)

    response = client.get("/stage/sweep/progress", params={"operation_id": "sweep_missing"})
    assert response.status_code == 404
