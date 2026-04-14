import logging
import sys
import os
from logging.handlers import TimedRotatingFileHandler
from collections import deque
from datetime import datetime

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
    logger.setLevel(logging.INFO)
    
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
    
    return logger

# シングルトンとしてloggerを作成し、他のモジュールから import logger で使えるようにする
logger = setup_logger()