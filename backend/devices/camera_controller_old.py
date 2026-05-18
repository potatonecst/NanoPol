import numpy as np
import cv2
import platform
import time
import ctypes
import threading
import queue
import csv
import os
import datetime
from typing import Tuple, Optional

# pyueyeライブラリのインポートを試みる
# インストールされていない場合や、DLLが見つからない場合はMockモードに移行するためのフラグを立てる
PYUEYE_IMPORT_ERROR = None
PYUEYE_MODULE_FILE = None
try:
    from pyueye import ueye
    HAS_PYUEYE = True
    PYUEYE_MODULE_FILE = getattr(ueye, "__file__", None)
except ImportError as e:
    HAS_PYUEYE = False
    PYUEYE_IMPORT_ERROR = str(e)

from utils.logger import logger

if PYUEYE_IMPORT_ERROR:
    logger.warning(f"[CAMERA INIT] pyueye import failed: {PYUEYE_IMPORT_ERROR}")

class CameraController:
    def __init__(self):
        self.h_cam = None # カメラハンドル（デバイスを識別するID）
        self.mem_ptr = None # 画像メモリへのポインタ（C言語のメモリアドレス）
        self.mem_id = None # メモリID
        self.width = 0 # 画像の幅（ピクセル）
        self.height = 0 # 画像の高さ（ピクセル）
        self.bpp = 16  # Bits per pixel (16-bit RAW)
        self.pitch = 0 # 画像1行あたりのバイト数（パディング含む）
        
        self.is_connected = False # カメラが現在接続されているかどうかのフラグ
        self.has_pyueye = HAS_PYUEYE # pyueye import 成功可否（診断API用）
        self.pyueye_import_error = PYUEYE_IMPORT_ERROR # import失敗理由（診断API用）
        self.pyueye_module_file = PYUEYE_MODULE_FILE # import済みpyueyeモジュールファイル位置（診断API用）
        # pyueyeがない、またはMac環境（ドライバ非対応）の場合はMockモードにする
        # uEyeのドライバは主にWindows/Linux向けで、Mac対応は限定的であるため。
        self.is_mock_env = not HAS_PYUEYE or platform.system() == "Darwin"
        self.log_tag = "[CAMERA-MOCK]" if self.is_mock_env else "[CAMERA]" # ログ出力用のプレフィックス
        
        # 状態・設定の保持
        self.settings = {} # フロントエンドから受け取った設定（config.jsonの内容）を保持する辞書
        self.is_recording = False # 現在録画中（TIFF直書き中）かどうかのフラグ
        self.tiff_writer = None # tifffileのTiffWriterオブジェクト。録画中のみインスタンス化される
        self.record_filepath = None # 現在録画中の動画ファイルの絶対パス
        
        self.csv_file = None # 同期記録用CSVのファイルオブジェクト
        self.csv_writer = None # 同期記録用CSVのライター
        self.record_frame_count = 0 # 現在の録画フレーム数
        self.MAX_FRAMES = 10000 # 安全装置（Fail-safe）としての最大録画フレーム数
        
        # ステージの現在の角度（測定・Sweep中にFastAPIやStageController側から随時更新される想定）
        self.current_angle = 0.0 
        # current_angle が更新された時刻（UNIX epoch ms）
        self.current_angle_timestamp_ms = 0.0

        # Camera settings
        self.exposure_ms = 10.0 # 露出時間（ミリ秒）
        self.gain = 50 # センサーのハードウェアゲイン（0〜100）
        self.is_color_mode = False # プレビュー・スナップショット時のカラー(True)/モノクロ(False)指定

        # 【スレッド間通信: ブロードキャスト（黒板とベル）方式】
        # Queue(トレイ)方式では「誰かが画像を取ると消える」ため、複数画面でのフレーム奪い合い（カクつき）が発生していました。
        # Condition方式では、最新の画像を1枚だけ保持(黒板)し、更新時に全待機スレッドへ一斉通知(ベル)します。
        # これにより、PCとスマホで同時にアクセスしても、それぞれが独立して最新画像を参照でき、奪い合いが起きません。
        self.latest_frame = None
        self.frame_condition = threading.Condition()

        self._capture_thread = None # 特急レーン（最速で画像を取得し続ける）のバックグラウンドスレッド
        self._mock_angle = 0.0 # Mock画像生成用の内部状態
        self._pending_snapshot = None # Snapshot時に「保存先を聞く」設定の場合、一時的に画像データを保持するメモリ

        # 起動時にカメラ実行モードの判定根拠を明示する（切り分け用）
        logger.info(
            "[CAMERA INIT] mode=%s os=%s HAS_PYUEYE=%s",
            "Mock" if self.is_mock_env else "Real",
            platform.system(),
            HAS_PYUEYE,
        )
        
    def connect(self, camera_id: int = 0) -> bool:
        """
        カメラに接続し、初期化・メモリ確保・キャプチャスレッドの起動を行います。

        Args:
            camera_id (int): 接続するカメラのデバイスID。デフォルトは0。

        Returns:
            bool: 接続および初期化が成功した場合は True、失敗した場合は False。
        """
        if self.is_connected:
            return True

        if self.is_mock_env:
            self.is_connected = True
            self.width = 1280
            self.height = 1024
            logger.info(f"{self.log_tag} Connected to Virtual Camera (ID: {camera_id})")
        
        elif not HAS_PYUEYE:
            logger.error("[CAMERA] pyueye library not found.")
            return False
        else:
            # 実機カメラの初期化
            self.h_cam = ueye.HIDS(camera_id) # Camera handle
            ret = ueye.is_InitCamera(self.h_cam, None)
            if ret != ueye.IS_SUCCESS:
                logger.error(f"[CAMERA] InitCamera failed. Ret: {ret}")
                self.h_cam = None
                return False
                
            self.is_connected = True
            logger.info(f"{self.log_tag} Connected to Camera ID {camera_id}")
            
            # 常に16-bit RAW (Bayer) モードでデータを取得する
            self.bpp = 16
            ueye.is_SetColorMode(self.h_cam, ueye.IS_CM_SENSOR_RAW16)
            
            # センサー情報を取得して、最大解像度を設定
            sensor_info = ueye.SENSORINFO()
            ueye.is_GetSensorInfo(self.h_cam, sensor_info)
            self.width = int(sensor_info.nMaxWidth)
            self.height = int(sensor_info.nMaxHeight)
            
            # メモリ確保
            self.mem_ptr = ueye.c_mem_p()
            self.mem_id = ueye.int()
            
            ueye.is_AllocImageMem(self.h_cam, self.width, self.height, self.bpp, self.mem_ptr, self.mem_id)
            ueye.is_SetImageMem(self.h_cam, self.mem_ptr, self.mem_id)
            
            # Pitch（1行あたりのバイト数）の取得
            pc_pitch = ueye.int()
            ueye.is_GetImageMemPitch(self.h_cam, pc_pitch)
            self.pitch = int(pc_pitch)
            
            # 初期設定の適用
            self.set_exposure(self.exposure_ms)
            self.set_gain(self.gain)

        # 特急レーン（キャプチャスレッド）を起動
        # threading.Thread: 新しいスレッド（並行処理の単位）を作成する。
        # 引数:
        #   target: スレッドで実行する関数 (ここでは self._capture_loop)
        #   daemon=True: メインプログラム（APIサーバーなど）が終了した際に、このスレッドも道連れにして強制終了させる設定。
        self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
        # start(): スレッドの実行を実際に開始する。
        self._capture_thread.start()

        return True

    def disconnect(self) -> None:
        """
        カメラから切断し、確保した画像メモリの解放やキャプチャスレッドの停止を安全に行います。
        """
        self.is_connected = False
        if self._capture_thread and self._capture_thread.is_alive():
            # join(): 指定したスレッドの終了を待つ。
            # 引数:
            #   timeout=2.0: 最大2.0秒間だけ待機し、それでも終わらなければ待機を解除して次の処理へ進む。
            self._capture_thread.join(timeout=2.0) # スレッドの終了を待つ

        if not self.is_mock_env and self.h_cam is not None:
            # メモリ開放とカメラ終了処理
            if self.mem_ptr is not None:
                ueye.is_FreeImageMem(self.h_cam, self.mem_ptr, self.mem_id)
            
            ueye.is_ExitCamera(self.h_cam)
            self.h_cam = None

        logger.info(f"{self.log_tag} Disconnected")

    def _capture_loop(self) -> None:
        """
        【特急レーン】バックグラウンドで常に画像を全力で取得し、トレイ（キュー）に入れるループ処理。
        別スレッドで実行され、録画中は超高速でディスクへの直書き(TIFF追記)も担います。
        """
        logger.info(f"{self.log_tag} Capture thread started.")
        while self.is_connected:
            start_time = time.time()
            
            frame_data = self._grab_image_from_hardware_or_mock()
            if frame_data is None:
                time.sleep(0.1) # 取得失敗時は少し待つ
                continue

            # 【ブロードキャスト通知】
            # 最新の画像を黒板(latest_frame)に上書きし、寝て待っている全員(配信スレッド)をベルで起こす。
            # ※特急レーン(録画)はこの後すぐに自身の処理(TIFF直書き)に移るため、配信スレッド側がモタついていても
            #   録画のパフォーマンス（FPS）には一切の悪影響を与えません。
            with self.frame_condition:
                self.latest_frame = frame_data
                self.frame_condition.notify_all()

            # --- 録画処理 (特急レーン: 巨大なTIFFファイルへの超高速・直書き) ---
            # 画像のエンコード等の重い処理は一切行わず、生データをそのまま追記する
            if self.is_recording and self.tiff_writer is not None and self.csv_writer is not None:
                if self.record_frame_count >= self.MAX_FRAMES:
                    logger.warning(f"{self.log_tag} Max recording frames ({self.MAX_FRAMES}) reached! Auto-stopping for Fail-safe.")
                    self.stop_recording()
                else:
                    try:
                        # contiguous=True によりディスクへの書き込み速度を最適化
                        self.tiff_writer.write(frame_data, contiguous=True)

                        # フレーム保存時刻（ms）を記録し、角度サンプルの鮮度を同時に出力する
                        frame_timestamp_ms = time.time() * 1000.0
                        angle_sample_timestamp_ms = self.current_angle_timestamp_ms

                        # ステージ未接続などで角度サンプル時刻が未設定のときは、同時刻扱いにする
                        if angle_sample_timestamp_ms <= 0.0:
                            angle_sample_timestamp_ms = frame_timestamp_ms

                        angle_age_ms = max(0.0, frame_timestamp_ms - angle_sample_timestamp_ms)
                        self.csv_writer.writerow([
                            self.record_frame_count,
                            f"{frame_timestamp_ms:.3f}",
                            f"{self.current_angle:.4f}",
                            f"{angle_sample_timestamp_ms:.3f}",
                            f"{angle_age_ms:.3f}",
                        ])
                        
                        self.record_frame_count += 1
                    except Exception as e:
                        logger.error(f"{self.log_tag} Error writing frame to TIFF/CSV: {e}")

            # CPU暴走防止（Mock環境のみ、計算が一瞬で終わるので待つ）
            if self.is_mock_env:
                elapsed = time.time() - start_time
                sleep_time = max(0, (1.0 / 30.0) - elapsed) # 約30fpsに制限
                time.sleep(sleep_time)
                
        logger.info(f"{self.log_tag} Capture thread stopped.")

    def _reallocate_memory(self, new_bpp: int) -> None:
        """
        カメラのビット深度(bpp)を変更し、それに合わせてPC側のメモリバッファを再確保します。
        主に8-bit録画の開始・終了時に、ハードウェアレベルでのモード切替を行うために使用します。

        Args:
            new_bpp (int): 新しいビット深度（8 または 16）。
        """
        if self.bpp == new_bpp or not self.is_connected:
            return
            
        self.bpp = new_bpp
        logger.info(f"{self.log_tag} Reallocating memory for {new_bpp}-bit mode")
        
        if not self.is_mock_env and self.h_cam is not None:
            # 1. 既存のメモリ解放
            if self.mem_ptr is not None:
                ueye.is_FreeImageMem(self.h_cam, self.mem_ptr, self.mem_id)
                
            # 2. ハードウェアのモード切替
            color_mode = ueye.IS_CM_SENSOR_RAW8 if new_bpp == 8 else ueye.IS_CM_SENSOR_RAW16
            ueye.is_SetColorMode(self.h_cam, color_mode)
            
            # 3. メモリの再確保
            self.mem_ptr = ueye.c_mem_p()
            self.mem_id = ueye.int()
            ueye.is_AllocImageMem(self.h_cam, self.width, self.height, self.bpp, self.mem_ptr, self.mem_id)
            ueye.is_SetImageMem(self.h_cam, self.mem_ptr, self.mem_id)
            
            pc_pitch = ueye.int()
            ueye.is_GetImageMemPitch(self.h_cam, pc_pitch)
            self.pitch = int(pc_pitch)

    def _grab_image_from_hardware_or_mock(self) -> Optional[np.ndarray]:
        """
        カメラから生データを取得し、Numpy配列として返すメソッド。
        パフォーマンスを最大化するため、カメラからのDMA（Direct Memory Access）転送とゼロコピー（Zero-copy）技術を使用します。
        """
        if not self.is_connected:
            return None
            
        if self.is_mock_env:
            # Mock画像生成: 一旦8-bitで描画してから16-bitにスケールアップする
            # np.zeros(): 指定された形状とデータ型の、すべての要素が0（黒）のNumpy配列を作成する。
            # 引数: shape=(高さ, 幅), dtype=データ型 (np.uint8 は 8-bit符号なし整数)
            img_8 = np.zeros((self.height, self.width), dtype=np.uint8)
            
            cx = int(self.width / 2 + 150 * np.cos(self._mock_angle))
            cy = int(self.height / 2 + 150 * np.sin(self._mock_angle))
            self._mock_angle += 0.05
            
            # cv2.circle(): 画像に円を描画する。
            # 引数: (対象画像, 中心座標(x,y), 半径, 色(0-255), 線の太さ(-1で塗りつぶし))
            cv2.circle(img_8, (cx, cy), 50, 255, -1)
            
            # cv2.putText(): 画像にテキストを描画する。
            # 引数: (対象画像, 文字列, 左下座標(x,y), フォント, サイズスケール, 色(0-255), 線の太さ)
            cv2.putText(img_8, f"MOCK {time.strftime('%H:%M:%S')}", (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, 255, 2)
            
            # np.random.randint(): 指定された範囲のランダムな整数を持つNumpy配列を生成する。
            # 引数: low(最小値), high(最大値未満), size=(高さ, 幅), dtype=データ型
            noise = np.random.randint(0, 30, (self.height, self.width), dtype=np.uint8)
            
            # cv2.add(): 2つのNumpy配列の要素同士を足し合わせる。上限(255)を超えた場合は255にクリップされる(飽和演算)。
            img_8 = cv2.add(img_8, noise)
            
            if self.bpp == 8:
                return img_8
            else:
                # 16-bitに変換 (上位8bitにシフト)
                # astype(): Numpy配列のデータ型を変換する。
                img_16 = img_8.astype(np.uint16) * 256
                return img_16

        # 実機キャプチャ処理
        # is_FreezeVideo: カメラデバイスに対し、内部メモリの最新フレームをPC側のRAM（確保済みバッファ）へ
        # DMA (Direct Memory Access) 転送させる命令です。CPUに負荷をかけずに超高速でメモリが書き換わります。
        # 引数 ueye.IS_WAIT: 転送が完了するまでこのスレッドを待機（ブロック）させます。
        ret = ueye.is_FreezeVideo(self.h_cam, ueye.IS_WAIT)
        if ret == ueye.IS_SUCCESS:
            # メモリからのデータ取り出し（Pitch考慮）
            
            # 1. バッファ全体のサイズ計算 (高さ * 1行のバイト数)
            total_size = self.height * self.pitch
            
            # 2. C言語のポインタから、Pythonのバイト配列としてアクセスできるようにする
            # ctypes.addressof でポインタのアドレスを取得し、そこから total_size 分の配列を作成
            c_array = (ctypes.c_ubyte * total_size).from_address(ctypes.addressof(self.mem_ptr.contents))
            
            # np.frombuffer(): メモリ上のバッファ（バイト列）をコピーせずに直接Numpy配列として読み込む。超高速。
            raw_data = np.frombuffer(c_array, dtype=np.uint8)
            
            # bppに応じたNumpy配列の構築
            # np.lib.stride_tricks.as_strided(): メモリ上のデータを「どのように区切って配列として見せるか」を再定義する。
            # これにより、パディング（余白）を含むカメラの生データを、無駄なコピーなしに正確な2次元画像として抽出できる。
            # 引数: x (元データ), shape=(高さ, 幅), strides=(1行進むためのバイト数, 1列進むためのバイト数)
            if self.bpp == 8:
                image_data = np.lib.stride_tricks.as_strided(
                    raw_data,
                    shape=(self.height, self.width),
                    strides=(self.pitch, 1) # 1画素1バイト
                ).copy()
            else:
                # 16-bit画像としてビューを作成
                # pitchは「バイト単位」の行幅なので、stridesでは (pitch, 2バイト) となる
                image_data = np.lib.stride_tricks.as_strided(
                    raw_data.view(np.uint16),
                    shape=(self.height, self.width),
                    strides=(self.pitch, 2) # 1画素2バイト
                ).copy()
            
            return image_data
            
        logger.error(f"[CAMERA] Capture failed: {ret}")
        return None

    def set_exposure(self, ms: float):
        """カメラの露光時間を設定します (単位: ミリ秒)"""
        self.exposure_ms = ms
        if self.is_mock_env:
            logger.info(f"{self.log_tag} Set Exposure: {ms}ms")
            return
            
        # uEye APIはdouble型を要求するため変換
        new_exp = ueye.double(ms)
        ueye.is_Exposure(self.h_cam, ueye.IS_EXPOSURE_CMD_SET_EXPOSURE, new_exp, 8)
        logger.info(f"{self.log_tag} Set Exposure: {ms}ms")

    def set_gain(self, val: int):
        """センサーのハードウェアゲインを設定します (0〜100)"""
        self.gain = val
        if self.is_mock_env:
            logger.info(f"{self.log_tag} Set Gain: {val}")
            return
            
        # ハードウェアゲイン設定 (0-100)
        ueye.is_SetHardwareGain(self.h_cam, val, ueye.IS_IGNORE_PARAMETER, ueye.IS_IGNORE_PARAMETER, ueye.IS_IGNORE_PARAMETER)
        logger.info(f"{self.log_tag} Set Gain: {val}")

    def set_color_mode(self, is_color: bool):
        """フロントエンドからのプレビューカラーモード設定を受け取る"""
        self.is_color_mode = is_color
        logger.info(f"{self.log_tag} Preview Color Mode set to: {'Color' if is_color else 'Monochrome'}")

    def update_settings(self, new_settings: dict):
        """フロントエンドからの設定(config.jsonの内容など)をバックエンドに反映する"""
        self.settings.update(new_settings)
        
        # カラーモードの反映
        if "cameraMode" in new_settings:
            self.set_color_mode(new_settings["cameraMode"] == "Color")
            
        logger.info(f"{self.log_tag} Settings updated: {new_settings}")

    def take_snapshot(self) -> Optional[str]:
        """【Snapshot】最新のフレームを取得し、メモリに一時保持または自動保存する"""
        if not self.is_connected:
            return None
            
        # スナップショットも黒板から最新画像をコピー（参照）するだけです。
        # 画像を「奪う」わけではないので、裏で動いているMJPEG配信を一切妨害しません。
        with self.frame_condition:
            if self.latest_frame is None:
                logger.error(f"{self.log_tag} Snapshot failed: No frame available.")
                return None
            frame = self.latest_frame
            
        fmt = self.settings.get("imageFormat", "TIFF")
        save_img = frame
        
        # モードとフォーマットに応じた画像変換
        if self.is_color_mode:
            save_img = cv2.cvtColor(save_img, cv2.COLOR_BayerRG2BGR)
            
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
        self._pending_snapshot = None # 保存が完了したらメモリを解放
        return success

    def _write_image_to_disk(self, filepath: str, img: np.ndarray) -> bool:
        """【内部用】Numpy配列を画像ファイルとしてディスクに保存します（TIFF/JPEG/PNG自動判別）"""
        try:
            if filepath.lower().endswith(('.tif', '.tiff')):
                import tifffile
                # tifffile.imwrite(): Numpy配列をTIFFフォーマットでディスクに保存する。
                # OpenCVのimwriteと違い、16-bitやBayer配列の生データを劣化や丸め込みなしで正確に保存できる。
                tifffile.imwrite(filepath, img)
            else:
                # cv2.imwrite(): Numpy配列を画像ファイル（JPEG, PNGなど）として保存する。
                # 拡張子からフォーマットを自動判別してエンコードを行う。
                cv2.imwrite(filepath, img)
            logger.info(f"{self.log_tag} Snapshot saved to: {filepath}")
            return True
        except Exception as e:
            logger.error(f"{self.log_tag} Snapshot save error: {e}")
            return False

    def start_recording(self) -> bool:
        """【Recording】動画（マルチページTIFF）の保存を開始する（常に自動保存）"""
        if not self.is_connected or self.is_recording:
            return False
            
        # 8-bitモード指定なら、カメラハードウェア自体を8-bitモードに切り替える
        if self.settings.get("recordFormat", "16-bit TIFF") == "8-bit TIFF":
            self._reallocate_memory(8)
            
        # 動画はSSD直書きのリアルタイム性が重要なため、ダイアログは出さずに常に自動保存とする
        out_dir = self.settings.get("outputDirectory", os.getcwd())
        prefix = self.settings.get("recordPrefix", "record_")
        os.makedirs(out_dir, exist_ok=True)
        
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        self.record_filepath = os.path.join(out_dir, f"{prefix}{timestamp}.tif")
        
        try:
            import tifffile
            csv_filepath = os.path.join(out_dir, f"{prefix}{timestamp}.csv")
            
            # append=True モードでライターを開きっぱなしにする
            # tifffile.TiffWriter(): マルチページTIFFファイルへ連続書き込みを行うためのライターオブジェクトを作成する。
            # 引数 append=True: 既存のファイルを開き、そこに新しい画像を追加していくモード。
            # 効果: 動画フレームごとに「ファイルを開く→閉じる」という重い処理を省略でき、SSDの限界速度で保存し続けられる。
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
            ])
            self.record_frame_count = 0
            
            # 全ての準備が成功した場合にのみ、録画中フラグを立てる（重要）
            self.is_recording = True
            logger.info(f"{self.log_tag} Recording started: {self.record_filepath}")
            return True
        except Exception as e:
            logger.error(f"{self.log_tag} Failed to start recording: {e}")
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
            
        # 8-bit録画だった場合、待機モード(16-bit)に復帰させる
        if self.bpp == 8:
            self._reallocate_memory(16)
            
        logger.info(f"{self.log_tag} Recording stopped: {self.record_filepath}")
        
        # MP4への自動変換がONなら、重い処理を非同期スレッド(貨物レーン)に投げる
        if self.settings.get("autoConvertMp4", False):
            threading.Thread(
                target=self._post_process_video, 
                args=(self.record_filepath, self.is_color_mode, self.settings.get("keepRawTiff", True)),
                daemon=True
            ).start()
            
        return self.record_filepath

    def _post_process_video(self, tiff_path: str, is_color: bool, keep_raw: bool):
        """【貨物レーン】録画完了後に巨大なTIFFをMP4等に変換する"""
        logger.info(f"{self.log_tag} [Post-Process] Started for {tiff_path}")
        # TODO: tifffileで各フレームを読み込み、OpenCVのVideoWriter等でMP4を生成する処理を実装
        time.sleep(2) # 変換処理のモック
        logger.info(f"{self.log_tag} [Post-Process] Completed.")

    def get_available_cameras(self):
        """
        Returns a list of available cameras.
        """
        if self.is_mock_env:
            logger.info(
                "[CAMERA ENUM] mode=Mock reason=%s",
                "Darwin" if platform.system() == "Darwin" else "pyueye-unavailable",
            )
            return [
                {"id": 0, "name": "Mock Camera A (Virtual)", "model": "Simulated-100", "serial": "SIM001"},
            ]
        
        if not HAS_PYUEYE:
            return []

        # 実機の実装: 接続されているカメラの数を取得
        num_cameras = ueye.int()
        ret = ueye.is_GetNumberOfCameras(num_cameras)
        if ret == ueye.IS_SUCCESS:
            n = int(num_cameras)
            cameras = []
            
            if n > 0:
                # 【高度な実装】C言語の構造体をPythonで動的に定義する
                # uEye APIの `is_GetCameraList` は、カメラの台数によってサイズが変わる可変長構造体を受け取ります。
                # C言語での定義: struct { ULONG dwCount; UEYE_CAMERA_INFO uci[n]; }
                class UEYE_CAMERA_LIST_DYN(ctypes.Structure):
                    # _fields_ は ctypes.Structure の必須属性で、メモリレイアウトを定義します。
                    # 構文: [("フィールド名", 型), ...] のリスト形式。定義順にメモリに配置されます。
                    _fields_ = [
                        ("dwCount", ueye.c_ulong), # 1つ目の要素: 台数 (unsigned long)
                        
                        # 2つ目の要素: カメラ情報の配列
                        # Pythonの `型 * 整数` という構文で、C言語の固定長配列型を作成できます。
                        # ここでは実行時に取得した n を使って、必要な分だけメモリを確保しています。
                        ("uci", ueye.UEYE_CAMERA_INFO * n) 
                    ]
                
                # 構造体のインスタンスを作成し、バッファサイズ（台数）を設定
                cam_list = UEYE_CAMERA_LIST_DYN()
                cam_list.dwCount = ueye.c_ulong(n)
                
                # カメラリストを取得するAPI呼び出し
                # Pythonのオブジェクト(cam_list)のアドレスを、C言語のポインタ型(PUEYE_CAMERA_LIST)に
                # 強制的にキャスト（型変換）して渡す必要があります。
                if ueye.is_GetCameraList(ctypes.cast(ctypes.pointer(cam_list), ueye.PUEYE_CAMERA_LIST)) == ueye.IS_SUCCESS:
                    for i in range(n):
                        # 構造体の配列から各カメラの情報を取り出す
                        info = cam_list.uci[i]
                        cameras.append({
                            "id": int(info.dwCameraID), # カメラID（不揮発メモリに保存されている値）
                            "name": f"uEye Camera {int(info.dwCameraID)}",
                            "model": info.Model.decode('utf-8', errors='ignore'), # バイト列を文字列にデコード
                            "serial": info.SerNo.decode('utf-8', errors='ignore') # シリアルナンバー
                        })
                else:
                    logger.warning("[CAMERA ENUM] is_GetCameraList failed")
            logger.info("[CAMERA ENUM] mode=Real count=%d", len(cameras))
            return cameras

        logger.warning("[CAMERA ENUM] is_GetNumberOfCameras failed ret=%s", ret)
        return []

    def generate_frames(self):
        """
        【各駅停車レーン】キューから最新の画像を取り出し、JPEG圧縮して配信するジェネレータ関数。
        
        FastAPIの StreamingResponse と組み合わせて使用され、
        HTTPの「multipart/x-mixed-replace」という仕組みを使って動画をブラウザに配信します。
        """
        logger.info(f"{self.log_tag} Starting MJPEG stream")
        
        while self.is_connected:
            with self.frame_condition:
                # 【待機と受信】
                # wait() を呼ぶと、このスレッドは一時停止(Sleep)し、CPU使用率が0%になります。
                # 特急レーンから notify_all() (ベル) が鳴らされると即座に目覚め、最新画像を取得します。
                if not self.frame_condition.wait(timeout=1.0) or self.latest_frame is None:
                    continue
                frame_data = self.latest_frame

            # 16-bit RAWデータを表示用に8-bitに変換
            # センサーの有効ビット数(10-bit等)に関わらず、0-255の範囲にスケーリング(正規化)して表示する
            if frame_data.dtype == np.uint16:
                display_frame = cv2.normalize(frame_data, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)
            else:
                display_frame = frame_data

            # カラーモードがONの場合、Bayer配列をデモザイクしてフルカラー(BGR)にする
            if self.is_color_mode:
                # ※実際のカメラのBayerパターン(RGGBなど)に合わせて
                # cv2.COLOR_BayerBG2BGR 等に変更が必要な場合があります。
                display_frame = cv2.cvtColor(display_frame, cv2.COLOR_BayerRG2BGR)

            # JPEGに圧縮 (ここで時間がかかっても、特急レーンには影響しない)
            # cv2.imencode(): 画像をメモリ上で指定のフォーマット（ここでは.jpg）のバイナリデータに圧縮（エンコード）する。
            # 戻り値 ret: 成功可否のブール値, buffer: エンコードされた1次元のNumpy配列
            ret, buffer = cv2.imencode('.jpg', display_frame)
            if not ret:
                continue
                
            # tobytes(): Numpy配列を純粋なPythonのバイト列（bytes）に変換する。通信で送信するため。
            frame_bytes = buffer.tobytes()

            # yield: returnと似ていますが、関数を終了させずに値を返し、次呼ばれた時はその続きから再開します。
            # これにより、無限ループの中で次々と画像データをサーバーからクライアントへ「押し出す(Push)」ことができます。
            # 
            # 配信フォーマット (MJPEG形式):
            # --frame (境界線/バウンダリ。前の画像を破棄して新しい画像を上書きさせる合図)
            # Content-Type: image/jpeg (これから送るのはJPEG画像ですという宣言)
            # (空行)
            # [バイナリデータ]
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
