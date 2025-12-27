import logging
import sys
import os
from logging.handlers import TimedRotatingFileHandler
from collections import deque
from datetime import datetime

#ログ保存用ディレクトリ
LOG_DIR = "logs"
os.makedirs(LOG_DIR, exist_ok=True)

#フロントエンド表示用バッファ（直近200行）
log_buffer = deque(maxlen=200)

#UI表示用にメモリ上のリスト（deque）にログを保存するハンドラ
class ListHandler(logging.Handler):
    def emit(self, record):
        try:
            #ログレコードをUIで扱いやすい辞書形式に変換
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
    
    #handlerが二重に追加されないようにチェック
    if logging.handlers:
        return logger
    
    #---formatter定義---
    #ファイル用: 日付入りで詳細に
    file_formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(module)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    
    #コンソール用: シンプルに
    console_formatter = logging.Formatter(
        "[%(levelname)s] %(message)s",
    )
    
    #コンソール出力(標準出力)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(console_formatter)
    logger.addHandler(console_handler)
    
    #ファイル出力(日付ごとのローテーション)
    log_filename = os.path.join(LOG_DIR, "system.log")
    
    file_handler = TimedRotatingFileHandler(
        filename=log_filename,
        when="midnight", #毎日深夜0時に更新
        interval=1, #1日ごと
        backupCount=30, #過去30日分を保管
        encoding="utf-8",
    )
    
    #ローテーションされたファイルには日付がつく（system.log.2025-12-22）
    file_handler.suffix = "%Y-%m-%d"
    file_handler.setFormatter(file_formatter)
    logger.addHandler(file_handler)
    
    #UIバッファ表示
    list_handler = ListHandler()
    #UIは整形前のデータを渡すため、formatterは設定しない
    logger.addHandler(list_handler)
    
    return logger

#シングルトンとしてloggerを作成
logger = setup_logger()