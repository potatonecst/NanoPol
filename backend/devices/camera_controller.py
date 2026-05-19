import numpy as np
import cv2
import platform
import time
import threading
import csv
import os
import datetime
from typing import Optional

# pylablib ライブラリのインポート（uc480 バックエンド用）
try:
    from pylablib.devices import uc480
    HAS_UC480 = True
    UC480_IMPORT_ERROR = None
except ImportError as e:
    HAS_UC480 = False
    UC480_IMPORT_ERROR = str(e)

from utils.logger import logger

if not HAS_UC480:
    logger.warning(f"[CAMERA INIT] pylablib.devices.uc480 import failed: {UC480_IMPORT_ERROR}")

class CameraController:
    """
    Thorlabs ThorCam (uc480) バックエンドを使用したカメラコントローラー。
    Mac環境ではMockモードで動作します。
    """
    
    def __init__(self):
        """カメラコントローラーの初期化"""
        self.camera = None  # pylablib カメラオブジェクト
        self.width = 0  # 画像の幅（ピクセル）
        self.height = 0  # 画像の高さ（ピクセル）
        self.input_bpp = 16  # 実際の入力ビット深度（接続時に上書きされる）
        
        # センサー情報（接続後に設定）
        self.sensor_type = None  # 'monochrome' または 'bayer'
        self.bayer_pattern = None  # Bayer パターン（'RG', 'BG', 'GR', 'GB' など、モノクロなら None）
        
        self.is_connected = False  # カメラが現在接続されているかどうかのフラグ
        self.has_uc480 = HAS_UC480  # uc480 ライブラリ import 成功可否（診断API用）
        self.uc480_import_error = UC480_IMPORT_ERROR  # import失敗理由（診断API用）
        
        # uc480が無い、またはMac環境（ドライバ非対応）の場合はMockモードにする
        self.is_mock_env = not HAS_UC480 or platform.system() == "Darwin"
        self.log_tag = "[CAMERA-MOCK]" if self.is_mock_env else "[CAMERA]"
        
        # 状態・設定の保持
        self.settings = {}  # フロントエンドから受け取った設定（config.jsonの内容）
        self.is_recording = False  # 現在録画中（TIFF直書き中）かどうかのフラグ
        self.tiff_writer = None  # tifffileのTiffWriterオブジェクト
        self.record_filepath = None  # 現在録画中の動画ファイルの絶対パス
        
        self.csv_file = None  # 同期記録用CSVのファイルオブジェクト
        self.csv_writer = None  # 同期記録用CSVのライター
        self.record_frame_count = 0  # 現在の録画フレーム数
        self.MAX_FRAMES = 10000  # 安全装置（Fail-safe）としての最大録画フレーム数
        
        # ステージの現在角度。撮像フレームと角度を後段で対応付けるために保持する。
        self.current_angle = 0.0
        # current_angle を取得した時刻（UNIX epoch milliseconds）。CSV同期情報に使用する。
        self.current_angle_timestamp_ms = 0.0

        # Camera settings
        self.exposure_ms = 10.0  # 露出時間（ミリ秒）
        self.gain = 50  # センサーのハードウェアゲイン（0〜100）
        # 実機のゲイン範囲（connect() 時に検出される）
        self.gain_min = 0
        self.gain_max = 100
        self.is_color_mode = False  # プレビュー・スナップショット時のカラー(True)/モノクロ(False)指定

        # 【スレッド間通信: ブロードキャスト（黒板とベル）方式】
        # API互換レイヤー向けの「最新フレーム」。_capture_loop() で更新される共有黒板。
        self.latest_frame = None
        # 内部で扱う uint16 のキャッシュ（遅延作成）
        self.latest_frame_uint16 = None
        # MJPEG配信用の軽量 8bit キャッシュ（generate_frames() が参照）
        self.latest_preview = None
        # 新規フレーム到着時に _capture_loop() から notify_all() し、配信/保存側が wait() で受け取る。
        self.frame_condition = threading.Condition()

        self._capture_thread = None  # 特急レーン（最速で画像を取得し続ける）のバックグラウンドスレッド
        self._mock_angle = 0.0  # Mock画像生成用の内部状態
        self._pending_snapshot = None  # Snapshot時に「保存先を聞く」設定の場合、一時的に画像データを保持するメモリ

        # 起動時にカメラ実行モードの判定根拠を明示する（切り分け用）
        logger.info(
            "[CAMERA INIT] mode=%s os=%s HAS_UC480=%s",
            "Mock" if self.is_mock_env else "Real",
            platform.system(),
            HAS_UC480,
        )

    # ============================================================================
    # 【列挙】 get_available_cameras (UIが最初に呼ぶ)
    # ============================================================================

    def get_available_cameras(self) -> list[dict[str, object]]:
        """
        利用可能なカメラの一覧を返します。
        UIがカメラを選択する前に最初に呼ぶメソッドです。

        Returns:
            list[dict[str, object]]: カメラ情報の配列。
                要素は {"id": int, "name": str, "model": str, "serial": str}。
                Mock環境では固定の仮想カメラ1件、列挙不能時は空配列を返します。
        """
        # Mock環境では実機列挙を行わず、UI検証用の固定エントリを返す。
        if self.is_mock_env:
            # reason はログ上の切り分け用:
            # - Darwin: macOSは実機ドライバ非対応のためMock運用
            # - uc480-unavailable: OSは対応でもライブラリ未導入でMock運用
            logger.info(
                "[CAMERA ENUM] mode=Mock reason=%s",
                "Darwin" if platform.system() == "Darwin" else "uc480-unavailable",
            )
            return [
                # UIのカメラ選択を止めないため、仮想カメラを1件返す。
                {"id": 0, "name": "Mock Camera A (Virtual)", "model": "Simulated-100", "serial": "SIM001"},
            ]
        
        # uc480が利用不可なら例外にせず空配列で返し、UI側で「0台」として扱えるようにする。
        if not HAS_UC480:
            return []

        # 実機の実装: uc480 バックエンドでカメラを列挙
        try:
            # list_cameras() の戻りを UI向けキー(id/name/model/serial)へ正規化する。
            cameras = uc480.list_cameras()
            result = []
            for cam in cameras:
                # cam は uc480 のカメラ記述子オブジェクト。
                # UI側はこの4キーを前提に表示・選択処理を行う。
                result.append({
                    "id": cam.cam_id,
                    "name": f"ThorCam {cam.cam_id}",
                    "model": cam.model,
                    "serial": cam.serial_number,
                })
            # 列挙件数をログに残し、接続前のトラブルシュートをしやすくする。
            logger.info("[CAMERA ENUM] mode=Real count=%d", len(result))
            return result
        except Exception:
            # 列挙失敗時も上位を止めず、空配列フォールバックでUI継続性を優先する。
            logger.exception("[CAMERA ENUM] Failed to list cameras")
            return []

    # ============================================================================
    # 【セッション管理】 connect / disconnect (UIがカメラ選択後に呼ぶ)
    # ============================================================================
        
    def connect(self, camera_id: int = 0) -> bool:
        """
        カメラに接続し、初期化・センサー情報取得・キャプチャスレッドの起動を行います。
        uc480（Thorlabs ThorCam）バックエンドを使用します。

        Args:
            camera_id (int): 接続するカメラのデバイスID。デフォルトは0。

        Returns:
            bool: 接続および初期化が成功した場合は True、失敗した場合は False。
        """
        # 既に接続済みなら、二重初期化せず成功扱いで戻る。
        if self.is_connected:
            return True

        # Mock環境では実機に触らず、後続処理が動く最小状態だけ作る。
        if self.is_mock_env:
            # Mockモード（uc480非対応環境）の初期化
            self.width = 1280
            self.height = 1024
            self.sensor_type = "monochrome"
            self.bayer_pattern = None
            self.input_bpp = 16
            logger.info(f"{self.log_tag} Connected to Virtual Camera (ID: {camera_id})")
        
        # uc480が使えないなら、実機接続は不可能なのでここで失敗する。
        elif not HAS_UC480:
            # uc480ライブラリがインポートできなかった場合
            logger.error(f"[CAMERA] uc480 library not available: {UC480_IMPORT_ERROR}")
            return False
        else:
            # 実機カメラの初期化（uc480バックエンド）
            try:
                # uc480で利用可能なカメラを列挙
                cameras = uc480.list_cameras()
                logger.debug(f"[CAMERA] Available cameras: {cameras}")
                
                # 候補が空なら、接続先が存在しない。
                if not cameras:
                    logger.error("[CAMERA] No cameras found.")
                    return False
                
                # 目的のカメラを探す
                target_camera = None
                for cam in cameras:
                    if cam.cam_id == camera_id:
                        target_camera = cam
                        break
                
                if target_camera is None:
                    logger.error(f"[CAMERA] Camera ID {camera_id} not found. Available IDs: {[c.cam_id for c in cameras]}")
                    return False
                
                # ここで実際の接続ハンドルを作る。
                # pylablib.devices.uc480 の公開APIは UC480Camera。
                self.camera = uc480.UC480Camera(cam_id=target_camera.cam_id)

                # --- デバイス検出ロジック（高レベルAPI優先、private補助は局所利用） ---
                # 目的: 接続時にランタイムで取得可能な情報を順に試し、
                #       ・入力のビット深度 (input_bpp)
                #       ・センサー種別 (sensor_type)
                #       ・Bayer パターン (bayer_pattern)
                #       ・ゲイン範囲 (gain_min/gain_max)
                # をできるだけ正確に取得する。
                # 方針:
                #  1) private helper (_get_pixel_mode_settings) を試し、正確な bpp を得る
                #  2) public API の get_color_mode() と内部マッピング (_mode_properties) で推定
                #  3) 取得できない場合は既定値を使用する（フォールバック）
                # 注意: private API の使用は将来の互換性リスクがあるため局所化して try/except で保護する。
                exact_bpp = False

                # 1) まず現在の取得データ寸法を取得する（data dimensions）
                #    ROI/binning/subsampling が反映された「実際に snap() で返る形状」に合わせる。
                #    取得できない場合のみ detector size にフォールバックする。
                got_runtime_dims = False
                try:
                    # pylablib カメラ基底クラス由来の public API
                    hdat, wdat = self.camera.get_data_dimensions()
                    self.width = int(wdat)
                    self.height = int(hdat)
                    got_runtime_dims = True
                except Exception:
                    logger.debug("[CAMERA] get_data_dimensions() not available or failed")

                if not got_runtime_dims:
                    try:
                        wdet, hdet = self.camera.get_detector_size()
                        # uc480 の多くの実装は (width,height) を返す
                        self.width = int(wdet)
                        self.height = int(hdet)
                    except Exception:
                        # フォールバックは既定値のまま
                        logger.debug("[CAMERA] get_detector_size() not available or failed")

                # 2) bpp の検出: まず内部ヘルパーを試す（最も正確だが private）
                #    _get_pixel_mode_settings() は (total_bits_per_pixel, channels) を返す実装が多い。
                #    例えば raw10 などは total_bits=16, channels=1 のように扱われる場合があるため
                #    チャネル数で割って per-channel のビット深度を決定する。
                #    失敗したら次のフォールバックへ移る。
                try:
                    if hasattr(self.camera, "_get_pixel_mode_settings"):
                        bpp_total, nchan = self.camera._get_pixel_mode_settings()
                        if bpp_total is not None and nchan:
                            # _get_pixel_mode_settings は (bits_per_pixel_total, channels)
                            self.input_bpp = int(bpp_total // nchan)
                            exact_bpp = True
                except Exception:
                    logger.debug("[CAMERA] _get_pixel_mode_settings() failed, will fallback to public APIs")

                # 3) private が使えなければ高レベルの color_mode → マッピングで推定
                #    uc480 の実装には _mode_properties のような辞書があり、mode 名から
                #    (total_bits, channels) が得られる場合がある。これを用いて推定する。
                #    mode 値を数値から名前へ変換する処理は実装依存なので保護する。
                if not exact_bpp:
                    try:
                        mode = self.camera.get_color_mode()
                        mode_name = None
                        try:
                            if hasattr(self.camera, "_p_color_mode"):
                                mode_name = self.camera._p_color_mode.i(mode & 0x7F)
                        except Exception:
                            mode_name = None

                        if mode_name and hasattr(self.camera, "_mode_properties"):
                            mp = self.camera._mode_properties.get(mode_name)
                            if mp:
                                bpp_total, nchan = mp
                                self.input_bpp = int(bpp_total // nchan)
                        else:
                            # 最終フォールバック
                            self.input_bpp = int(self.input_bpp)
                    except Exception:
                        logger.debug("[CAMERA] get_color_mode() mapping failed; using default bpp")

                # 4) センサー種別・Bayer 情報
                #    可能であればセンサー情報構造体からモノクロ/カラ（Bayer）判定と
                #    上位左上の Bayer ピクセルを読み取り、簡易的なパターン推定を行う。
                #    ここも実装依存のため失敗しても処理を止めない。
                try:
                    si = self.camera._get_sensor_info()
                    try:
                        if getattr(si, "nColorMode", None) == b"\x01":
                            self.sensor_type = "monochrome"
                        else:
                            self.sensor_type = "bayer"
                    except Exception:
                        self.sensor_type = "unknown"
                    # Upper-left bayer pixel があれば簡易的にパターンを決定
                    try:
                        upl = getattr(si, "nUpperLeftBayerPixel", None)
                        if upl is not None:
                            # 値の解釈は uc480_defs.BAYER_PIXEL を参照
                            bmap = {0: "RG", 1: "GR", 2: "BG", 3: "GB"}
                            self.bayer_pattern = bmap.get(int(upl), None)
                    except Exception:
                        self.bayer_pattern = None
                except Exception:
                    logger.debug("[CAMERA] sensor info not available")

                # 5) ゲイン範囲（best-effort）
                #    get_max_gains() が返した値を、そのままデバイスのゲイン範囲として採用する。
                #    ここでは 0..100 へ勝手に補正しない。UI 側は get_gain_range() の戻り値を
                #    そのままスライダーの min/max に使う前提にする。
                try:
                    mg = self.camera.get_max_gains()
                    if isinstance(mg, (list, tuple)) and len(mg) >= 1:
                        master = mg[0]
                        # NOTE: 実機ライブラリは戻り値の単位が実装依存であるため
                        #       ここではライブラリが返す「そのままの値」を保持する方針に変更。
                        #       つまり、get_max_gains() が 1.0 のような小数を返せば
                        #       UI側のスライダー範囲も 0.0..1.0 に合わせる想定とする。
                        try:
                            masterf = float(master)
                            self.gain_max = masterf
                            # gain_min が未設定なら 0 と仮定（多くの実装で妥当）
                            if self.gain_min is None:
                                self.gain_min = 0.0
                            # 内部フラグ: 返り値が 1.5 以下なら割合表現の可能性が高い
                            self._gain_unit_is_ratio = (masterf <= 1.5)
                        except Exception:
                            pass
                except Exception:
                    logger.debug("[CAMERA] get_max_gains() not available or failed; using defaults")

                # 正規化: デバイス生値を保ったまま float に揃える
                try:
                    self.gain_min = float(self.gain_min)
                    self.gain_max = float(self.gain_max)
                except Exception:
                    self.gain_min, self.gain_max = 0.0, 100.0

                # 6) カラーカメラ（Bayer）の場合は、RGB チャネルゲインを 1.0 に固定する。
                #    モノクロカメラでは RGB ゲインの概念がないので何もしない。
                if self.sensor_type == "bayer":
                    try:
                        self.camera.set_gains(red=1.0, green=1.0, blue=1.0)
                        logger.info("[CAMERA] Fixed RGB gains to 1.0 for Bayer sensor")
                    except Exception:
                        logger.exception("[CAMERA] Failed to fix RGB gains")

                # 接続成功時の診断ログ（bpp が確定か推定かを含める）
                logger.info(
                    f"[CAMERA] Connected to Camera ID {camera_id}: model={target_camera.model}, resolution={self.width}x{self.height}, "
                    f"sensor_type={self.sensor_type}, bayer_pattern={self.bayer_pattern}, input_bpp={self.input_bpp} (exact={exact_bpp})"
                )

                # 接続直後に露光とゲインを、現在の設定値で揃える。
                self.set_exposure(self.exposure_ms)
                self.set_gain(self.gain)
                
            except Exception:
                # 途中で失敗した場合は、半端な接続状態を残さず巻き戻す。
                logger.exception("[CAMERA] Failed to connect to camera")
                self.camera = None
                self.is_connected = False
                return False

        # 接続が完了したら、別スレッドで連続取得を開始する。
        self.is_connected = True
        self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._capture_thread.start()

        return True

    def disconnect(self) -> None:
        """
        カメラから切断し、キャプチャスレッドの停止とリソースの解放を安全に行います。
        
        終了順序が重要：
        1. is_connected = False で取得スレッドに終了指示
        2. join() でスレッド終了を待機（リソース競合回避：snap()実行中にカメラを閉じない）
        3. stop_recording() で TIFF/CSV を閉じる（スレッド停止後なので安全）
        4. camera.close() でカメラをクローズ
        """
        self.is_connected = False
        
        # キャプチャスレッドの終了を待つ（snap()が完了するまで待機する）
        if self._capture_thread and self._capture_thread.is_alive():
            self._capture_thread.join(timeout=3.0)
            if self._capture_thread.is_alive():
                logger.warning(f"{self.log_tag} Capture thread did not terminate within timeout")

        # スレッド終了後に録画を停止（この段階でスレッドが TIFF 書き込み中ではないため安全）
        if self.is_recording:
            try:
                self.stop_recording()
            except Exception:
                logger.exception(f"{self.log_tag} Error stopping recording")

        # 実機カメラのクローズ（Mock環境では self.camera は None）
        if not self.is_mock_env and self.camera is not None:
            try:
                self.camera.close()
            except Exception:
                logger.exception("[CAMERA] Error closing camera")
                return
            finally:
                self.camera = None

        logger.info(f"{self.log_tag} Disconnected")

    # ============================================================================
    # 【カメラ制御】 set_exposure / set_gain / set_color_mode / update_settings
    # ============================================================================

    def set_exposure(self, ms: float) -> Optional[float]:
        """
        カメラの露光時間を設定します。
        
        Args:
            ms (float): 露光時間（ミリ秒）

        Returns:
            Optional[float]: 適用後の露光時間（ミリ秒）。
                未接続・失敗時は None。
        """
        try:
            req_ms = float(ms)
        except Exception:
            logger.warning(f"{self.log_tag} Invalid exposure value: {ms}")
            return None

        self.exposure_ms = req_ms
        if self.is_mock_env:
            logger.info(f"{self.log_tag} Set Exposure: {req_ms}ms")
            return self.exposure_ms
            
        if not self.is_connected or self.camera is None:
            logger.warning(f"{self.log_tag} Camera not connected, cannot set exposure")
            return None
            
        try:
            # uc480 API は exposure を秒単位で扱うため、ミリ秒を秒に変換
            exposure_sec = req_ms / 1000.0
            applied_sec = self.camera.set_exposure(exposure_sec)
            applied_ms = float(applied_sec) * 1000.0
            self.exposure_ms = applied_ms
            logger.info(f"{self.log_tag} Set Exposure: requested={req_ms}ms applied={applied_ms}ms ({applied_sec}s)")
            return self.exposure_ms
        except Exception:
            logger.exception(f"{self.log_tag} Failed to set exposure")
            return None

    def get_exposure(self) -> Optional[float]:
        """
        現在の露出時間（ミリ秒）を返すラッパー。

        Returns:
            Optional[float]: 設定済みの露出時間（ms）。未接続や不明な場合は None。
        """
        # 常に現在の内部状態を返す（Mock 環境でも有用）
        try:
            return float(self.exposure_ms)
        except Exception:
            return None

    def set_gain(self, val: float):
        """
        センサーのハードウェアゲインを設定します。
        
        Args:
            val (float): ゲイン値（0〜100、またはデバイスに応じた範囲）
        """
        # 受け取った値はまだ確定していない。適用後に self.gain を上書きする。
        # Mock 環境でもクランプした applied 値を内部状態に反映して返す。
        # 入力はデバイスが期待する単位（device native）に合わせる方針。
        # UI は get_gain_range() を呼んでスライダーの min/max を合わせること。
        try:
            v = float(val)
        except Exception:
            logger.warning(f"{self.log_tag} Invalid gain value: {val}")
            return None
        applied = max(float(self.gain_min), min(float(self.gain_max), v))
        if self.is_mock_env:
            # Mock 環境では従来どおり 0..100 の整数想定だが、float も受け入れる。
            self.gain = applied
            logger.info(f"{self.log_tag} Set Gain (mock): {applied} (requested={val})")
            return applied
            
        if not self.is_connected or self.camera is None:
            logger.warning(f"{self.log_tag} Camera not connected, cannot set gain")
            return
            
        try:
            # 受け取った値を機種範囲内にクランプして適用（デバイス単位のまま渡す）
            # uc480 のハードウェアゲインは master チャネルとして設定する。
            self.camera.set_gains(master=applied)
            # 適用に成功したら内部状態を確定してログを出す
            self.gain = applied
            logger.info(f"{self.log_tag} Set Gain: {self.gain} (requested={val}, range={self.gain_min}-{self.gain_max})")
            return self.gain
        except Exception:
            logger.exception(f"{self.log_tag} Failed to set gain")
            return None

    def get_gain(self) -> Optional[float]:
        """
        現在のゲイン値を返すラッパー。

        Returns:
            Optional[float]: 現在のゲイン（デバイス単位）。未設定の場合は None。
        """
        try:
            return float(self.gain)
        except Exception:
            return None

    def get_gain_range(self) -> tuple[float, float]:
        """フロントエンド用に現在のゲイン範囲を返す（min, max）。

        注意: 値の単位はデバイス依存で、そのまま UI に返します。
        つまり UI はこの戻り値をスライダーの最小/最大に設定してください。
        例: デバイスが 0.0..1.0 を返す場合、スライダーも 0.0..1.0 にするべきです。
        """
        return (float(self.gain_min), float(self.gain_max))

    def set_color_mode(self, is_color: bool):
        """プレビュー・スナップショット時のカラーモード設定を受け取る"""
        self.is_color_mode = is_color
        logger.info(f"{self.log_tag} Preview Color Mode set to: {'Color' if is_color else 'Monochrome'}")

    def update_settings(self, new_settings: dict):
        """フロントエンドからの設定(config.jsonの内容など)をバックエンドに反映する"""
        self.settings.update(new_settings)
        
        # カラーモードの反映
        if "cameraMode" in new_settings:
            self.set_color_mode(new_settings["cameraMode"] == "Color")
            
        logger.info(f"{self.log_tag} Settings updated: {new_settings}")

    # ============================================================================
    # 【スナップショット】 take_snapshot / save_pending_snapshot
    # ============================================================================

    def take_snapshot(self) -> Optional[str]:
        """【Snapshot】最新のフレームを取得し、メモリに一時保持または自動保存する"""
        if not self.is_connected:
            return None
            
        with self.frame_condition:
            if self.latest_frame is None:
                logger.error(f"{self.log_tag} Snapshot failed: No frame available.")
                return None
            frame = self.latest_frame
            
        fmt = self.settings.get("imageFormat", "TIFF")
        save_img = frame
        
        # モードとフォーマットに応じた画像変換
        bayer_code = self._get_bayer_color_conversion_code()
        if bayer_code is not None:
            save_img = cv2.cvtColor(save_img, bayer_code)
            
        if fmt in ["JPEG", "PNG"] and save_img.dtype == np.uint16:
            save_img = cv2.normalize(save_img, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)
            
        # ダイアログで保存先を聞く設定の場合、メモリに保持してフロントエンドからの保存指示を待つ
        if self.settings.get("askSavePath", False):
            self._pending_snapshot = save_img
            logger.info(f"{self.log_tag} Snapshot captured in memory. Waiting for save path...")
            return "PENDING"
            
        # 自動保存の場合
        out_dir = self.settings.get("outputDirectory", os.getcwd())
        prefix = self.settings.get("snapshotPrefix", "snapshot_")
        os.makedirs(out_dir, exist_ok=True)
        
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        ext = ".tif" if fmt == "TIFF" else (".jpg" if fmt == "JPEG" else ".png")
        filepath = os.path.join(out_dir, f"{prefix}{timestamp}{ext}")
        
        if self._write_image_to_disk(filepath, save_img):
            return filepath
        return None

    def save_pending_snapshot(self, filepath: str) -> bool:
        """【Snapshot】メモリに保持していた画像を、指定されたパスに保存する"""
        if self._pending_snapshot is None:
            logger.error(f"{self.log_tag} No pending snapshot to save.")
            return False
            
        success = self._write_image_to_disk(filepath, self._pending_snapshot)
        self._pending_snapshot = None
        return success

    # ============================================================================
    # 【録画】 start_recording / stop_recording
    # ============================================================================

    def start_recording(self) -> bool:
        """【Recording】動画（マルチページTIFF）の保存を開始する（常に自動保存）"""
        if not self.is_connected or self.is_recording:
            return False
            
        # 動画はSSD直書きのリアルタイム性が重要なため、ダイアログは出さずに常に自動保存とする
        out_dir = self.settings.get("outputDirectory", os.getcwd())
        prefix = self.settings.get("recordPrefix", "record_")
        os.makedirs(out_dir, exist_ok=True)
        
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        self.record_filepath = os.path.join(out_dir, f"{prefix}{timestamp}.tif")
        
        try:
            import tifffile
            csv_filepath = os.path.join(out_dir, f"{prefix}{timestamp}.csv")
            
            self.tiff_writer = tifffile.TiffWriter(self.record_filepath, append=True)
            
            # CSVファイルも同時に開き、ヘッダーを書き込む
            self.csv_file = open(csv_filepath, mode='w', newline='', encoding='utf-8')
            self.csv_writer = csv.writer(self.csv_file)
            self.csv_writer.writerow([
                "Frame_Index",
                "Frame_Timestamp_ms",
                "Angle_deg_nearest",
                "Angle_Sample_Timestamp_ms",
                "Angle_Age_ms",
                "Input_BPP",
            ])
            self.record_frame_count = 0
            
            # 全ての準備が成功した場合にのみ、録画中フラグを立てる（重要）
            self.is_recording = True
            logger.info(f"{self.log_tag} Recording started: {self.record_filepath}")
            return True
        except Exception:
            logger.exception(f"{self.log_tag} Failed to start recording")
            # 失敗した場合は、途中で開いたファイルをクリーンアップする
            if self.tiff_writer: self.tiff_writer.close()
            if self.csv_file: self.csv_file.close()
            return False

    def stop_recording(self) -> Optional[str]:
        """【Recording】動画の保存を停止し、事後処理（貨物レーン）をキックする"""
        if not self.is_recording:
            return None
            
        self.is_recording = False
        if self.tiff_writer is not None:
            self.tiff_writer.close()
            self.tiff_writer = None
        
        # CSVファイルも閉じて、ライターオブジェクトもリセットする
        if self.csv_file is not None:
            self.csv_file.close()
            self.csv_file = None
            self.csv_writer = None
            
        logger.info(f"{self.log_tag} Recording stopped: {self.record_filepath}")
        
        # MP4への自動変換がONなら、重い処理を非同期スレッド(貨物レーン)に投げる
        if self.settings.get("autoConvertMp4", False):
            threading.Thread(
                target=self._post_process_video, 
                args=(self.record_filepath, self.is_color_mode, self.settings.get("keepRawTiff", True)),
                daemon=True
            ).start()
            
        return self.record_filepath

    # ============================================================================
    # 【内部メソッド】 Bayer パターン処理・フレーム取得・画像処理
    # ============================================================================

    def _get_bayer_color_conversion_code(self) -> Optional[int]:
        """
        実装されたbayer_patternからOpenCVの色変換フラグを取得。
        bayer_pattern が None（モノクロ）または is_color_mode=False の場合は None を返す。
        """
        if not self.is_color_mode or self.bayer_pattern is None:
            return None
        
        mapping = {
            'RG': cv2.COLOR_BayerRG2BGR,
            'BG': cv2.COLOR_BayerBG2BGR,
            'GR': cv2.COLOR_BayerGR2BGR,
            'GB': cv2.COLOR_BayerGB2BGR,
        }
        code = mapping.get(self.bayer_pattern, cv2.COLOR_BayerRG2BGR)
        logger.debug(
            f"{self.log_tag} Bayer conversion: pattern={self.bayer_pattern} -> code={code}"
        )
        return code

    def _capture_loop(self) -> None:
        """
        【特急レーン】バックグラウンドで常に画像を全力で取得し、ブロードキャスト通知するループ処理。
        別スレッドで実行され、録画中は超高速でディスクへの直書き(TIFF追記)も担います。
        
        処理フロー:
        1. ハードウェア（またはMock）から画像を取得
        2. threading.Condition で全リスナーに通知（"ベルを鳴らす"）
        3. 録画中なら TIFF と CSV に直書き（超高速・リアルタイム性重視）
        4. CPU暴走防止（Mock環境のみフレームレート制御）
        
        スレッド管理:
        - connect() で起動、disconnect() で is_connected=False として終了信号
        - join(timeout=2) で安全に待機
        """
        logger.info(f"{self.log_tag} Capture thread started.")
        while self.is_connected:
            start_time = time.time()
            
            frame_data = self._grab_image_from_hardware_or_mock()
            if frame_data is None:
                time.sleep(0.1)
                continue

            # ========================================================================
            # 【ブロードキャスト通知】プレビューキャッシュと内部参照の更新
            # ========================================================================
            # 受信データは可能な限りプレビュー用 uint8 をそのまま使い、
            # 録画/解析用の uint16 は必要時にのみ作成する（遅延変換）。
            try:
                src_bpp = int(self.input_bpp)
            except Exception:
                src_bpp = 16

            # プレビュー用に高速に変換
            try:
                preview = self._to_preview_uint8(frame_data, src_bpp)
            except Exception:
                preview = frame_data.astype(np.uint8) if getattr(frame_data, 'dtype', None) != np.uint8 else frame_data

            # 内部 uint16 はまだ不要であれば遅延（None）。16bitで来ていれば即時保持。
            frame_uint16 = None
            if src_bpp >= 16 or getattr(frame_data, 'dtype', None) == np.uint16:
                frame_uint16 = self._to_internal_uint16(frame_data, src_bpp)

            with self.frame_condition:
                self.latest_preview = preview
                # latest_frame は既存API互換のために元データか uint16 を保持
                self.latest_frame = frame_uint16 if frame_uint16 is not None else frame_data
                self.latest_frame_uint16 = frame_uint16
                self.frame_condition.notify_all()

            # ========================================================================
            # 【録画処理】特急レーン（超高速・直書き）
            # ========================================================================
            # ハードウェアキャプチャと同期して、フレームを TIFF と CSV に即座に直書き。
            # キューを使わず直書きする理由: 不可逆圧縮なし、フレーム喪失なし、ディスク性能を活用。
            # 複数スレッドでの TIFF 書き込みは安全（append=True モード）。
            # CSV も同時に書き込み、画像時刻とステージ角度の対応付けを保持。
            if self.is_recording and self.tiff_writer is not None and self.csv_writer is not None:
                if self.record_frame_count >= self.MAX_FRAMES:
                    logger.warning(f"{self.log_tag} Max recording frames ({self.MAX_FRAMES}) reached! Auto-stopping.")
                    self.stop_recording()
                else:
                    try:
                        # 録画用には必ず uint16 を書き込む。受信が uint8 の場合はここで一度だけ拡張する。
                        if getattr(frame_data, 'dtype', None) == np.uint16:
                            write_frame = frame_data
                        else:
                            write_frame = self._to_internal_uint16(frame_data, self.input_bpp)
                        self.tiff_writer.write(write_frame, contiguous=True)

                        frame_timestamp_ms = time.time() * 1000.0
                        angle_sample_timestamp_ms = self.current_angle_timestamp_ms

                        if angle_sample_timestamp_ms <= 0.0:
                            angle_sample_timestamp_ms = frame_timestamp_ms

                        angle_age_ms = max(0.0, frame_timestamp_ms - angle_sample_timestamp_ms)
                        self.csv_writer.writerow([
                            self.record_frame_count,
                            f"{frame_timestamp_ms:.3f}",
                            f"{self.current_angle:.4f}",
                            f"{angle_sample_timestamp_ms:.3f}",
                            f"{angle_age_ms:.3f}",
                            f"{self.input_bpp}",
                        ])
                        
                        self.record_frame_count += 1
                    except Exception:
                        logger.exception(f"{self.log_tag} Error writing frame to TIFF/CSV")

            # ========================================================================
            # 【CPU制御】Mock環境のみフレームレート制御（実機は自然な間隔で取得される）
            # ========================================================================
            # Mock では無限ループになるため、CPU使用率100%を防ぐために
            # フレームレート 30fps に制限（デモンストレーション用）。
            if self.is_mock_env:
                elapsed = time.time() - start_time
                sleep_time = max(0, (1.0 / 30.0) - elapsed)  # 30fps ペース
                time.sleep(sleep_time)
                
        logger.info(f"{self.log_tag} Capture thread stopped.")

    def _grab_image_from_hardware_or_mock(self) -> Optional[np.ndarray]:
        """
        カメラから生データを取得し、Numpy配列として返す。
        
        戻り値:
        - Mock環境: 1280×1024 の 8bit または 16bit 合成画像（回転円と時刻表示）
        - 実機: uc480.Camera.snap() から生RAW画像（通常16bit）
        
        エラーハンドリング:
        - 接続なし → None 返却
        - snap() 失敗 → logger.error(), None 返却
        - 予期しない形状 → logger.warning() で通知、画像は返却（上流で対応）
        """
        if not self.is_connected:
            return None
            
        if self.is_mock_env:
            # ========================================================================
            # Mock画像生成（macOS 開発環境用・テスト用）
            # ========================================================================
            # 実カメラがない環境で、機能検証・デバッグ・UI動作確認を可能にする。
            # 黒い背景に回転する白い円 + タイムスタンプ + ノイズを追加。
            
            img_8 = np.zeros((self.height, self.width), dtype=np.uint8)
            
            # 回転する円を描画（角度は毎フレーム 0.05rad ずつ進む）
            cx = int(self.width / 2 + 150 * np.cos(self._mock_angle))
            cy = int(self.height / 2 + 150 * np.sin(self._mock_angle))
            self._mock_angle += 0.05
            
            # 白い塗りつぶし円を描画
            cv2.circle(img_8, (cx, cy), 50, 255, -1)
            # 左上にタイムスタンプを表示
            cv2.putText(img_8, f"MOCK {time.strftime('%H:%M:%S')}", (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, 255, 2)
            
            # ノイズを追加してリアリズムを持たせる
            noise = np.random.randint(0, 30, (self.height, self.width), dtype=np.uint8)
            img_8 = cv2.add(img_8, noise)
            
            # input_bpp 設定に応じて 8bit または 16bit で返却
            if self.input_bpp == 8:
                return img_8
            else:
                # 16bit に変換：8bit * 256 で範囲を 0-65535 に拡張
                img_16 = img_8.astype(np.uint16) * 256
                return img_16

        # ========================================================================
        # 実機キャプチャ処理（uc480バックエンド）
        # ========================================================================
        # pylablib の uc480.Camera.snap() を呼び出して、生 RAW データを取得。
        # 取得形式は通常 16bit グレースケール（センサー依存）。
        try:
            image_data = self.camera.snap()  # ブロッキング呼び出し（フレーム待機）
            
            if image_data is None:
                logger.error("[CAMERA] snap() returned None")
                return None
            
            # 画像サイズの検証（初期化時に設定した width/height と一致するか）
            if image_data.shape != (self.height, self.width):
                logger.warning(
                    f"[CAMERA] Unexpected image shape: {image_data.shape}, "
                    f"expected ({self.height}, {self.width})"
                )
            
            return image_data
            
        except Exception:
            logger.exception("[CAMERA] Capture failed")
            return None

    def _to_internal_uint16(self, frame: np.ndarray, src_bpp: int) -> np.ndarray:
        """
        受信フレームを内部で扱う uint16 表現に変換するヘルパー。
        - src_bpp >= 16: そのまま uint16 にキャスト
        - src_bpp <= 8: ビット拡張（リニアスケーリング）して uint16 にする
        - 10/12bit 等も想定し、一般式でスケールする
        戻り値は dtype が uint16 の numpy 配列
        """
        if frame is None:
            return None

        if src_bpp >= 16 or frame.dtype == np.uint16:
            return frame.astype(np.uint16)

        # 一般式: scale = 65535 / (2**src_bpp - 1)
        max_in = (1 << src_bpp) - 1
        if max_in <= 0:
            scale = 1
        else:
            scale = 65535.0 / float(max_in)

        # float 演算後に丸めして uint16 化（vectorized）
        arr = frame.astype(np.float32) * scale
        arr = np.clip(np.rint(arr), 0, 65535).astype(np.uint16)
        return arr

    def _to_preview_uint8(self, frame: np.ndarray, src_bpp: int) -> np.ndarray:
        """
        内部 uint16 または受信データからプレビュー用 uint8 配列を作成するヘルパー。
        - src_bpp >= 16: 上位8ビットをシフトして uint8 を作る（高速）
        - src_bpp <= 8: そのまま uint8 を返す
        - 中間ビット幅（10/12bit 等）は上位ビットを落として uint8 化
        """
        if frame is None:
            return None

        if src_bpp >= 16 or frame.dtype == np.uint16:
            shift = max(0, src_bpp - 8)
            return (frame.astype(np.uint16) >> shift).astype(np.uint8)

        # 8bit 以下
        return frame.astype(np.uint8)

    def _write_image_to_disk(self, filepath: str, img: np.ndarray) -> bool:
        """【内部用】Numpy配列を画像ファイルとしてディスクに保存します（TIFF/JPEG/PNG自動判別）"""
        try:
            if filepath.lower().endswith(('.tif', '.tiff')):
                import tifffile
                tifffile.imwrite(filepath, img)
            else:
                cv2.imwrite(filepath, img)
            logger.info(f"{self.log_tag} Snapshot saved to: {filepath}")
            return True
        except Exception as e:
            logger.exception(f"{self.log_tag} Snapshot save error")
            return False

    def _post_process_video(self, tiff_path: str, is_color: bool, keep_raw: bool):
        """【貨物レーン】録画完了後に巨大なTIFFをMP4等に変換する"""
        logger.info(f"{self.log_tag} [Post-Process] Started for {tiff_path}")
        # TODO: tifffileで各フレームを読み込み、OpenCVのVideoWriter等でMP4を生成する処理を実装
        time.sleep(2)
        logger.info(f"{self.log_tag} [Post-Process] Completed.")

    # ============================================================================
    # 【配信】 generate_frames
    # ============================================================================

    def generate_frames(self):
        """
        【各駅停車レーン】最新の画像を JPEG 圧縮してブラウザに配信するジェネレータ関数。
        
        アーキテクチャ:
        - FastAPI の StreamingResponse と組み合わせて使用
        - HTTP ヘッダー: "multipart/x-mixed-replace" (MJPEG 配信フォーマット)
        - ブラウザで動画ストリーム表示
        
        スレッドモデル:
        - 特急レーン(_capture_loop): ハードウェアから全力で画像取得・録画
        - 各駅停車レーン(generate_frames): 最新フレームだけを JPEG 圧縮・配信
        - キューではなく threading.Condition で待機(wait/notify パターン)
        
        利点:
        - フレーム喪失なし: 常に最新フレームを配信
        - 複数クライアント対応: notify_all() で全リスナーを起動
        - CPU効率的: wait(timeout) で無駄なポーリング回避
        """
        logger.info(f"{self.log_tag} Starting MJPEG stream")
        
        while self.is_connected:
            with self.frame_condition:
                # ====================================================================
                # 【待機と受信】threading.Condition の wait/notify パターン
                # ====================================================================
                # wait(timeout=1.0) を呼ぶと、このスレッドは一時停止(Sleep)し、
                # CPU使用率が 0% になります(忙しいスピンロックではない)。
                # 
                # 特急レーンから notify_all() (ベルを鳴らす) が呼ばれると、
                # 待機中のスレッドは即座に目覚め、最新プレビュー(self.latest_preview)を取得します。
                # 
                # メリット:
                # - CPU 効率的(ポーリングなし)
                # - 複数クライアント対応(notify_all で全リスナー起動)
                # - キューと違い、常に最新フレーム(古いフレーム喪失なし)
                if not self.frame_condition.wait(timeout=1.0) or self.latest_preview is None:
                    continue
                frame_data = self.latest_preview

            # ====================================================================
            # 【画像変換・前処理】
            # ====================================================================
            # 16-bit RAWデータを表示用に 8-bit に変換
            # (JPEG 圧縮で 8bit 必須、カラーパレットのため)
            if frame_data.dtype == np.uint16:
                display_frame = cv2.normalize(frame_data, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)
            else:
                display_frame = frame_data

            # Bayer パターンをフルカラー (BGR) にデモザイク
            # (is_color_mode=True の場合のみ、通常はモノクロで十分)
            bayer_code = self._get_bayer_color_conversion_code()
            if bayer_code is not None:
                display_frame = cv2.cvtColor(display_frame, bayer_code)

            # ====================================================================
            # 【JPEG 圧縮・配信】
            # ====================================================================
            # OpenCV の imencode() で JPEG に圧縮(品質70で十分)
            ret, buffer = cv2.imencode('.jpg', display_frame)
            if not ret:
                continue
                
            frame_bytes = buffer.tobytes()

            # MJPEG配信フォーマット
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
