import numpy as np
import cv2
import platform
import time
import threading
import csv
import os
import datetime
from decimal import Decimal
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
from utils.roi_processor import ROIProcessor

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
        self._recording_lock = threading.Lock()  # writer の生成/破棄/書き込みを守るロック
        
        # ステージの現在角度。撮像フレームと角度を後段で対応付けるために保持する。
        self.current_angle = 0.0
        # current_angle を取得した時刻（UNIX epoch milliseconds）。CSV同期情報に使用する。
        self.current_angle_timestamp_ms = 0.0

        # Camera settings
        self.exposure_ms = 0.06675  # 露出時間（ミリ秒）
        # Mock 環境での既定ゲインを現実的な値に合わせる（多くのカメラで1.0〜13.0が妥当）
        self.gain = 1.0  # センサーのハードウェアゲイン（デフォルト: 1.0）
        # 実機のゲイン範囲（connect() 時に検出される）。Mock環境では 1.0..13.0 を想定
        self.gain_min = 1.0
        self.gain_max = 13.0
        self.is_color_mode = False  # プレビュー・スナップショット時のカラー(True)/モノクロ(False)指定
        # キャッシュ: 接続時に取得する露光範囲（ミリ秒単位）。頻繁な set_exposure 呼び出しで
        # 都度ハードウェア問い合わせを行わないようにここに保持する。
        self.exposure_min_ms = None
        self.exposure_max_ms = None
        self.exposure_step_ms = None
        self._exposure_range_cached = False

        # 【スレッド間通信: ブロードキャスト（黒板とベル）方式】
        # API互換レイヤー向けの「最新フレーム」。_capture_loop() で更新される共有黒板。
        self.latest_frame = None
        # 内部で扱う uint16 のキャッシュ（遅延作成）
        self.latest_frame_uint16 = None
        # MJPEG配信用の軽量 8bit キャッシュ（generate_frames() が参照）
        self.latest_preview = None
        # 新規フレーム到着時に _capture_loop() から notify_all() し、配信/保存側が wait() で受け取る。
        self.frame_condition = threading.Condition()

        # ROI 関連の状態管理
        self.rois = []  # 現在の解析対象 ROI リスト
        self.latest_roi_stats = {}  # 最新フレームの解析結果（Sum, Max, Centroid）
        self.enable_centroid_calc = True  # 重心計算を行うかどうか
        self._roi_lock = threading.Lock()  # ROI 設定の更新を保護するロック
        self._camera_lock = threading.Lock()  # 【重要】カメラデバイス（uc480）へのすべての並行操作を防ぐ排他ロック
        
        # 解析完了時に呼ばれる外部コールバック
        # 署名: callback(angle: float, roi_stats: dict)
        self.on_roi_stats_computed = None

        self._capture_thread = None  # 特急レーン（最速で画像を取得し続ける）のバックグラウンドスレッド
        self._mock_angle = 0.0  # Mock画像生成用の内部状態
        self._pending_snapshot = None  # Snapshot時に「保存先を聞く」設定の場合、一時的に画像データを保持するメモリ
        self.active_stream_id = None  # 現在アクティブなMJPEG映像ストリームのID（ゾンビ接続破棄用）

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
        
    def connect(self, camera_id: int = 0, start_loop: bool = True) -> bool:
        """
        カメラに接続し、初期化・センサー情報取得・キャプチャスレッドの起動を行います。
        uc480（Thorlabs ThorCam）バックエンドを使用します。

        Args:
            camera_id (int): 接続するカメラのデバイスID。デフォルトは0。
            start_loop (bool): 接続成功時に直ちにキャプチャスレッドを起動するかどうか。デフォルトは True。

        Returns:
            bool: 接続および初期化が成功した場合は True、失敗した場合は False。
        """
        # 既に接続済みなら、二重初期化せず成功扱いで戻る。
        if self.is_connected:
            return True

        self.camera_id = camera_id  # 【自動再接続用】接続されたカメラIDを保持します。

        # Mock環境では実機に触らず、後続処理が動く最小状態だけ作る。
        if self.is_mock_env:
            # Mockモード（uc480非対応環境）の初期化
            self.width = 1280
            self.height = 1024
            self.sensor_type = "monochrome"
            self.bayer_pattern = None
            self.input_bpp = 8
            logger.info(f"{self.log_tag} Connected to Virtual Camera (ID: {camera_id})")
            self.is_connected = True
            # Mockでも exposure range をキャッシュしておく
            try:
                # Mock 環境では get_exposure_range() が自己完結的にフォールバック値を返すため
                # 安全にここで呼んでキャッシュしておく。UI スライダーの初期化や
                # 以後の set_exposure の事前クランプでこのキャッシュを使用する。
                er = self.get_exposure_range()
                if er is not None:
                    self.exposure_min_ms, self.exposure_max_ms, self.exposure_step_ms = er
                    self._exposure_range_cached = True
                    try:
                            logger.info(
                                f"{self.log_tag} Cached exposure range (mock): min={self._format_float_for_log(er[0])}ms max={self._format_float_for_log(er[1])}ms step={self._format_float_for_log(er[2])}ms"
                            )
                    except Exception:
                        logger.info(f"{self.log_tag} Cached exposure range (mock): {er}")
            except Exception:
                logger.debug(f"{self.log_tag} Failed to cache exposure range (mock)")
        
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
                # 初期化中の並行アクセスによる衝突を防ぐため、ロックで保護します。
                with self._camera_lock:
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
                            # gain_min を安全に決める（多くの実装で 0 を下限と仮定）
                            # 既に self.gain_min に初期値がある場合は上書きしない。
                            if getattr(self, 'gain_min', None) is None:
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

                # ここまで到達した時点で、以後の set_exposure / set_gain を許可する。
                # これを is_connected=True より前に呼ぶと、接続直後の初期化処理が
                # 「Camera not connected」で弾かれてしまう。
                self.is_connected = True

                # 接続直後にまず露光範囲を問い合わせしてキャッシュしておく（以後の set_exposure で使う）
                try:
                    er = self.get_exposure_range()
                    if er is not None:
                        self.exposure_min_ms, self.exposure_max_ms, self.exposure_step_ms = er
                        self._exposure_range_cached = True
                        # 実機パスでも可能な限り接続直後に取得してキャッシュする。
                        # ただし `get_exposure_range()` は `self.camera` が存在することを
                        # 前提にしているため、connect の順序によっては取得に失敗する
                        #（その場合はログに記録される）。キャッシュに成功すれば
                        # 高頻度の set_exposure 呼び出しでハードウェア問い合わせを避けられる。
                        try:
                            logger.info(
                                f"{self.log_tag} Cached exposure range: min={self._format_float_for_log(er[0])}ms max={self._format_float_for_log(er[1])}ms step={self._format_float_for_log(er[2])}ms"
                            )
                        except Exception:
                            logger.info(f"{self.log_tag} Cached exposure range: {er}")
                except Exception:
                    logger.debug(f"{self.log_tag} Failed to cache exposure range on connect")

                # 露光とゲインを、キャッシュ後の範囲に沿って揃える。
                self.set_exposure(self.exposure_ms)
                self.set_gain(self.gain)
                
            except Exception:
                # 途中で失敗した場合は、半端な接続状態を残さず巻き戻す。
                logger.exception("[CAMERA] Failed to connect to camera")
                self.camera = None
                self.is_connected = False
                return False

        # 接続が完了したら、指定された場合のみ別スレッドで連続取得（キャプチャスレッド）を開始する。
        if start_loop:
            self.start_capture_loop()

        return True

    def start_capture_loop(self) -> None:
        """
        画像取得ループ（_capture_loop）を別スレッドで起動します。
        
        自己修復処理時など、カメラ接続(connect)と露出・ゲインの再適用完了を
        厳密に直列化した後に、安全に撮影スレッドを立ち上げる目的で使用します。
        """
        if self._capture_thread and self._capture_thread.is_alive():
            logger.warning(f"{self.log_tag} Capture thread is already running.")
            return
        self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._capture_thread.start()
        logger.info(f"{self.log_tag} Capture thread started.")

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

        # ========================================================================
        # 【デッドロック防止のための安全な終了・破棄順序】
        # 実機カメラのクローズ（Mock環境では self.camera は None）を行います。
        # 
        # キャプチャスレッド（_capture_loop）が動作している最中に、このメソッドが
        # self._camera_lock を取得した状態で `_capture_thread.join()` のスレッド終了待ちに
        # 入ってしまうと、スレッド側は `snap()` 内で `_camera_lock` の解放を待ち、
        # こちらはスレッドの終了を待つため、永久に処理が固まる「デッドロック」に陥ります。
        # 
        # このため、必ず `join()` によるスレッドの完全停止を確認した「後」にロックを取得し、
        # 安全に `camera.close()` とオブジェクトの破棄（None化）を実行する順序設計にしています。
        # ========================================================================
        with self._camera_lock:
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
        # 入力の正規化: ユーザー入力を float に変換する
        try:
            req_ms = float(ms)
        except Exception:
            logger.warning(f"{self.log_tag} Invalid exposure value: {ms}")
            return None

        # ------------------------------------------------------------
        # 事前クランプ（pre-clamp）
        # - UI（スライダーなど）から頻繁に呼ばれることを想定しているため、
        #   高価なハードウェア問い合わせを避ける目的で接続時に取得した
        #   exposure range のキャッシュを利用してここで先にクランプする。
        # - 事前クランプは「要求値がデバイス範囲外であることを早期に検出し、
        #   不要なハードウェア呼び出しや誤設定を防ぐ」ための保護層であり、
        #   最終的な適用値はドライバが返す値を採用する。
        # - この実装は UI 側に負担をかけず、安全にスライダーの高速操作を
        #   可能にする設計です（クライアントは生値を送り続ければよい）。
        applied_ms = req_ms
        try:
            if self._exposure_range_cached and self.exposure_min_ms is not None:
                # キャッシュから min/max を読み取り、明示的に float 化して比較する
                min_ms = float(self.exposure_min_ms)
                max_ms = float(self.exposure_max_ms)
                # Python の min/max を使って簡潔にクランプ
                applied_ms = max(min_ms, min(max_ms, req_ms))
                # クランプが起きた場合はログ出力して診断できるようにする
                if applied_ms != req_ms:
                    logger.info(
                        f"{self.log_tag} Exposure value clamped: requested={req_ms}ms applied={applied_ms}ms (range={min_ms}-{max_ms})"
                    )
        except Exception:
            # 万が一キャッシュ値の読み取りで例外が起きても入力値をそのまま使う
            applied_ms = req_ms

        # 内部状態として一旦記憶しておく（Mock パスや失敗時に参照される）
        self.exposure_ms = applied_ms

        # Mock 環境では実際のデバイスを操作しないのでここで終了（ログは残す）
        if self.is_mock_env:
            logger.info(f"{self.log_tag} Set Exposure: {applied_ms}ms")
            return self.exposure_ms

        # 実機パス: 接続と camera オブジェクトの有無を確認する
        if not self.is_connected or self.camera is None:
            # 注意: connect() の中で exposure range をキャッシュする実装を採る場合は
            #       `self.is_connected` のタイミングにより取得可否が変わるため、
            #       connect の実装順序との整合性を保つ必要がある。
            logger.warning(f"{self.log_tag} Camera not connected, cannot set exposure")
            return None

        try:
            # uc480 は秒単位の API を使う実装が多いため、ミリ秒→秒変換して渡す
            exposure_sec = applied_ms / 1000.0
            # ドライバ呼び出し: ドライバは実際に適用した秒値（あるいは None）を返す
            # ロックを取得して、キャプチャスレッド（snap()）との衝突を防ぎます。
            with self._camera_lock:
                applied_sec = self.camera.set_exposure(exposure_sec)
            # ドライバ返却値をミリ秒に戻して内部状態を上書きする
            applied_ms_from_driver = float(applied_sec) * 1000.0
            # ドライバ側でさらに丸めや制限が行われる可能性があるため、
            # 最終的にはドライバが返した値を信頼して採用する
            self.exposure_ms = applied_ms_from_driver
            logger.info(
                f"{self.log_tag} Set Exposure: requested={req_ms}ms applied={self.exposure_ms}ms ({applied_sec}s)"
            )
            return self.exposure_ms
        except Exception:
            # 実機操作失敗時は例外ログを残して None を返す
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
            # ロックを取得して、キャプチャスレッド（snap()）との衝突を防ぎます。
            with self._camera_lock:
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

    def _format_float_for_log(self, value: float) -> str:
        """ログ向けに、float から復元できる範囲で最小限の十進表記に整形する。"""
        try:
            return format(Decimal(str(value)).normalize(), "f")
        except Exception:
            return str(value)

    def get_exposure_range(self) -> Optional[tuple[float, float, float]]:
        """
        露光時間の許容範囲を取得して返します（単位: ミリ秒）。

        戻り値:
            - (min_ms, max_ms, step_ms): 各値は float（ミリ秒）
            - None: 取得不可（未接続またはデバイス/ライブラリが範囲情報を提供しない場合）

        実装詳細:
            - Mock 環境では画面操作テスト向けのフォールバック値
              `(1.0, 1000.0, 1.0)` を返します（1ms〜1000ms、ステップ1ms）。
            - 実機（pylablib/uc480）では低レベル関数 `is_Exposure` を使い、
              `uc480_defs.EXPOSURE_CMD.IS_EXPOSURE_CMD_GET_EXPOSURE_RANGE_MIN`／
              `..._MAX`／`..._INC` の3つを個別に取得します。
              多くの実装は秒単位で値を返すため、ミリ秒に変換して返却します。
            - 呼び出しは機器固有の挙動に依存するため、安全に例外を吸収して
              取得失敗時は `None` を返します。これにより後方互換性を維持します。

                f"{self.log_tag} Exposure range retrieved: min={exp_min_ms:.5f}ms, max={exp_max_ms:.5f}ms, inc={exp_inc_ms:.5f}ms"
            - `step_ms`（step）は UI のスライダーや数値入力での最小刻み幅（インクリメント）を示します。
              例えば `step_ms=0.1` の場合、露光は 0.1ms 単位で変化することが期待できます。
            - 一部デバイスでは step が非整数や 0 に近い非常に小さい値になることがあるため、
              フロントエンドでは安全に丸め処理や下限チェックを行ってください。
        """
        # Mock のフォールバック（UI テスト用の妥当な既定値）
        if self.is_mock_env:
            # Mock 環境用のフォールバック:
            # - 下限: 0.06675ms (実測値に合わせる)
            # - 上限: 99.92475ms (実測値に合わせる)
            # - ステップ: 0.06675ms (実測値に合わせる)
            # キャッシュしておく（Mockでも繰り返し問い合わせを避ける）
            try:
                # モック環境で観測されたレンジを再現する（小数桁を損なわない）
                # 実機で観測されている例: (0.06675, 99.92475, 0.06675)
                self.exposure_min_ms = 0.06675
                self.exposure_max_ms = 99.92475
                self.exposure_step_ms = 0.06675
                self._exposure_range_cached = True
            except Exception:
                pass
            return (0.06675, 99.92475, 0.06675)

        # 未接続やカメラオブジェクト不在なら取得不可
        if not self.is_connected or self.camera is None:
            return None

        try:
            # pylablib の低レベル呼び出しを使って MIN/MAX/INC を取得する
            import ctypes
            from pylablib.devices.uc480 import uc480_defs

            if not (hasattr(self.camera, "lib") and hasattr(self.camera.lib, "is_Exposure")):
                logger.debug(f"{self.log_tag} is_Exposure API not available")
                return None

            try:
                # is_Exposure の呼び出しは実装ごとに戻り方が異なる可能性があるため
                # ここでは直接戻り値を受け取り、秒単位ならミリ秒へ変換する。
                #
                # 重要な設計注釈:
                # - この関数は「呼び出し側が camera オブジェクトを持っている場合にのみ
                #   実際のハードウェアへ問い合わせを行う」前提で実装されています。
                # - 高頻度の set_exposure 呼び出しではハードウェア問い合わせを避けるため、
                #   connect() 時に一度だけ範囲をキャッシュして使い回すことを想定しています。
                exp_min_sec = self.camera.lib.is_Exposure(
                    self.camera.hcam,
                    uc480_defs.EXPOSURE_CMD.IS_EXPOSURE_CMD_GET_EXPOSURE_RANGE_MIN,
                    ctypes.c_double,
                )
                exp_max_sec = self.camera.lib.is_Exposure(
                    self.camera.hcam,
                    uc480_defs.EXPOSURE_CMD.IS_EXPOSURE_CMD_GET_EXPOSURE_RANGE_MAX,
                    ctypes.c_double,
                )
                exp_inc_sec = self.camera.lib.is_Exposure(
                    self.camera.hcam,
                    uc480_defs.EXPOSURE_CMD.IS_EXPOSURE_CMD_GET_EXPOSURE_RANGE_INC,
                    ctypes.c_double,
                )

                # uc480 のこの API は、実測上ミリ秒単位の値を返すため、そのまま使う。
                # 以前は秒→ミリ秒換算を入れていたが、その結果 100ms 前後の値が
                # 100,000ms 級に膨らんでいた。今回のログの不自然な巨大レンジはこれが原因。
                exp_min_ms = float(exp_min_sec)
                exp_max_ms = float(exp_max_sec)
                exp_inc_ms = float(exp_inc_sec)

                # キャッシュしておく（以後の高頻度アクセスを避けるため）
                try:
                    self.exposure_min_ms = exp_min_ms
                    self.exposure_max_ms = exp_max_ms
                    self.exposure_step_ms = exp_inc_ms
                    self._exposure_range_cached = True
                except Exception:
                    logger.debug(f"{self.log_tag} Failed to cache exposure range")

                logger.debug(
                    f"{self.log_tag} Exposure range retrieved: min={exp_min_ms}ms, max={exp_max_ms}ms, inc={exp_inc_ms}ms"
                )
                return (exp_min_ms, exp_max_ms, exp_inc_ms)
            except Exception as e:
                # 低レベル呼び出しに失敗した場合は None を返して上位でフォールバック
                logger.debug(f"{self.log_tag} is_Exposure call failed: {e}")
                return None

        except ImportError:
            logger.debug(f"{self.log_tag} uc480_defs not available (expected in Mock or non-uc480 environment)")
            return None
        except Exception:
            logger.exception(f"{self.log_tag} Failed to read exposure range")
            return None

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

    def set_rois(self, rois: list):
        """解析対象の ROI リストを更新します"""
        with self._roi_lock:
            self.rois = rois
        logger.info(f"{self.log_tag} ROI list updated: {len(rois)} items")

    def set_centroid_calc_enabled(self, enabled: bool):
        """重心計算の有効/無効を切り替えます"""
        with self._roi_lock:
            self.enable_centroid_calc = enabled
        logger.info(f"{self.log_tag} Centroid calculation {'enabled' if enabled else 'disabled'}")

    def get_latest_roi_stats(self) -> dict:
        """最新フレームの ROI 解析結果を返します"""
        with self.frame_condition:
            return dict(self.latest_roi_stats)

    # ============================================================================
    # 【スナップショット】 take_snapshot / save_pending_snapshot
    # ============================================================================

    def take_snapshot(self, filename_override: Optional[str] = None, save_dir_override: Optional[str] = None, force_centroid: bool = False) -> Optional[dict]:
        """
        【Snapshot】最新のフレームを取得し、メモリに一時保持または自動保存します。
        単に画像を保存するだけでなく、その「撮影された瞬間の画像」に対して ROI 解析を
        即座に実行し、画像と数値を完全に紐付けた状態で返します。

        【マルチスレッド設計の重要性】
        このメソッドは、カメラが画像を撮り続けるスレッドとは別のスレッド（APIリクエスト等）から
        呼ばれます。そのため、データの整合性を守るための工夫が施されています。
        
        Args:
            filename_override: 指定された場合、自動生成されるタイムスタンプ名の代わりに
                               このファイル名（拡張子付き）を使用して保存します。
            save_dir_override: 指定された場合、設定画面の保存先ではなく
                               このディレクトリに保存します（自動測定用）。
            force_centroid: Trueの場合、カメラ設定の enable_centroid_calc に関係なく
                            必ず重心計算を実行します（Pre-Scan アライメント用）。
        """
        if not self.is_connected:
            return None
            
        with self.frame_condition:
            if self.latest_frame is None:
                logger.error(f"{self.log_tag} Snapshot failed: No frame available.")
                return None
            
            # --- 【最重要】画像の確保 (Deep Copy) ---
            # self.latest_frame はカメラが常に更新し続けている共有のメモリ空間にあります。
            # .copy() を行わずに参照だけを持ってしまうと、この後の解析や保存をしている最中に
            # 中身が次のフレームに書き換わってしまい、データに矛盾が生じる「レースコンディション」が起きます。
            # ここで独立したメモリ空間にコピーを作ることで、この時点の「静止画」を完全に固定し、
            # 後の解析と保存が「全く同じ画像」に対して行われることを保証します。
            frame = self.latest_frame.copy()
            angle = self.current_angle
            
        # ========================================================================
        # 【正確な計算】撮影した「この画像」に対して、その場で ROI 解析を実行
        # ========================================================================
        # 画面表示用のループ（30fps等）で行われている解析は、あくまでモニタリング用です。
        # 測定データとして保存する数値は、上記で確保した「保存対象の画像」そのものから
        # 算出しなければなりません。ここで再計算を行うことで、画像ファイルと数値の
        # 1:1 の物理的な対応関係を科学的に保証します。
        with self._roi_lock:
            current_rois = list(self.rois)
            current_enable_centroid = self.enable_centroid_calc or force_centroid
        
        # 確保した frame を使って計算を実行します。
        # ROIProcessor.calculate_stats は OpenCV を利用した高速な行列演算を行うため、
        # 実行時間は数ミリ秒〜数十ミリ秒程度と極めて短時間です。
        roi_stats = ROIProcessor.calculate_stats(frame, current_rois, current_enable_centroid)

        # 保存用フォーマットの決定（設定から取得。デフォルトは非可逆圧縮なしの TIFF）
        fmt = self.settings.get("imageFormat", "TIFF")
        save_img = frame
        
        # --- 画像形式の変換と現像処理 ---
        # 1. デモザイク処理 (Bayer to Color)
        # 本カメラのRawデータ（ベイヤー配列）は、そのままだと格子状の模様に見え、
        # 一般的な画像閲覧ソフトでは正しく表示されません。
        # プレビュー時と同様のカラー変換を施すことで、人間が見て理解できる「写真」にします。
        bayer_code = self._get_bayer_color_conversion_code()
        if bayer_code is not None:
            save_img = cv2.cvtColor(save_img, bayer_code)
            
        # 2. 8-bit スケーリング (Normalized for JPEG/PNG)
        # JPEG や PNG 形式は 16-bit データの保持に対応していない（または互換性が低い）ため、
        # 16-bit の階調を 8-bit (0-255) にスケーリング（正規化）します。
        # これにより、Windows フォトビューアーなどで開いた際も適切な明るさで表示されます。
        if fmt in ["JPEG", "PNG"] and save_img.dtype == np.uint16:
            save_img = cv2.normalize(save_img, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)
            
        # 返却用情報の構築
        # API 経由でフロントエンドに返される、このスナップショットの「全情報」をまとめます。
        result_info = {
            "angle": angle,           # 撮影時のステージ角度（理想値）
            "roi_stats": roi_stats,   # 撮影画像から直接計算された輝度統計
            "timestamp": time.time(), # 撮影完了時刻
            "filepath": None          # 保存された場合のファイルパス（後述の保存処理で設定）
        }

        # --- 保存処理 ---
        # 保存先ディレクトリの決定ロジック
        if save_dir_override:
            # 【自動測定モード】
            # 自動測定シーケンス側から指定された専用のディレクトリを使用します。
            # 通常、測定プロジェクトごとのサブフォルダなどが指定されます。
            target_dir = save_dir_override
            try:
                # ディレクトリが存在しない場合は自動で作成します（親ディレクトリも含む）。
                os.makedirs(target_dir, exist_ok=True)
            except Exception:
                logger.exception(f"{self.log_tag} Failed to create override directory: {target_dir}")
                return result_info
        else:
            # 【手動スナップショットモード】
            # 設定画面で「保存先を毎回尋ねる (askSavePath)」が有効な場合、
            # まだ保存先が決まっていないため、画像を一時的にメモリに保持して処理を中断します。
            if self.settings.get("askSavePath", False):
                self._pending_snapshot = save_img
                logger.info(f"{self.log_tag} Snapshot captured in memory. Waiting for save path...")
                result_info["filepath"] = "PENDING"
                return result_info
                
            # 「自動保存」設定の場合、設定画面で指定された出力ディレクトリを使用します。
            out_dir = self.settings.get("outputDirectory", os.getcwd())
            # スナップショット専用のサブディレクトリ "snapshots" を作成します。
            target_dir = os.path.join(out_dir, "snapshots")
            try:
                os.makedirs(target_dir, exist_ok=True)
            except Exception:
                logger.exception(f"{self.log_tag} Failed to create snapshot directory: {target_dir}")
                return result_info

        # ファイル名の決定ロジック
        if filename_override:
            # 【自動測定モード】角度情報を含んだ「ゼロ埋め」されたファイル名などが渡されます。
            filename = filename_override
        else:
            # 【手動スナップショットモード】プレフィックスと現在の時刻を組み合わせた名前を生成します。
            prefix = self.settings.get("snapshotPrefix", "snapshot_")
            timestamp_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            ext = ".tif" if fmt == "TIFF" else (".jpg" if fmt == "JPEG" else ".png")
            filename = f"{prefix}{timestamp_str}{ext}"
            
        filepath = os.path.join(target_dir, filename)
        
        # 最終的なフルパスをログに出力。
        # 保存に失敗した場合、このログを見ることで権限不足やパスの間違いを特定できます。
        logger.info(f"{self.log_tag} Snapshot target path: {filepath}")
        
        # ディスクへの物理的な書き込み。
        # OpenCV の `cv2.imwrite` を内部で呼び出し、成功すればファイルパスを返り値にセットします。
        if self._write_image_to_disk(filepath, save_img):
            result_info["filepath"] = filepath
            
        return result_info

    def save_pending_snapshot(self, filepath: str) -> bool:
        """【Snapshot】メモリに保持していた画像を、指定されたパスに保存する"""
        if self._pending_snapshot is None:
            logger.error(f"{self.log_tag} No pending snapshot to save.")
            return False
            
        # ユーザーがダイアログで選んだファイルパスをそのまま記録する。
        # 保存できなかった場合も、どのパスが問題だったかを後追いしやすくする。
        logger.info(f"{self.log_tag} Saving pending snapshot to: {filepath}")
        success = self._write_image_to_disk(filepath, self._pending_snapshot)
        self._pending_snapshot = None
        return success

    # ============================================================================
    # 【録画】 prepare_recording / trigger_recording / start_recording / stop_recording
    # ============================================================================

    def prepare_recording(self) -> bool:
        """【Recording】録画の事前準備（ファイル作成とオープン）を行う。
        
        Sweep測定時の「遅延ゼロ録画」のために使用します。
        このメソッドではTIFF/CSVファイルを作成して開きますが、`is_recording` フラグは False のままにします。
        そのため、裏で走っている `_capture_loop` (特急レーン) はまだ書き込みを開始しません（スタンバイ状態）。
        """
        if not self.is_connected or self.is_recording or self.tiff_writer is not None:
            return False

        out_dir = self.settings.get("outputDirectory", os.getcwd())
        prefix = self.settings.get("recordPrefix", "record_")
        # 直下にファイルをばら撒かず、録画専用のサブフォルダへ集約する。
        record_dir = os.path.join(out_dir, "videos")
        logger.info(
            f"{self.log_tag} Recording prepare requested: out_dir={out_dir}, record_dir={record_dir}, prefix={prefix}, keepRawTiff={self.settings.get('keepRawTiff', True)}"
        )
        try:
            os.makedirs(record_dir, exist_ok=True)
        except Exception:
            logger.exception(f"{self.log_tag} Failed to create recording output directory: {record_dir}")
            return False
        
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        self.record_filepath = os.path.join(record_dir, f"{prefix}{timestamp}.tif")
        logger.info(f"{self.log_tag} Recording target path: {self.record_filepath}")

        try:
            import tifffile
            csv_filepath = os.path.join(record_dir, f"{prefix}{timestamp}.csv")

            with self._recording_lock:
                # append=True モードで TIFF ファイルを開いておく（この処理に数十〜数百msかかる場合がある）
                self.tiff_writer = tifffile.TiffWriter(self.record_filepath, append=True)

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
                
                # 重要: ここでは is_recording = False のままとする（スタンバイ）
                # これにより、ファイルは開いているが、_capture_loop はまだ書き込みを行わない
            logger.info(f"{self.log_tag} Recording prepared (standby): {self.record_filepath}")
            return True
        except Exception:
            logger.exception(f"{self.log_tag} Failed to prepare recording")
            # 失敗した場合はクリーンアップ
            if self.tiff_writer: self.tiff_writer.close()
            if self.csv_file: self.csv_file.close()
            self.tiff_writer = None
            self.csv_file = None
            self.csv_writer = None
            return False

    def trigger_recording(self) -> bool:
        """【Recording】スタンバイ状態から録画を即座に開始する。
        
        Sweepの Start 角度を超えた瞬間に呼び出されます。
        `is_recording` フラグを True にする「だけ」の極めて軽量な処理です。
        フラグが立つと、裏で回っている `_capture_loop` が次のフレームから即座に TIFFへの直書きを開始します。
        """
        if not self.is_connected or self.is_recording or self.tiff_writer is None:
            return False
        with self._recording_lock:
            self.is_recording = True
        logger.info(f"{self.log_tag} Recording triggered: {self.record_filepath}")
        return True

    def start_recording(self) -> bool:
        """【Recording】動画の保存を開始する（準備＋即時トリガー）
        
        ヘッダーの手動録画ボタン等から呼ばれた場合に使用します。
        既存の挙動を変えないためのラッパー（包み紙）です。
        """
        if self.prepare_recording():
            return self.trigger_recording()
        return False

    def stop_recording(self) -> Optional[str]:
        """【Recording】動画の保存を停止し、事後処理（貨物レーン）をキックする"""
        # is_recording が False でも、prepare されて tiff_writer が開いているなら
        # 閉じる処理（キャンセル）へ進む必要があるため条件を緩和
        if not self.is_recording and self.tiff_writer is None:
            return None

        # capture loop 側と writer を取り合わないように、参照を切るところまでをロックする。
        with self._recording_lock:
            was_recording = self.is_recording
            self.is_recording = False
            tiff_writer = self.tiff_writer
            csv_file = self.csv_file
            self.tiff_writer = None
            self.csv_file = None
            self.csv_writer = None

        if tiff_writer is not None:
            tiff_writer.close()

        # CSVファイルも閉じて、ライターオブジェクトもリセットする
        if csv_file is not None:
            csv_file.close()
            
        logger.info(f"{self.log_tag} Recording stopped: {self.record_filepath} (was_recording={was_recording})")
        
        # 録画が開始されておらず（準備段階でキャンセルされた等）、フレームが0なら
        # MP4変換などは不要なのでここで終了
        if not was_recording or self.record_frame_count == 0:
            return self.record_filepath

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
        consecutive_failures = 0
        should_trigger_reconnect = False
        
        while self.is_connected:
            start_time = time.time()
            
            frame_data = self._grab_image_from_hardware_or_mock()
            if frame_data is None:
                if not self.is_mock_env:
                    consecutive_failures += 1
                    # ========================================================================
                    # 【自己修復しきい値の緩和（ゾンビ・自滅防止）】
                    # USBハブ共有環境での一時的なデータ衝突による TimeoutError は、カメラを切断せず
                    # 単なる1コマのフレームドロップ（スキップ）として受け流します。
                    # 10回連続（約10秒間）で失敗し、完全に通信が絶たれた場合のみ、物理抜去やハングと
                    # みなして自動再起動（自己修復）を起動します。
                    # ========================================================================
                    if consecutive_failures >= 10:
                        logger.error(f"{self.log_tag} Consecutive capture failures detected ({consecutive_failures}). Triggering auto-reconnect...")
                        should_trigger_reconnect = True
                        self.is_connected = False
                        break
                time.sleep(0.1)
                continue
            
            consecutive_failures = 0

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

            # 【生データ（RAW）の保持】
            # 8-bitカメラからは uint8、10-bit以上のカメラからは uint16 が渡されます。
            # 値を一切加工（掛け算など）せず、型の整合性だけを整えて保持します。
            # これにより、定量解析（自動測定等）においてノイズやカウント値の重みが狂うのを防ぎます。
            raw_frame = self._get_raw_frame(frame_data, src_bpp)

            # ========================================================================
            # 【ROI解析】表示・モニタリング用（リアルタイム路）
            # ========================================================================
            # カメラから届いたばかりの生データ（raw_frame）を用いて、指定された領域を解析します。
            # この計算は毎フレーム実行され、UIの数値表示をリアルタイムに更新するために使われます。
            # ※自動測定の記録用には、ここでの「流し見」の数値ではなく、Snapshot 時の正確な数値を使用します。
            with self._roi_lock:
                # 解析対象の ROI リストと、重心計算を行うかどうかのフラグを安全に取得。
                current_rois = list(self.rois)
                current_enable_centroid = self.enable_centroid_calc
            
            # ROIProcessor を呼び出して計算。
            # raw_frame はまだ書き換えられていない最新のフレームデータです。
            roi_stats = ROIProcessor.calculate_stats(raw_frame, current_rois, current_enable_centroid)

            with self.frame_condition:
                # プレビュー用画像（8-bit）を更新。
                self.latest_preview = preview
                
                # 生データ（raw_frame）を最新フレームとして保持。
                # この latest_frame は、take_snapshot() が呼ばれた際にコピー元のソースとなります。
                self.latest_frame = raw_frame
                
                # 計算結果を保存。UI 側はこの値を GET /camera/roi_stats で取得して表示します。
                self.latest_roi_stats = roi_stats
                
                # 新しいフレームが準備できたことを、wait() で待機している他のスレッドに通知します。
                self.frame_condition.notify_all()

            # --- 設計上の注意 ---
            # 以前はここでデータをバッファに常時蓄積（垂れ流し）していましたが、
            # 「今、この瞬間を測る」という測定の厳密さを期すため、
            # 自動測定用のデータ蓄積は、明示的に take_snapshot() が呼ばれたタイミングに限定されました。

            # ========================================================================
            # 【録画処理】特急レーン（超高速・直書き）
            # ========================================================================
            # ハードウェアキャプチャと同期して、フレームを TIFF と CSV に即座に直書き。
            # キューを使わず直書きする理由: 不可逆圧縮なし、フレーム喪失なし、ディスク性能を活用。
            # 複数スレッドでの TIFF 書き込みは安全（append=True モード）。
            # CSV も同時に書き込み、画像時刻とステージ角度の対応付けを保持。
            if self.is_recording:
                with self._recording_lock:
                    tiff_writer = self.tiff_writer
                    csv_writer = self.csv_writer
                    record_index = self.record_frame_count
                    if tiff_writer is not None and csv_writer is not None and record_index < self.MAX_FRAMES:
                        # 【重要】録画時もスケーリングは行わず、生データをそのまま書き込みます。
                        # tifffile ライブラリは、write_frame が uint8 なら 8-bit TIFF を、
                        # uint16 なら 16-bit TIFF を自動的に生成してくれます。
                        write_frame = raw_frame

                        frame_timestamp_ms = time.time() * 1000.0
                        angle_sample_timestamp_ms = self.current_angle_timestamp_ms

                        if angle_sample_timestamp_ms <= 0.0:
                            angle_sample_timestamp_ms = frame_timestamp_ms

                        angle_age_ms = max(0.0, frame_timestamp_ms - angle_sample_timestamp_ms)
                        self.record_frame_count += 1
                    else:
                        tiff_writer = None
                        csv_writer = None

                if tiff_writer is not None and csv_writer is not None:
                    if record_index >= self.MAX_FRAMES:
                        logger.warning(f"{self.log_tag} Max recording frames ({self.MAX_FRAMES}) reached! Auto-stopping.")
                        self.stop_recording()
                    else:
                        try:
                            tiff_writer.write(write_frame, contiguous=True)
                            csv_writer.writerow([
                                record_index,
                                f"{frame_timestamp_ms:.3f}",
                                f"{self.current_angle:.4f}",
                                f"{angle_sample_timestamp_ms:.3f}",
                                f"{angle_age_ms:.3f}",
                                f"{self.input_bpp}",
                            ])
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

        # 連続エラーによる停止の場合、自分自身のスレッド（_capture_thread）の干渉を受けないよう、
        # 新しい別スレッドを立ち上げてカメラの自動再接続・自己修復処理（disconnect() ➔ connect()）を実行します。
        if should_trigger_reconnect:
            threading.Thread(target=self._run_auto_reconnect, daemon=True).start()

    def _run_auto_reconnect(self):
        """【自己修復（オートリカバリー）機能の実行スレッド】
        一時的なUSB瞬断やノイズによってカメラがフリーズした際、自動で復旧を試みるメソッドです。

        【スレッドの排他・安全設計に関する教育的解説】
        画像キャプチャを行う `_capture_thread` 自身が動作したまま、そのスレッドの内部から
        `disconnect()`（内部で `.join()` による自身の終了待ちを行う）を呼び出してしまうと、
        「自分自身が終了するのを自分で待つ」ことになり、永久に処理が進まないデッドロック状態が発生します。
        
        この罠を防ぐため、本実装では以下の手順で安全にスレッドを切り替えて処理します。
        1. 異常を検知したキャプチャスレッドは、`self.is_connected = False` をセットして自身のループを直ちにブレイク・正常終了する。
        2. キャプチャスレッドが終了した直後、スレッドの末尾から「この独立した別スレッド（_run_auto_reconnect）」を新しく起動する。
        3. このスレッドの中で `disconnect()` を呼ぶことで、すでに動いていない旧キャプチャスレッドの `.join()` は
           タイムラグなしで即座に通過し、安全かつ確実に古いカメラハンドルを破棄・再起動することができます。
        """
        logger.info(f"{self.log_tag} Auto-reconnect thread started.")
        try:
            # 1. 現在適用されていた露出時間・ゲインの設定値を退避
            old_exposure = self.exposure_ms
            old_gain = self.gain
            old_camera_id = getattr(self, "camera_id", 1)

            logger.info(f"{self.log_tag} Saved parameters for auto-healing: exposure={old_exposure}ms, gain={old_gain}")

            # 2. ハングアップしたカメラを完全に安全クローズ（切断）
            #    ※自分自身のスレッドはすでに停止して抜けているため、disconnect()内のjoin()も即座に通過します。
            self.disconnect()

            # 3. USBポートのリセットおよびデバイス状態が落ち着くのを待つため、2秒間待機します
            time.sleep(2.0)

            # 4. 再接続を最大 5回試みます
            reconnect_success = False
            for attempt in range(5):
                logger.info(f"{self.log_tag} Auto-reconnect attempt {attempt+1}/5...")
                try:
                    # 【重要】ここではまだ画像取得スレッド（_capture_loop）を起動しません。
                    # 起動直後に設定変更処理と撮影処理が競合し、カメラが再自滅するのを防ぐためです。
                    if self.connect(camera_id=old_camera_id, start_loop=False):
                        reconnect_success = True
                        break
                except Exception as e:
                    logger.warning(f"{self.log_tag} Connect attempt {attempt+1} failed: {e}")
                time.sleep(2.0)

            if not reconnect_success:
                logger.error(f"{self.log_tag} Auto-reconnect failed after maximum retries. Camera requires manual physical reconnection.")
                return

            # 5. 再接続が成功したら、退避していた設定値を順に再適用します
            logger.info(f"{self.log_tag} Auto-reconnect succeeded! Restoring parameters...")
            if old_exposure is not None:
                self.set_exposure(old_exposure)
            if old_gain is not None:
                self.set_gain(old_gain)
            
            # 【直列化の完了】設定の再適用が100%完了したことを保証した「後」に、画像取得スレッドを安全に起動します。
            self.start_capture_loop()
            logger.info(f"{self.log_tag} Camera self-healing process successfully completed.")

        except Exception as e:
            logger.exception(f"{self.log_tag} Exception occurred in auto-reconnect thread: {e}")

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
            # 露出やゲイン変更などの設定操作と同時にカメラにアクセスするのを防ぐため、ロックで保護します。
            with self._camera_lock:
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

    def _get_raw_frame(self, frame: np.ndarray, src_bpp: int) -> np.ndarray:
        """
        【重要】カメラから受信したフレームデータを、スケーリング（値の引き伸ばし）を一切行わずに
        真の生データ（RAW）としてそのまま返すヘルパー関数です。

        引数:
            frame (np.ndarray): カメラドライバから取得した画像データ（Numpy配列）。
            src_bpp (int): センサーの入力ビット深度（8, 10, 12, 16など）。

        戻り値:
            np.ndarray: 値の加工を行っていない、生のカウント値を持つNumpy配列。
                        8-bitの場合は uint8、それ以上（10-bit等）の場合は uint16 の型になります。

        【変更の意図と理論的背景】
        以前の実装では、8-bitのデータを16-bitフルレンジ（0-65535）に合わせるために
        値を掛け算（リニアスケーリング）して引き伸ばしていました。
        しかし、定量的な光散乱強度測定においては、「センサーに光子が何個当たったか」という
        生のカウント値（1カウントの重み）を正確に保持することが最も重要です。
        スケーリングを行ってしまうと、ノイズが不当に増幅され、解析時のS/N比評価が狂うため、
        この関数では受け取ったデータを一切加工せずにそのまま上位（保存・解析モジュール）へ流します。

        使用している標準ライブラリ（NumPy）の解説:
            np.ndarray: 数値計算に特化した多次元配列。画像データはピクセル値の2次元配列として表現されます。
            frame.dtype: その配列が持っているデータの「型」（8ビット整数、16ビット整数など）を表します。
        """
        if frame is None:
            return None

        # 既にuint16、または8bitより大きい（10-bit等）データの場合は、
        # 型が欠損しないように uint16 として扱います（値自体は変更しません）。
        if src_bpp > 8 or frame.dtype == np.uint16:
            return frame.astype(np.uint16)

        # 8-bitデータの場合は、ストレージ容量とI/O速度の最適化のため、
        # そのまま uint8 として扱います。
        return frame.astype(np.uint8)

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
            # 保存対象の画像情報を debug ログに残す。
            # どの dtype / shape の画像を書こうとしていたかを追えるようにし、
            # 保存形式の不一致や空フレームを切り分けやすくする。
            logger.debug(
                f"{self.log_tag} Writing image: path={filepath}, dtype={getattr(img, 'dtype', None)}, shape={getattr(img, 'shape', None)}"
            )
            if filepath.lower().endswith(('.tif', '.tiff')):
                import tifffile
                tifffile.imwrite(filepath, img)
            else:
                cv2.imwrite(filepath, img)
            logger.info(f"{self.log_tag} Snapshot saved to: {filepath}")
            return True
        except Exception as e:
            parent_dir = os.path.dirname(filepath) or os.getcwd()
            # Permission denied などの失敗時に、単なる例外メッセージだけでなく
            # 親ディレクトリの存在・書き込み可否・例外種別まで残す。
            # Windows 実機での権限問題を解析しやすくするための診断情報です。
            logger.exception(
                f"{self.log_tag} Snapshot save error: path={filepath}, parent_dir={parent_dir}, "
                f"parent_exists={os.path.exists(parent_dir)}, parent_writable={os.access(parent_dir, os.W_OK)}, "
                f"error_type={type(e).__name__}, errno={getattr(e, 'errno', None)}, strerror={getattr(e, 'strerror', None)}"
            )
            return False

    def _post_process_video(self, tiff_path: str, is_color: bool, keep_raw: bool):
        """【貨物レーン】録画完了後に巨大なTIFFをMP4等に変換する"""
        logger.info(f"{self.log_tag} [Post-Process] Started for {tiff_path}")
        # TODO: tifffileで各フレームを読み込み、OpenCVのVideoWriter等でMP4を生成する処理を実装する
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
        import uuid
        my_stream_id = uuid.uuid4().hex
        self.active_stream_id = my_stream_id
        logger.info(f"{self.log_tag} Starting MJPEG stream (id={my_stream_id})")
        
        try:
            while self.is_connected:
                # 【ゾンビ接続の自動排除とスレッドプール枯渇の防止】
                # ビューの切り替えやリサイズにより、新しく /camera/video_feed 接続要求が来ると、
                # グローバルな `self.active_stream_id` が新しいストリームID（UUID）に上書きされます。
                # 自分が「最新のアクティブなストリーム」でなくなったことを検知した時点で、
                # この古い映像配信ループを即座に break して、FastAPI（anyio）のスレッドプールへ
                # 同期スレッドリソースを安全かつ速やかに返却（解放）します。
                if self.active_stream_id != my_stream_id:
                    logger.info(f"{self.log_tag} Discarding old MJPEG stream (id={my_stream_id})")
                    break

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
                # OpenCV の imencode() で JPEG に圧縮
                # 品質を 98 に設定し、プレビューでも画素の輪郭を可能な限り鮮明に保ちます。
                ret, buffer = cv2.imencode('.jpg', display_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 98])
                if not ret:
                    continue
                    
                frame_bytes = buffer.tobytes()

                # MJPEG配信フォーマット
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        finally:
            logger.info(f"{self.log_tag} MJPEG stream ended (id={my_stream_id})")
