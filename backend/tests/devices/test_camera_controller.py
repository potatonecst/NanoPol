"""
camera_controller.py の単体テスト（モック環境）。

【このテストの目的】
CameraController の主要な機能が正しく動作するか、API互換性が保たれているか、
エラー処理が適切かを確かめる。実ハードウェアなしで、モック uc480 を使用。

【テストの分類】
1. TestCameraControllerBasics: 初期化、列挙、接続/切断の基本機能
2. TestCameraControllerImageProcessing: 画像処理関連メソッドの存在確認
3. TestCameraControllerAPI: 必須メソッドの API 互換性確認

【各テストでアサートしている内容】
- 初期状態が正しいか（未接続、0 サイズ等）
- メソッドが正しい型を返しているか
- 例外処理が適切か（二重接続等）
- 必須メソッドが存在するか
"""

import pytest
import os
import sys
from pathlib import Path

# backend ディレクトリを sys.path に追加（import 用）
backend_path = Path(__file__).parent.parent
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))


def _load_camera_controller_class():
    """
    devices/camera_controller.py をファイルパスから直接読み込み、
    `CameraController` クラスを返すヘルパー。

    目的：テスト実行時の import パスの問題を回避するため、
    明示的にファイルからモジュールをロードする。
    """
    import importlib.util

    module_path = Path(__file__).parents[2] / "devices" / "camera_controller.py"
    spec = importlib.util.spec_from_file_location("devices.camera_controller", str(module_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CameraController


class TestCameraControllerBasics:
    """CameraController の基本機能テスト"""
    
    def test_camera_controller_initialization(self):
        """
        カメラコントローラーの初期化テスト。
        
        【テスト内容】
        CameraController のコンストラクタを呼んだ直後の状態を確認。
        
        【確認項目】
        1. camera 属性が None か（未接続状態）
        2. is_connected フラグが False か（未接続）
        3. width が 0 か（サイズ未決定）
        4. height が 0 か（サイズ未決定）
        
        【なぜこのテストが必要か】
        初期状態が不正だと、後の接続処理や画像取得でバグになる可能性がある。
        """
        CameraController = _load_camera_controller_class()
        
        controller = CameraController()
        
        # 初期状態の確認
        # 初期状態の期待値: 未接続かつサイズ未設定
        assert controller.camera is None, "初期状態では camera オブジェクトが None であるべき"
        assert controller.is_connected is False, "初期状態では is_connected が False であるべき"
        assert controller.width == 0, "初期状態では width が 0 であるべき"
        assert controller.height == 0, "初期状態では height が 0 であるべき"
    
    def test_get_available_cameras_mock(self):
        """
        get_available_cameras() がモック list_cameras を正しく使うテスト。
        
        【テスト内容】
        CameraController.get_available_cameras() を呼び、モック uc480 の list_cameras()
        から取得したカメラ情報が正しくフォーマットされているか確認。
        
        【確認項目】
        1. 戻り値が list か
        2. list が空でないか
        3. 各要素が dict か
        4. 各要素が "id" キーを持つか
        5. 各要素が "name" キーを持つか
        
        【なぜこのテストが必要か】
        CameraController は uc480.list_cameras() の戻り値を dict にフォーマットして返す。
        そのフォーマット処理が正しいことを確認しておかないと、
        フロントエンドが期待する JSON 形式にならない。
        """
        CameraController = _load_camera_controller_class()
        
        controller = CameraController()
        
        # get_available_cameras() を呼ぶ
        cameras = controller.get_available_cameras()
        
        # 戻り値の型チェック: リストであること（フロントは配列を期待する）
        assert isinstance(cameras, list), \
            "get_available_cameras() は list を返すべき"
        
        # モック環境の想定: 少なくとも1台はダミー情報を返す
        assert len(cameras) > 0, \
            "get_available_cameras() は1つ以上のカメラを返すべき"
        
        # 各エントリの構造チェック: dict で `id` と `name` を持つこと
        for cam in cameras:
            assert isinstance(cam, dict), \
                "各カメラ情報は dict であるべき"
            assert "id" in cam, \
                "各カメラ情報は 'id' キーを持つべき"
            assert "name" in cam, \
                "各カメラ情報は 'name' キーを持つべき"
    
    def test_connect_mock_mode(self):
        """
        connect() が Mock モード（macOS）で動作するテスト。
        
        【テスト内容】
        CameraController.connect(camera_id=0) を呼んで、Mock モード（macOS環境）での
        接続初期化が成功し、内部状態が正しく設定されるか確認。
        
        【確認項目】
        1. is_mock_env が True か（macOS 環境）
        2. connect() が True を返すか（成功）
        3. is_connected フラグが立つか
        4. width と height が設定されているか（0 より大きい）
        5. sensor_type が設定されているか（None でない）
        
        【なぜこのテストが必要か】
        CameraController は Mock モード（実ハードウェアなし）と実機モードで異なる処理をする。
        Mock モード での初期化が正しく機能することを確認しておく必要がある。
        """
        CameraController = _load_camera_controller_class()
        
        controller = CameraController()
        
        # テスト環境の前提確認: モックモードであること
        assert controller.is_mock_env is True, \
            "テスト環境（macOS）では is_mock_env が True であるべき"
        
        # connect() の呼び出しと戻り値の確認（Mock 環境では True）
        result = controller.connect(camera_id=0)
        assert result is True, \
            "Mock モードでの connect() は True を返すべき"
        
        # 内部状態: 接続フラグが立つこと
        assert controller.is_connected is True, \
            "connect() 成功後は is_connected が True であるべき"
        
        # 画像サイズが設定される（モックでもデフォルトサイズが割り当てられる）
        assert controller.width > 0, \
            "connect() 後は width が設定されているべき（0より大きい）"
        assert controller.height > 0, \
            "connect() 後は height が設定されているべき（0より大きい）"
        
        # センサー種別などメタ情報が設定されていること
        assert controller.sensor_type is not None, \
            "connect() 後は sensor_type が設定されているべき（None でない）"
    
    def test_disconnect_mock(self):
        """
        disconnect() がリソースを適切に解放するテスト。
        
        【テスト内容】
        カメラを接続 → 切断 → フラグが正しく解除されるか確認。
        
        【確認項目】
        1. connect() 後は is_connected が True
        2. disconnect() 後は is_connected が False
        
        【なぜこのテストが必要か】
        disconnect() がちゃんと動作しないと、複数のテストが影響を受けたり、
        カメラリソースが解放されずリークする可能性がある。
        """
        CameraController = _load_camera_controller_class()
        
        controller = CameraController()
        
        # 前準備: 接続してから切断を試す
        controller.connect(camera_id=0)
        assert controller.is_connected is True, \
            "connect() 直後は is_connected が True であるべき"
        
        # 切断を実行し、内部フラグが解除されることを確認
        controller.disconnect()
        assert controller.is_connected is False, \
            "disconnect() 後は is_connected が False であるべき"
    
    def test_double_connect_idempotent(self):
        """
        二重 connect() が安全に処理されるテスト。
        
        【テスト内容】
        既に接続済みの状態で connect() を再度呼んでも、エラーにならず
        成功を返すか確認（idempotent な動作）。
        
        【確認項目】
        1. 1回目の connect() が True を返す
        2. 2回目の connect() も True を返す（エラーでない）
        3. 接続フラグが True のまま維持される
        
        【なぜこのテストが必要か】
        フロントエンドが誤って二重に connect() を呼ぶ可能性がある。
        その場合にクラッシュしてはいけない。
        connect() の実装で "既に接続済みならそのまま成功扱いで返す" という
        防御的プログラミングがなされているか確認。
        """
        CameraController = _load_camera_controller_class()
        
        controller = CameraController()
        
        # 二重接続の idempotency 確認: どちらも成功で、フラグは True のまま
        result1 = controller.connect(camera_id=0)
        assert result1 is True, \
            "1回目の connect() は True を返すべき"

        result2 = controller.connect(camera_id=0)
        assert result2 is True, \
            "2回目の connect()（既接続時）も True を返すべき（idempotent）"

        assert controller.is_connected is True, \
            "二重 connect() 後も is_connected が True であるべき"


class TestCameraControllerImageProcessing:
    """カメラ画像処理関連のテスト"""
    
    def test_get_raw_frame_preserves_type(self):
        """
        _get_raw_frame メソッドが、入力されたビット深度に応じて
        適切なデータ型を維持し、値の加工を行わないことを確認するテスト。
        
        【テスト内容】
        1. src_bpp = 8 の場合、入力が float 等でも uint8 に変換されるか
        2. src_bpp = 10 の場合、uint16 として保持されるか
        3. src_bpp = 16 の場合、uint16 として保持されるか
        
        【なぜこのテストが必要か】
        定量的な光学測定において、カメラから受信した生のカウント値を
        スケーリング（水増し）せずにそのまま保存・解析することが必須なため。
        """
        CameraController = _load_camera_controller_class()
        controller = CameraController()
        
        import numpy as np
        
        # 1. 8-bit の場合
        frame_8 = np.array([[0, 128, 255]], dtype=np.float32)
        raw_8 = controller._get_raw_frame(frame_8, src_bpp=8)
        assert raw_8.dtype == np.uint8
        assert raw_8[0][1] == 128
        
        # 2. 10-bit の場合
        frame_10 = np.array([[0, 512, 1023]], dtype=np.float32)
        raw_10 = controller._get_raw_frame(frame_10, src_bpp=10)
        assert raw_10.dtype == np.uint16
        assert raw_10[0][2] == 1023  # 値がスケーリング（*64など）されていないことを確認
        
        # 3. 16-bit の場合
        frame_16 = np.array([[0, 32768, 65535]], dtype=np.float32)
        raw_16 = controller._get_raw_frame(frame_16, src_bpp=16)
        assert raw_16.dtype == np.uint16
        assert raw_16[0][1] == 32768
    
    def test_bayer_color_conversion_code_exists(self):
        """
        _get_bayer_color_conversion_code メソッドが存在するテスト。
        
        【テスト内容】
        CameraController に、Bayer パターン（RGB フィルター配置）を
        OpenCV の色変換コードに変換するメソッドが存在するか確認。
        
        【確認項目】
        1. メソッドが存在するか（hasattr）
        2. callable か（関数/メソッドか）
        
        【なぜこのテストが必要か】
        画像取得時に Bayer パターンのセンサーデータを RGB に変換する処理が必要。
        そのメソッドが確実に存在することを早期に確認しておく。
        """
        CameraController = _load_camera_controller_class()
        
        controller = CameraController()
        
        # メソッドが存在すること
        assert hasattr(controller, "_get_bayer_color_conversion_code"), \
            "CameraController は _get_bayer_color_conversion_code メソッドを持つべき"
        assert callable(controller._get_bayer_color_conversion_code), \
            "_get_bayer_color_conversion_code は callable（関数/メソッド）であるべき"
    
    def test_grab_image_from_hardware_or_mock_exists(self):
        """
        _grab_image_from_hardware_or_mock メソッドが存在するテスト。
        
        【テスト内容】
        CameraController に、実ハードウェアまたはモックから画像フレームを
        取得するメソッドが存在するか確認。
        
        【確認項目】
        1. メソッドが存在するか（hasattr）
        2. callable か（関数/メソッドか）
        
        【なぜこのテストが必要か】
        キャプチャスレッドやスナップショット機能でこのメソッドが呼ばれる。
        確実に存在することを確認しておく。
        """
        CameraController = _load_camera_controller_class()
        
        controller = CameraController()
        
        # メソッドが存在すること
        assert hasattr(controller, "_grab_image_from_hardware_or_mock"), \
            "CameraController は _grab_image_from_hardware_or_mock メソッドを持つべき"
        assert callable(controller._grab_image_from_hardware_or_mock), \
            "_grab_image_from_hardware_or_mock は callable（関数/メソッド）であるべき"


class TestCameraControllerExposureGain:
    """CameraController の露出・ゲイン設定テスト"""
    
    def test_set_and_get_exposure_roundtrip(self):
        """
        set_exposure(ms) で設定した値を get_exposure() で取得できるかテスト。
        
        【テスト内容】
        Mock 環境で、exposure の setter/getter の相互運用性を確認。
        
        【確認項目】
        1. set_exposure(10.5) を実行
        2. get_exposure() が 10.5 を返すか
        
        【なぜこのテストが必要か】
        フロントエンドがカメラの露出時間を設定・確認するAPI。
        もし set/get に不整合があると、UI が一貫性を失う。
        """
        CameraController = _load_camera_controller_class()
        
        controller = CameraController()
        controller.connect()
        
        # 露出時間を設定してから取得
        test_exposure = 10.5
        controller.set_exposure(test_exposure)
        retrieved_exposure = controller.get_exposure()
        
        assert retrieved_exposure == test_exposure, \
            f"set_exposure({test_exposure}) 後に get_exposure() は {test_exposure} を返すべき、" \
            f"実際には {retrieved_exposure}"
    
    def test_set_and_get_gain_roundtrip(self):
        """
        set_gain(val) で設定した値を get_gain() で取得できるかテスト。
        
        【テスト内容】
        Mock 環境で、gain の setter/getter の相互運用性を確認。
        
        【確認項目】
        1. set_gain(50.0) を実行
        2. get_gain() が 50.0 を返すか
        
        【なぜこのテストが必要か】
        フロントエンドがカメラのゲインを設定・確認するAPI。
        もし set/get に不整合があると、UI が一貫性を失う。
        """
        CameraController = _load_camera_controller_class()
        
        controller = CameraController()
        controller.connect()
        
        # モック環境ではハードウェアのレンジに制約があるため、
        # 実際に適用可能な範囲を問い合わせて、その範囲内の値を設定して検証する。
        if hasattr(controller, "get_gain_range"):
            gmin, gmax = controller.get_gain_range()
            # レンジの中央をテスト値にする（安全な値を選択）
            test_gain = (gmin + gmax) / 2.0
        else:
            # get_gain_range が無ければ従来の固定値を使用（互換措置）
            test_gain = 1.0

        controller.set_gain(test_gain)
        retrieved_gain = controller.get_gain()

        # 浮動小数点誤差を考慮して近似比較
        assert abs(retrieved_gain - test_gain) < 1e-6, \
            f"set_gain({test_gain}) 後に get_gain() は {test_gain} を返すべき、実際には {retrieved_gain}"


class TestCameraControllerSnapshot:
    """CameraController の画像キャプチャテスト"""
    
    def test_take_snapshot_returns_value_or_none(self):
        """
        take_snapshot() がメソッドとして動作するか確認。
        
        【テスト内容】
        Mock 環境で、take_snapshot() を呼び出し、戻り値の型を確認。
        
        【確認項目】
        1. メソッドが存在して callable
        2. 呼び出し結果が str または None のいずれか（パス or 保存なし）
        
        【なぜこのテストが必要か】
        フロントエンドから呼ばれるコア API。メソッドが存在し、
        正しい型を返すことを確認することで、統合時の問題を減らせる。
        
        【注記】
        Mock 環境では実ファイルは保存されない（ファイルシステム差がある）。
        実機との挙動差は `GET /camera/diagnostics` で別途検証する想定。
        """
        CameraController = _load_camera_controller_class()
        
        controller = CameraController()
        controller.connect()
        
        # take_snapshot() を呼ぶ
        result = controller.take_snapshot()
        
        # 戻り値の型チェック（str: ファイルパス、または None: 保存なし）
        assert isinstance(result, (str, type(None))), \
            f"take_snapshot() は str または None を返すべき、実際は {type(result)}"

    def test_take_snapshot_auto_saves_file(self, tmp_path):
        """自動保存モードでスナップショットがディスクに書き出されることを確認する"""
        CameraController = _load_camera_controller_class()
        controller = CameraController()
        controller.connect()

        # テスト用に outputDirectory を tmp_path に設定
        controller.settings["outputDirectory"] = str(tmp_path)
        controller.settings["imageFormat"] = "PNG"  # cv2.imwrite を使うようにする
        controller.settings["askSavePath"] = False

        # フレームを用意（8bit 画像）
        import numpy as np
        controller.latest_frame = np.full((10, 10), 123, dtype=np.uint8)

        result = controller.take_snapshot()
        assert isinstance(result, str), "自動保存モードではファイルパスが返るはず"
        assert os.path.exists(result), f"スナップショットファイルが存在しない: {result}"
        # 保存先が snapshots/ サブディレクトリであることを確認
        assert os.path.basename(os.path.dirname(result)) == "snapshots"

    def test_take_snapshot_pending_and_save(self, tmp_path):
        """askSavePath モードで take_snapshot が PENDING を返し、save_pending_snapshot で保存されることを確認する"""
        CameraController = _load_camera_controller_class()
        controller = CameraController()
        controller.connect()

        controller.settings["askSavePath"] = True
        # メモリに保持される画像を用意（8bit）
        import numpy as np
        controller.latest_frame = np.full((8, 8), 77, dtype=np.uint8)

        result = controller.take_snapshot()
        assert result == "PENDING", "askSavePath=True の場合は PENDING を返すはず"

        target = tmp_path / "manual_snapshot.png"
        success = controller.save_pending_snapshot(str(target))
        assert success, "save_pending_snapshot は True を返すべき"
        assert target.exists(), "手動保存されたスナップショットファイルが存在しない"


class TestCameraControllerAPI:
    """カメラコントローラーの API 互換性テスト"""
    
    def test_camera_controller_has_required_methods(self):
        """
        CameraController が必要なメソッドを持つか確認。
        
        【テスト内容】
        CameraController が、フロントエンドや他のコンポーネントから
        呼ばれることが想定される、公開 API メソッドをすべて持っているか確認。
        
        【確認項目】
        必須メソッド一覧：
        - get_available_cameras: カメラ一覧取得
        - connect: カメラに接続
        - disconnect: カメラから切断
        - set_exposure: 露出時間を設定
        - get_exposure: 露出時間を取得
        - set_gain: ゲインを設定
        - get_gain: ゲインを取得
        
        各メソッドについて：
        1. 存在するか（hasattr）
        2. callable か（呼ぶ準備ができているか）
        
        【なぜこのテストが必要か】
        API 互換性の確認。もしメソッドが欠けていると、
        実際にフロントエンドを動かしたときに AttributeError が挙がる。
        それをテスト段階で早期に検出するため。
        """
        CameraController = _load_camera_controller_class()

        controller = CameraController()
        
        # 必須メソッドのリスト
        required_methods = [
            "get_available_cameras",
            "connect",
            "disconnect",
            "set_exposure",
            "get_exposure",
            "set_gain",
            "get_gain",
        ]
        
        for method_name in required_methods:
            assert hasattr(controller, method_name), \
                f"CameraController は {method_name} メソッドを持つべき"
            assert callable(getattr(controller, method_name)), \
                f"{method_name} は callable（呼べる）であるべき"


if __name__ == "__main__":
    # このファイルをダイレクト実行した場合
    pytest.main([__file__, "-v"])
