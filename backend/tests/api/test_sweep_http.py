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
            main.stage._mock_move_cancel = True
            main.stage._mock_pulse = 0
            main.stage._mock_is_busy = False
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


def test_sweep_run_returns_operation_and_progress(monkeypatch):
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

    # Mock は合計で 1秒 (approach 0.5s + sweep 0.5s) ほどかかる
    for _ in range(100):
        latest = client.get("/stage/sweep/progress", params={"operation_id": operation_id})
        assert latest.status_code == 200
        latest_body = latest.json()
        if latest_body["status"] == "succeeded":
            assert latest_body["percent"] == 100
            break
        time.sleep(0.1)
    else:
        raise AssertionError("sweep did not complete in time")


def test_sweep_blocks_manual_move_while_running(monkeypatch):
    response = client.post(
        "/stage/sweep/run",
        json={"start_deg": 10.0, "end_deg": 80.0, "speed_deg_s": 15.0, "auto_record": False},
    )
    assert response.status_code == 200

    blocked = client.post("/stage/move/absolute", json={"angle": 12.0, "allow_overflow": False})
    assert blocked.status_code == 409
    assert "Sweep is running" in blocked.json()["detail"]


def test_sweep_progress_rejects_unknown_operation_id(monkeypatch):
    response = client.get("/stage/sweep/progress", params={"operation_id": "sweep_missing"})
    assert response.status_code == 404

def test_sweep_with_auto_record(monkeypatch):
    """
    auto_record=True で Sweep を実行した際、カメラの録画メソッドが
    prepare -> trigger -> stop の順で正しく呼ばれることを確認するテスト。
    """
    # カメラの録画メソッドが呼ばれた回数を記録する
    call_counts = {"prepare": 0, "trigger": 0, "stop": 0}
    
    def mock_prepare_recording():
        call_counts["prepare"] += 1
        return True
        
    def mock_trigger_recording():
        call_counts["trigger"] += 1
        return True
        
    def mock_stop_recording():
        call_counts["stop"] += 1
        return "mock_path.tif"

    monkeypatch.setattr(main.camera, "prepare_recording", mock_prepare_recording)
    monkeypatch.setattr(main.camera, "trigger_recording", mock_trigger_recording)
    monkeypatch.setattr(main.camera, "stop_recording", mock_stop_recording)

    # auto_record=True で開始
    with client:
        response = client.post(
            "/stage/sweep/run",
            json={"start_deg": 10.0, "end_deg": 80.0, "speed_deg_s": 15.0, "auto_record": True},
        )
        assert response.status_code == 200
        operation_id = response.json()["operation_id"]

        # 完了まで待機
        for _ in range(100):
            latest = client.get("/stage/sweep/progress", params={"operation_id": operation_id})
            if latest.json()["status"] == "succeeded":
                break
            time.sleep(0.1)
        else:
            raise AssertionError("sweep did not complete in time")

    # メソッドが期待通りに呼ばれたか検証
    assert call_counts["prepare"] == 1, "prepare_recording が1回呼ばれるべき"
    assert call_counts["trigger"] == 1, "trigger_recording が1回呼ばれるべき"
    assert call_counts["stop"] == 1, "stop_recording が1回呼ばれるべき"
