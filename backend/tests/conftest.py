"""
pytest の conftest.py。
モック uc480 を全テストに自動適用するフィクスチャを定義。

【ファイルの役割】
- conftest.py は pytest の特別ファイル：このディレクトリ以下の全テストで自動的に読み込まれる
- ここで定義した fixture は、テスト関数の引数として利用可能（autouse=True なら明記なしで全テストに適用）
- テスト実行環境の初期化（セットアップ）と終了時処理（ティアダウン）をここで一元管理
"""

import pytest
import sys
from pathlib import Path

# tests ディレクトリの親（backend）を sys.path に追加
# 目的：テストコード内で "from devices.camera_controller import ..." 等ができるようにする
# backend ディレクトリの内容にアクセスが可能になる
backend_path = Path(__file__).parent.parent
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))


@pytest.fixture(autouse=True)
def mock_uc480(monkeypatch):
    """
    全テストに自動適用：pylablib.devices.uc480 をモックに差し替える。
    
    【何をしているか】
    テスト実行時に、実際の uc480 ライブラリの代わりに、tests/mocks/mock_uc480.py で定義した
    偽物のモジュール（UC480Camera クラスや list_cameras() 関数）を使用するように設定する。
    
    【なぜそうするのか】
    - 実ハードウェア（カメラ）がない環境（macOS開発環境など）でテストできるようにするため
    - DLL ファイルがない環境でも実行できるようにするため
    - テスト実行を高速化するため（実ハードウェアI/O を避ける）
    
    【処理の流れ】
    1. monkeypatch.setattr() で、既に読み込まれた pylablib.devices.uc480 属性を差し替え
    2. sys.modules に直接登録することで、今後 import される場合もモックが返るようにする
    3. yield でテスト実行を許す
    4. テスト終了後、自動的にクリーンアップ処理（現在は特に必要なし）
    """
    from tests.mocks import mock_uc480 as mock_module
    
    # 安全に差し替え処理を行う
    import importlib

    # 親モジュールを事前に import しておく（存在しない場合は無視）
    try:
        importlib.import_module("pylablib.devices")
    except Exception:
        pass

    parent_mod = sys.modules.get("pylablib.devices")
    if parent_mod is not None:
        # 親モジュールがロード済みなら属性として差し替える（raising=False で存在しなくてもOK）
        monkeypatch.setattr(parent_mod, "uc480", mock_module, raising=False)

    # sys.modules にも明示的に登録して、今後の import をカバー
    sys.modules["pylablib.devices.uc480"] = mock_module
    
    # yield の前がセットアップ、後がティアダウン
    yield
    
    # テスト終了後のクリーンアップ処理
    # 現在は特に必要ないが、リソースをホールドしている場合はここで明示的に解放する


@pytest.fixture
def mock_camera_info():
    """
    CameraInfo オブジェクトを生成するファクトリー・フィクスチャ。
    テストで複数のカメラ情報を異なるパラメータで生成する場合に使用。
    
    【使用例】
    def test_something(mock_camera_info):
        cam1 = mock_camera_info(cam_id=0, name="Camera0")
        cam2 = mock_camera_info(cam_id=1, name="Camera1")
        # cam1, cam2 を使ってテストを進める
    
    【なぜファクトリーなのか】
    単に CameraInfo を返すのではなく、引数を受け取る関数を返すことで、
    テスト側で必要なパラメータをカスタマイズして生成できるようにするため
    """
    from tests.mocks.mock_uc480 import CameraInfo
    
    def _make_camera_info(cam_id: int = 0, name: str = "MockCamera"):
        """
        CameraInfo オブジェクトのファクトリー関数。
        
        Args:
            cam_id (int): カメラのデバイスID（デフォルト 0）
            name (str): カメラの表示名（デフォルト "MockCamera"）
        
        Returns:
            CameraInfo: 指定パラメータで初期化されたカメラ情報オブジェクト
        """
        return CameraInfo(cam_id=cam_id, name=name)
    
    return _make_camera_info
