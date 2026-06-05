"""
自動測定セッション管理 API の統合テスト

目的:
- `/measurement/sessions`, `/measurement/session`, `/measurement/session/settings` の
  API エンドポイントが期待通りに動作することを検証します。
- 保存先のディレクトリ作成、settings.json の生成、一覧取得の一連のフローを確認します。

実行方法:
pytest backend/tests/api/test_auto_measurement_session_http.py
"""

import os
import json
import shutil
import tempfile
from fastapi.testclient import TestClient
from pathlib import Path
import sys
import importlib.util
import pytest

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

@pytest.fixture
def temp_output_dir():
    """テスト用のテンポラリディレクトリを作成・削除するフィクスチャ。"""
    tmpdir = tempfile.mkdtemp(suffix="_nanopol_test")
    yield tmpdir
    if os.path.exists(tmpdir):
        shutil.rmtree(tmpdir)

def test_session_management_flow(temp_output_dir):
    """セッションの一覧取得、作成、設定読み込みの一連のフローをテストします。"""
    
    # 1. 保存先が未設定の状態での動作確認
    # (既存の camera.settings をクリアするか、初期状態を確認)
    main.camera.settings["outputDirectory"] = ""
    r = client.get("/measurement/sessions")
    assert r.status_code == 200
    assert r.json()["sessions"] == []

    # 2. 保存先を設定
    main.camera.settings["outputDirectory"] = temp_output_dir

    # 3. 新規セッションの作成 (名前指定なし -> Sample_1)
    payload = {"sample_name": ""}
    r = client.post("/measurement/session", json=payload)
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "success"
    assert data["sample_name"] == "Sample_1"
    folder_path = data["folder_path"]
    assert os.path.exists(folder_path)
    assert os.path.exists(os.path.join(folder_path, "settings.json"))

    # 4. 新規セッションの作成 (名前指定あり)
    payload = {"sample_name": "MyExperiment"}
    r = client.post("/measurement/session", json=payload)
    assert r.status_code == 200
    assert r.json()["sample_name"] == "MyExperiment"

    # 5. セッション一覧の取得
    r = client.get("/measurement/sessions")
    assert r.status_code == 200
    sessions = r.json()["sessions"]
    # get_today_sessions は sorted されているはずなので ["MyExperiment", "Sample_1"]
    assert "Sample_1" in sessions
    assert "MyExperiment" in sessions
    assert len(sessions) == 2

    # 6. セッション設定の読み込み
    r = client.get(f"/measurement/session/settings?folder_path={folder_path}")
    assert r.status_code == 200
    settings = r.json()
    assert settings["sample_name"] == "Sample_1"
    assert "measurements" in settings
    assert isinstance(settings["measurements"], list)

def test_session_settings_not_found():
    """存在しないフォルダを指定した場合に 404 が返ることを確認します。"""
    invalid_path = "/non/existent/path/to/session"
    r = client.get(f"/measurement/session/settings?folder_path={invalid_path}")
    assert r.status_code == 404

def test_create_session_without_output_dir():
    """保存先が設定されていない状態で作成を試みると 400 が返ることを確認します。"""
    main.camera.settings["outputDirectory"] = ""
    payload = {"sample_name": "Test"}
    r = client.post("/measurement/session", json=payload)
    assert r.status_code == 400
    assert "Output directory is not configured" in r.json()["detail"]

def test_read_corrupted_session_settings(temp_output_dir):
    """settings.json が破損している場合に 500 が返ることを確認します。"""
    # 1. 正常なセッションを作成
    main.camera.settings["outputDirectory"] = temp_output_dir
    payload = {"sample_name": "CorruptedTest"}
    r = client.post("/measurement/session", json=payload)
    folder_path = r.json()["folder_path"]
    
    # 2. settings.json を意図的に壊す（不正なJSONにする）
    settings_path = os.path.join(folder_path, "settings.json")
    with open(settings_path, "w", encoding="utf-8") as f:
        f.write("{ invalid_json: [ }")
        
    # 3. 読み込みを試みて 500 が返るか確認
    r = client.get(f"/measurement/session/settings?folder_path={folder_path}")
    assert r.status_code == 500
    assert "settings.json is corrupted" in r.json()["detail"]
