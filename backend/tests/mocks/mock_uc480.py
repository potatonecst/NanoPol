"""
Mock uc480 モジュール。
実ハードウェアがない環境でテストするための簡易実装。

【このファイルの目的】
実ハードウェア（Thorlabs uc480 カメラ）の代わりに、テスト用の偽物を提供する。
conftest.py の fixture により、テスト中の "from pylablib.devices import uc480" は
このモックモジュールの内容を使用するようになる。

【含まれるもの】
- CameraInfo: カメラ情報を表すデータオブジェクト
- list_cameras(): 利用可能なカメラ一覧を返す関数
- UC480Camera: カメラハンドル（open/close/フレーム取得等の操作を提供するクラス）
"""

from typing import List, Any


class CameraInfo:
    """
    カメラ情報オブジェクト（list_cameras の戻り値用）。
    
    【役割】
    uc480.list_cameras() が返すカメラ情報を表現する。
    実装では単純な属性ホルダーだが、実ライブラリでもこのような構造を持つ。
    
    【属性】
    - cam_id: カメラのデバイスID（0, 1, 2, ... など）
    - name: カメラの表示名（UI表示用）
    """
    def __init__(self, cam_id: int, name: str = "MockCamera"):
        self.cam_id = cam_id
        self.name = name

    def __repr__(self):
        return f"CameraInfo(cam_id={self.cam_id}, name={self.name})"


def list_cameras() -> List[CameraInfo]:
    """
    利用可能なカメラを列挙する（モック版）。
    
    【戻り値】
    CameraInfo オブジェクトのリスト。
    モック版では常に1つのダミーカメラを返す。
    
    【実装】
    実ライブラリでは接続済みのカメラをスキャンして返すが、
    モック版では固定値を返すことで、テストを再現可能にしている。
    """
    return [CameraInfo(cam_id=0, name="MockCamera0")]


class UC480Camera:
    """
    モック UC480Camera クラス。
    実ハードウェアのカメラハンドルの代わりを務める。
    
    【役割】
    CameraController が実カメラと行う操作（open, close, フレーム取得, 設定変更）を
    最小限で再現する。テストが以下を確かめるのに使う：
    - CameraController が正しい API を呼んでいるか
    - エラーハンドリングが機能しているか
    - 設定の読み書きが動作するか
    
    【主要メソッド】
    - __init__: 初期化（実機と同じ引数を受ける）
    - is_opened: カメラがオープン状態か
    - close: カメラをクローズ
    - snap/read_frame: フレーム（画像）を取得（ダミーデータ返却）
    - get_exposure/set_exposure: 露出時間の読み書き
    - get_gain/set_gain: ゲイン（感度）の読み書き
    - with 文サポート: コンテキストマネージャーとして使用可能
    """
    
    def __init__(self, cam_id: int = 0, roi_binning_mode: str = "auto", 
                 dev_id: Any = None, backend: str = "uc480"):
        """
        初期化。実ライブラリと同じシグネチャ。
        
        Args:
            cam_id: カメラID（デフォルト0）。実ライブラリでは複数カメラを区別するのに使う
            roi_binning_mode: ROI/binning モード（'auto' 等）。ここでは保持するだけ
            dev_id: デバイスID（オプション、モック用なら無視）
            backend: バックエンド名（オプション、モック用なら無視）
        """
        self.cam_id = cam_id
        self.roi_binning_mode = roi_binning_mode
        self.dev_id = dev_id
        self.backend = backend
        
        # 内部状態
        self._opened = True  # 接続済みフラグ（初期値 True）
        self.width = 1280    # イメージセンサーの幅（ピクセル）
        self.height = 1024   # イメージセンサーの高さ（ピクセル）
        self.input_bpp = 16  # ビット深度（bits per pixel）：8 or 16 or 32 等
        
    def is_opened(self) -> bool:
        """
        カメラが開いているか（接続状態）を返す。
        
        【用途】
        CameraController が "カメラが本当に接続されているか" を確認するときに呼ぶ。
        """
        return self._opened
    
    def close(self):
        """
        カメラをクローズする。
        
        【処理】
        フラグを False にして、接続解除状態にする。
        
        【注意】
        実ハードウェアでは DLL レベルでリソースを解放するが、
        モック版は単にフラグを切るだけ。
        """
        self._opened = False
    
    def snap(self):
        """
        フレーム（画像）を取得する。
        
        【戻り値】
        numpy.ndarray（shape=(height, width), dtype=uint16）。
        モック版は全て 0 のダミー画像を返す。
        
        【実装例】
        実ライブラリでは、ここで CCD/CMOS センサーから1フレーム読み出す。
        
        【エラーハンドリング】
        is_opened() が False なら RuntimeError を挙げる（close 後にアクセスしたら失敗）。
        """
        if not self._opened:
            raise RuntimeError("Camera is not opened")
        # モック用ダミーフレーム（uint16, 1280x1024）
        import numpy as np
        return np.zeros((self.height, self.width), dtype=np.uint16)
    
    def read_frame(self):
        """
        フレームを読み出す（snap のエイリアス）。
        
        【用途】
        実ライブラリでは snap() と同じまたは同様の処理。
        ここでは単に snap() を呼ぶ。
        """
        return self.snap()
    
    def get_roi(self):
        """
        ROI（関心領域）情報を取得。
        
        【戻り値】
        dict：offset (y, x) とサイズ (height, width)。
        モック版は全センサーを返す。
        """
        return {"offset": (0, 0), "size": (self.width, self.height)}
    
    def get_frame_rate(self):
        """
        フレームレート（fps）を取得。
        
        【戻り値】
        float：フレーム/秒。モック版は固定値 30 fps。
        """
        return 30.0
    
    def get_exposure(self) -> float:
        """
        露出時間を取得（ミリ秒）。
        
        【用途】
        CameraController が現在の露出設定を確認するのに使う。
        """
        return 10.0
    
    def set_exposure(self, exposure_ms: float):
        """
        露出時間を設定（ミリ秒）。
        
        【用途】
        CameraController がユーザー設定に基づいて露出を変更するのに使う。
        
        【モック版の動作】
        実装は空（何もしない）。値が受け入れられるか、例外が挙がらないかを確認するのが目的。
        """
        pass
    
    def get_gain(self) -> float:
        """
        ゲイン（センサー感度）を取得（0～100）。
        
        【用途】
        CameraController が現在のゲイン設定を確認するのに使う。
        """
        return 50.0
    
    def set_gain(self, gain: float):
        """
        ゲイン（センサー感度）を設定（0～100）。
        
        【用途】
        CameraController がユーザー設定に基づいてゲインを変更するのに使う。
        
        【モック版の動作】
        実装は空（何もしない）。値が受け入れられるか、例外が挙がらないかを確認するのが目的。
        """
        pass
    
    def get_color_mode(self) -> str:
        """
        カラーモード取得。
        
        【戻り値】
        str：'mono' (モノクロ) や 'rgb' (RGB) など。
        モック版は常に 'mono' を返す。
        
        【用途】
        CameraController がセンサー種別を判断するのに使う。
        """
        return "mono"
    
    def __enter__(self):
        """
        with 文サポート（コンテキストマネージャー）。
        
        【用途】
        with UC480Camera(cam_id=0) as cam:
            # カメラ操作
        という文法が使える。
        
        【戻り値】
        self：自分自身を返す（with ブロック内で cam = self となる）。
        """
        return self
    
    def __exit__(self, *args):
        """
        with 文を抜けるときに自動で呼ばれる。
        
        【処理】
        close() を呼んでリソース解放。
        """
        self.close()
