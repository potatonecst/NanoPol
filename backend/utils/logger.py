import logging
import sys
import os
import json
from logging.handlers import TimedRotatingFileHandler
from collections import deque
from datetime import datetime
from pathlib import Path

# Rust(Tauri)側から渡された「OS標準の安全なアプリデータディレクトリ」を取得
app_data_dir = os.getenv("NANOPOL_APP_DATA_DIR")

if app_data_dir:
    # ビルド版、またはTauri経由で起動した場合は必ずこちらが使われます
    LOG_DIR = os.path.join(app_data_dir, "logs")
else:
    # 開発中にPython単体で直接実行した時などのための保険（フォールバック）
    if sys.platform == "win32":
        base = os.getenv("APPDATA")
        if not base:
            base = os.path.expanduser("~")
        LOG_DIR = os.path.join(base, "nanopol", "logs")
    else:
        LOG_DIR = os.path.join(os.path.expanduser("~"), ".nanopol", "logs")

os.makedirs(LOG_DIR, exist_ok=True)

# フロントエンド表示用バッファ（直近200行）
# deque（デック）はリングバッファとして機能し、maxlenを超えると古いものから自動的に削除されます。
log_buffer = deque(maxlen=200)

# カスタムログハンドラ: UI表示用にメモリ上のリスト（deque）にログを保存する
# logging.Handlerを継承して作成します。
class ListHandler(logging.Handler):
    def emit(self, record):
        try:
            # ログレコードオブジェクトから必要な情報を取り出し、
            # UI（JSON）で扱いやすい辞書形式に変換してバッファに追加します。
            log_entry = {
                "timestamp": datetime.fromtimestamp(record.created).strftime("%H:%M:%S"),
                "level": record.levelname,
                "message": record.getMessage(),
                "name": record.name,
            }
            log_buffer.append(log_entry)
        except Exception:
            self.handleError(record)

def setup_logger(name: str = "NanoPol"):
    logger = logging.getLogger(name)
    # ログレベル決定ポリシー:
    # 通常運用は INFO、障害調査時のみ DEBUG を有効化する。
    #
    # 優先順位 (上ほど優先):
    # 1) 環境変数 NANOPOL_LOG_LEVEL
    #    - 例: DEBUG / INFO / WARNING / ERROR
    #    - これは「外部から注入される値」であり、このファイル内では設定しない。
    #      具体的には、開発時のシェル、起動スクリプト、CI、またはTauri(Rust)側から設定される想定。
    # 2) <LOG_DIR>/logging_flags.json の内容方式フォールバック
    #    - debug_logging: true  -> DEBUG
    #    - debug_logging: false -> INFO
    # 3) 最終フォールバック
    #    - 設定読み込み失敗時は安全側で INFO
    log_level_name = os.getenv("NANOPOL_LOG_LEVEL", "").upper().strip()

    if not log_level_name:
        logging_flags_path = Path(LOG_DIR) / "logging_flags.json"
        default_flags = {"debug_logging": False}

        # 設定ファイルが無い場合は自動生成する。
        # これにより「ファイル名を忘れて再設定できない」運用上の詰まりを防ぐ。
        if not logging_flags_path.exists():
            try:
                logging_flags_path.write_text(
                    json.dumps(default_flags, ensure_ascii=True, indent=2) + "\n",
                    encoding="utf-8",
                )
            except Exception:
                # 設定ファイルが作れなくても、ログ自体は INFO で継続する
                pass

        try:
            # JSONの最小要件は「dictであること」。
            # それ以外（配列/文字列/壊れたJSON）は例外または無効値として INFO に倒す。
            flags = default_flags
            if logging_flags_path.exists():
                loaded = json.loads(logging_flags_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    flags = loaded

            debug_logging = bool(flags.get("debug_logging", False))
            log_level_name = "DEBUG" if debug_logging else "INFO"
        except Exception:
            # 設定ファイルが壊れている場合も安全側（INFO）で継続する
            log_level_name = "INFO"

    log_level = getattr(logging, log_level_name, logging.INFO)
    # 不正なレベル文字列（例: "VERBOSE"）は getattr の default で INFO へ収束させる。
    logger.setLevel(log_level)
    
    # 既にハンドラが設定されている場合は何もしない（二重追加防止）
    if logger.handlers:
        return logger
    
    #---formatter定義---
    # ファイル用: 日付入りで詳細に記録
    file_formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(module)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    
    # コンソール用: 開発者が見やすいようにシンプルに
    console_formatter = logging.Formatter(
        "[%(levelname)s] %(message)s",
    )
    
    # 1. コンソール出力ハンドラ (標準出力)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(console_formatter)
    logger.addHandler(console_handler)
    
    # 2. ファイル出力ハンドラ (日付ごとのローテーション付き)
    log_filename = os.path.join(LOG_DIR, "system.log")
    
    file_handler = TimedRotatingFileHandler(
        filename=log_filename,
        when="midnight", #毎日深夜0時に更新
        interval=1, #1日ごと
        backupCount=30, #過去30日分を保管
        encoding="utf-8",
    )
    
    # ローテーションされたファイル名に日付をつける（例: system.log.2025-12-22）
    file_handler.suffix = "%Y-%m-%d"
    file_handler.setFormatter(file_formatter)
    logger.addHandler(file_handler)
    
    # 3. UIバッファ出力ハンドラ
    list_handler = ListHandler()
    # UI側で自由に整形するため、ここではFormatterを通さずに辞書データをそのまま渡します
    logger.addHandler(list_handler)

    logger.info(f"[SYSTEM] Logger initialized (level={logging.getLevelName(log_level)})")
    
    return logger

# シングルトンとしてloggerを作成し、他のモジュールから import logger で使えるようにする
logger = setup_logger()