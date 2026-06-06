import os
import json
import glob
from datetime import datetime, timezone

# ============================================================================
# DataSaver モジュール (Auto Measurement 基盤)
# 
# 自動測定（Auto Mode）におけるデータ保存の基盤を提供するユーティリティです。
# ユーザーが指定した保存先（outputDirectory）の配下に、
# 「AutoMeasurementData/YYYYMMDD/Sample_X/」という構造でフォルダを作成し、
# 測定の進行状況（settings.json）や個別の測定データ（枝番フォルダ）を管理します。
# 
# 【設計思想】
# 1. 生データ主義: 測定時の設定、ROI、結果、画像パスを一元管理する settings.json を中核とします。
# 2. 非破壊 Redo: 同じ測定をやり直しても過去のデータを上書きせず、枝番で管理します。
# 3. 疎結合: 保存先の絶対パスを決め打ちせず、実行時に渡される output_dir を基準に動的に生成します。
# ============================================================================

def get_base_dir(output_dir: str) -> str:
    """
    自動測定データのルートディレクトリパスを生成して返します。

    解説:
        ユーザーが設定画面で指定した任意の保存先（例: "D:\\Data"）の中に、
        本アプリ専用の "AutoMeasurementData" というフォルダを設けることで、
        他のファイルと混ざるのを防ぎます。

    引数:
        output_dir (str): ユーザーが設定画面で指定した大元の保存先パス（例: "D:\\Data"）

    戻り値:
        str: "D:\\Data\\AutoMeasurementData" のようなパス文字列

    使用している標準ライブラリ:
        os.path.join(A, B): 
            AとBのパスを、OSに合わせた正しい区切り文字（Windowsなら \、Macなら /）
            で安全に結合してくれます。文字列の足し算（A + "/" + B）を使うよりも
            バグが起きにくい標準的な書き方です。
    """
    return os.path.join(output_dir, "AutoMeasurementData")

def get_date_dir(base_dir: str, date_str: str | None = None) -> str:
    """
    指定された日付（YYYYMMDD形式）のフォルダパスを生成します。
    引数が None の場合は、現在の日付（今日）を使用します。

    解説:
        「過去のデータを見たい」というリクエストと「今日のデータを保存したい」
        というリクエストの両方に対応するための共通部品です。
    """
    if date_str is None:
        date_str = datetime.now().strftime("%Y%m%d")
    return os.path.join(base_dir, date_str)

def get_today_dir(base_dir: str) -> str:
    """
    今日（実行当日）の測定データを保存するための日付フォルダパスを生成します。
    """
    return get_date_dir(base_dir, None)

def get_sessions(output_dir: str, date_str: str | None = None) -> list[str]:
    """
    指定された日付フォルダ内にある既存のサンプル（セッション）名のリストを取得します。
    date_str が None の場合は、自動的に今日の日付を対象にします。

    ロジックの解説:
        1. 指定された日付、または今日の日付フォルダを特定します。
        2. フォルダ内の各項目を走査し、「フォルダである」かつ「settings.jsonがある」
           ものだけを有効なセッションとして抽出します。

    引数:
        output_dir (str): 大元の保存先パス
        date_str (str | None): 対象の日付文字列 (例: "20260601")。None なら今日。

    戻り値:
        list[str]: 有効なサンプル名のリスト
    """
    base_dir = get_base_dir(output_dir)
    target_dir = get_date_dir(base_dir, date_str)
    
    if not os.path.exists(target_dir):
        # 指定された日付のフォルダがまだ作られていなければ空リストを返します。
        return []
    
    sessions = []
    for entry in os.listdir(target_dir):
        full_path = os.path.join(target_dir, entry)
        # 有効なセッションフォルダかどうかの厳密なチェック（settings.jsonの存在確認）
        if os.path.isdir(full_path) and os.path.exists(os.path.join(full_path, "settings.json")):
            sessions.append(entry)
            
    return sorted(sessions)

def get_today_sessions(output_dir: str) -> list[str]:
    """
    【後方互換用】今日の日付フォルダ内のセッション一覧を取得します。
    """
    return get_sessions(output_dir, None)

def create_new_session(output_dir: str, requested_name: str = "") -> dict:
    """
    新しいサンプルのためのフォルダと初期 settings.json を作成します。
    名前が指定されていない場合は「Sample_1」などの連番を自動で採番します。

    解説:
        ユーザーが名前を空にした場合、「Sample_1」から順に空き番号を探します。
        もしユーザーが「Sample_1」を自分で作った後に、また名前を空にして作成ボタンを押したとしても、
        この関数は賢く「Sample_2」を提案します。

    引数:
        output_dir: 大元の保存先パス
        requested_name: ユーザーが入力した希望のサンプル名（空の場合は自動採番）

    戻り値:
        dict: 作成されたセッションの情報（sample_name と folder_path）
    """
    today_dir = get_today_dir(get_base_dir(output_dir))
    
    # ユーザーから特定の名前が指定されていない場合の「自動採番」ロジック
    if not requested_name or requested_name.strip() == "":
        counter = 1
        while True:
            candidate = f"Sample_{counter}"
            # その名前のフォルダが既に存在するかチェック
            if not os.path.exists(os.path.join(today_dir, candidate)):
                # 存在しなければ、その名前に決定してループを抜ける
                sample_name = candidate
                break
            counter += 1
    else:
        # ユーザー指定の名前がある場合でも、上書き事故を防ぐために重複チェックを行います。
        # すでに存在する名前なら "SampleName_2" のように枝番を付けます。
        sample_name = requested_name.strip()
        counter = 1
        base_name = sample_name
        while os.path.exists(os.path.join(today_dir, sample_name)):
            counter += 1
            sample_name = f"{base_name}_{counter}"

    # 最終的に決まった名前で、サンプルのフルパスを生成
    sample_dir = os.path.join(today_dir, sample_name)
    
    # 使用している標準ライブラリ:
    # os.makedirs(path, exist_ok=True): 
    #   指定したフォルダを作成します。親フォルダ（AutoMeasurementData等）が存在しない場合でも、
    #   再帰的に（一緒に）作ってくれます。exist_ok=True にしておくと、既に存在していてもエラーになりません。
    os.makedirs(sample_dir, exist_ok=True)
    
    # settings.json の初期データを作成（実験ノートの真っ白な1ページ目）
    settings_data = {
        "app_version": "0.1.0",
        "sample_name": sample_name,
        # ISO 8601 形式のUTC時間（Z付き）で記録するのが最も安全なタイムスタンプの作法です。
        # どの国の解析者が開いても時間が狂わない、国際的な標準形式です。
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "measurements": [] # まだ1回も測定していないので空リスト
    }
    
    settings_path = os.path.join(sample_dir, "settings.json")
    
    # 使用している標準ライブラリ:
    # open(path, "w", encoding="utf-8"): ファイルを書き込みモード("w")で開きます。
    #   encoding="utf-8" を明示することで、日本語のサンプル名が含まれても文字化けしません。
    # json.dump(data, file, indent=2): 辞書データ(data)をJSON形式の文字列に変換し、ファイルに書き込みます。
    #   indent=2 を指定することで、人間がテキストエディタで開いた時に読みやすいように改行と空白が入ります。
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings_data, f, indent=2, ensure_ascii=False)
        
    return {
        "sample_name": sample_name,
        "folder_path": sample_dir
    }

def read_session_settings(sample_dir: str) -> dict:
    """
    指定されたサンプルフォルダ内にある settings.json を読み込んで返します。

    引数:
        sample_dir (str): サンプルのベースフォルダ

    戻り値:
        dict: 読み込まれた設定データの辞書

    使用している標準ライブラリ:
        json.load(file): ファイルに書かれているJSON文字列を読み込み、Pythonの辞書(dict)に変換します。
    """
    settings_path = os.path.join(sample_dir, "settings.json")
    if not os.path.exists(settings_path):
        raise FileNotFoundError(f"settings.json not found in {sample_dir}")
        
    with open(settings_path, "r", encoding="utf-8") as f:
        return json.load(f)

def generate_measurement_branch(sample_dir: str, step_category: str) -> tuple[str, str]:
    """
    やり直し（非破壊Redo）のための「新しい枝番」を持つ測定IDとフォルダパスを生成します。

    解説:
        「Left_Front」という条件で測定して、もし飽和していた場合、
        ユーザーは条件（露光など）を変えてもう一度測定したいはずです。
        その際、前のデータを消さずに `Left_Front_001`, `Left_Front_002` と
        自動で分けることで、実験の全履歴を残します。

    引数:
        sample_dir (str): サンプルのベースフォルダ (例: D:\\Data\\...\\Sample_1)
        step_category (str): 測定のカテゴリ (例: "Left_Front")

    戻り値:
        tuple[str, str]: (発行された枝番付きID, そのID用の新しいフォルダのフルパス)
                         例: ("1_Left_Front_002", "D:\\...\\Sample_1\\1_Left_Front_002")
    """
    # 枝番を見つけるロジック
    counter = 1
    while True:
        # 3桁のゼロ埋め文字列を作成します（1 -> "001", 2 -> "002"）
        branch_id = f"{counter:03d}"
        
        # カテゴリが "Left_Front" なら、"Left_Front_001" のようなIDを作ります。
        measurement_id = f"{step_category}_{branch_id}"
        measurement_dir = os.path.join(sample_dir, measurement_id)
        
        # もしその名前のフォルダが存在しなければ、それを新しい枝番として採用します。
        if not os.path.exists(measurement_dir):
            # 新しいフォルダを作成（images や prescan などの子フォルダは後で作成します）
            os.makedirs(measurement_dir, exist_ok=True)
            return measurement_id, measurement_dir
            
        counter += 1

def append_measurement_history(sample_dir: str, history_entry: dict):
    """
    1回の測定が終了（または中断）した際に、その結果を settings.json の履歴に追記します。
    
    引数:
        sample_dir (str): サンプルのフォルダ
        history_entry (dict): 追記したい1回分の結果データ
            例: {"id": "1_Left_Front_001", "step_category": "1_Left_Front", "status": "completed", ...}

    ロジックの解説:
        1. ファイルを読み込む
        2. メモリ上のリストに append する
        3. ファイルを上書き保存する
        
        将来的に巨大なファイルになる場合は「追記（append）モード」でのファイル操作を検討しますが、
        自動測定の履歴（数件〜数十件）程度であれば、この「読み込んで書き戻す」方式が
        JSONの整合性を保つ上で最も安全です。
    """
    settings_path = os.path.join(sample_dir, "settings.json")
    
    # 既存のデータを読み込む
    with open(settings_path, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    # measurements 配列の末尾に新しい履歴を追加する
    # setdefault(key, default) は、キーが存在しなければ default をセットしてから返します。
    data.setdefault("measurements", []).append(history_entry)
    
    # データを上書き保存する
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
