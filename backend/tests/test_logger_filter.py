import importlib.util
import logging
from pathlib import Path


def _load_logger_module(module_name: str, module_path: Path):
    # logger.py を通常の import ではなく、テスト用に独立したモジュールとして読み込む。
    # これにより、環境変数を差し替えたうえで副作用を最小化して確認できる。
    spec = importlib.util.spec_from_file_location(module_name, str(module_path))
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _make_access_record(method: str, path: str, status_code: int):
    # uvicorn.access の1行分を模した LogRecord を作る。
    # filter() が record.args をどう解釈するかを、そのまま再現するためのヘルパー。
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="%s %s %s",
        args=("127.0.0.1:12345", method, path, "1.1", status_code),
        exc_info=None,
    )


def test_suppress_system_logs_access_filter_blocks_successful_system_logs(tmp_path, monkeypatch):
    # 保存先を一時ディレクトリへ向け、実ユーザー環境へ影響しないようにする。
    monkeypatch.setenv("NANOPOL_APP_DATA_DIR", str(tmp_path))
    module_path = Path(__file__).resolve().parents[1] / "utils" / "logger.py"
    logger_module = _load_logger_module("nanopol_logger_test_module", module_path)
    filter_ = logger_module.SuppressSystemLogsAccessFilter()

    # 高頻度ポーリングAPIの成功系アクセスは落とす。
    assert filter_.filter(_make_access_record("GET", "/system/logs", 200)) is False
    assert filter_.filter(_make_access_record("POST", "/system/logs", 204)) is False
    assert filter_.filter(_make_access_record("GET", "/health", 200)) is False
    assert filter_.filter(_make_access_record("GET", "/stage/position", 200)) is False

    # 失敗系は残す。
    assert filter_.filter(_make_access_record("GET", "/system/logs", 500)) is True

    # それ以外のエンドポイントは従来どおり通す。
    assert filter_.filter(_make_access_record("GET", "/camera/connect", 200)) is True