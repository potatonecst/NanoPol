import numpy as np
import cv2
import platform
import time
import ctypes
from typing import Tuple, Optional

# pyueyeライブラリのインポートを試みる
# インストールされていない場合や、DLLが見つからない場合はMockモードに移行するためのフラグを立てる
try:
    from pyueye import ueye
    HAS_PYUEYE = True
except ImportError:
    HAS_PYUEYE = False

from utils.logger import logger

class CameraController:
    def __init__(self):
        self.h_cam = None # カメラハンドル（デバイスを識別するID）
        self.mem_ptr = None # 画像メモリへのポインタ（C言語のメモリアドレス）
        self.mem_id = None # メモリID
        self.width = 0
        self.height = 0
        self.bpp = 24  # Bits per pixel (RGB)
        self.pitch = 0 # 画像1行あたりのバイト数（パディング含む）
        
        self.is_connected = False
        # pyueyeがない、またはMac環境（ドライバ非対応）の場合はMockモードにする
        # uEyeのドライバは主にWindows/Linux向けで、Mac対応は限定的であるため。
        self.is_mock_env = not HAS_PYUEYE or platform.system() == "Darwin"
        self.log_tag = "[CAMERA-MOCK]" if self.is_mock_env else "[CAMERA]"
        
        # Camera settings
        self.exposure_ms = 10.0
        self.gain = 50
        
    def connect(self, camera_id: int = 0):
        if self.is_mock_env:
            self.is_connected = True
            self.width = 1280
            self.height = 1024
            logger.info(f"{self.log_tag} Connected to Virtual Camera (ID: {camera_id})")
            return True
        
        if not HAS_PYUEYE:
            logger.error("[CAMERA] pyueye library not found.")
            return False

        # 実機カメラの初期化
        self.h_cam = ueye.HIDS(camera_id) # Camera handle
        ret = ueye.is_InitCamera(self.h_cam, None)
        if ret != ueye.IS_SUCCESS:
            logger.error(f"[CAMERA] InitCamera failed. Ret: {ret}")
            return False
            
        self.is_connected = True
        logger.info(f"{self.log_tag} Connected to Camera ID {camera_id}")
        
        # カラーモード設定: BGR8 Packed (24bit)
        # OpenCVはデフォルトでBGR順なので、これに合わせると変換の手間が省ける
        ueye.is_SetColorMode(self.h_cam, ueye.IS_CM_BGR8_PACKED) # 24 bpp
        
        # センサー情報を取得して、最大解像度を設定
        sensor_info = ueye.SENSORINFO() # Sensor Info structure
        ueye.is_GetSensorInfo(self.h_cam, sensor_info) # Fill structure
        self.width = int(sensor_info.nMaxWidth) # Maximum Width
        self.height = int(sensor_info.nMaxHeight) # Maximum Height
        
        # メモリ確保 (Allocate Memory)
        # PCのRAM上に、カメラ画像を保存するための領域を確保します。
        self.mem_ptr = ueye.c_mem_p() # C言語のポインタ型変数を準備
        self.mem_id = ueye.int() # メモリIDを入れる変数を準備
        
        ueye.is_AllocImageMem(self.h_cam, self.width, self.height, self.bpp, self.mem_ptr, self.mem_id) # Allocate memory
        ueye.is_SetImageMem(self.h_cam, self.mem_ptr, self.mem_id) # Set memory
        
        # Pitch（1行あたりのバイト数）の取得
        # 【重要】ハードウェアによっては、メモリ効率化のために行の末尾に「パディング（詰め物）」を入れることがあります。
        # これを考慮せずに width * 3 で読み込むと、画像が斜めにズレてしまいます。
        # 必ず is_GetImageMemPitch で正しいストライド幅を取得する必要があります。
        pc_pitch = ueye.int()
        ueye.is_GetImageMemPitch(self.h_cam, pc_pitch)
        self.pitch = int(pc_pitch)
        
        # 初期設定の適用
        self.set_exposure(self.exposure_ms)
        self.set_gain(self.gain)
        
        return True

    def disconnect(self):
        if self.is_mock_env:
            self.is_connected = False
            logger.info(f"{self.log_tag} Disconnected")
            return

        if self.h_cam is not None:
            # メモリ開放とカメラ終了処理
            if self.mem_ptr is not None:
                ueye.is_FreeImageMem(self.h_cam, self.mem_ptr, self.mem_id)
            
            ueye.is_ExitCamera(self.h_cam)
            self.h_cam = None
            
        self.is_connected = False
        logger.info(f"{self.log_tag} Disconnected")

    def capture_frame(self) -> Optional[bytes]:
        """
        Captures a single frame and returns it as JPEG bytes.
        """
        if not self.is_connected:
            return None
            
        if self.is_mock_env:
            # Mock画像生成: ノイズ + 動く円
            img = np.zeros((self.height, self.width, 3), dtype=np.uint8)
            
            # Draw something dynamic based on time
            t = time.time()
            cx = int((np.sin(t * 2) + 1) / 2 * (self.width - 200)) + 100
            cy = int((np.cos(t * 2) + 1) / 2 * (self.height - 200)) + 100
            
            # Background grid
            cv2.line(img, (0, cy), (self.width, cy), (30, 30, 30), 1)
            cv2.line(img, (cx, 0), (cx, self.height), (30, 30, 30), 1)
            
            # Moving object
            cv2.circle(img, (cx, cy), 50, (0, 255, 100), -1)
            cv2.putText(img, f"MOCK CAMERA", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
            cv2.putText(img, f"Exp: {self.exposure_ms}ms / Gain: {self.gain}", (50, 90), cv2.FONT_HERSHEY_PLAIN, 1.5, (200, 200, 200), 1)
            
            # Add some noise
            noise = np.random.randint(0, 30, (self.height, self.width, 3), dtype=np.uint8)
            img = cv2.add(img, noise)
            
            success, encoded_img = cv2.imencode('.jpg', img)
            return encoded_img.tobytes() if success else None

        # 実機キャプチャ処理
        # is_FreezeVideo: カメラの内部メモリにある画像を、PC側の確保したメモリに転送・固定します。
        ret = ueye.is_FreezeVideo(self.h_cam, ueye.IS_WAIT)
        if ret == ueye.IS_SUCCESS:
            # メモリからのデータ取り出し（Pitch考慮）
            
            # 1. バッファ全体のサイズ計算 (高さ * 1行のバイト数)
            total_size = self.height * self.pitch
            
            # 2. C言語のポインタから、Pythonのバイト配列としてアクセスできるようにする
            # ctypes.addressof でポインタのアドレスを取得し、そこから total_size 分の配列を作成
            c_array = (ctypes.c_ubyte * total_size).from_address(ctypes.addressof(self.mem_ptr.contents))
            raw_data = np.frombuffer(c_array, dtype=np.uint8)
            
            # 3. as_strided を使って、パディングをスキップしながら読み込むビューを作成
            # strides引数で「次の行に行くには pitch バイト進む」「次の画素に行くには 3 バイト進む」と指定します。
            # これにより、データコピーなしで正しい形状の配列として扱えます。
            image_data = np.lib.stride_tricks.as_strided(
                raw_data,
                shape=(self.height, self.width, 3),
                strides=(self.pitch, 3, 1)
            )
            
            # 4. OpenCVでエンコードするために、連続したメモリ領域にコピーを作成 (.copy())
            success, encoded_img = cv2.imencode('.jpg', image_data.copy())
            return encoded_img.tobytes() if success else None
            
        logger.error(f"[CAMERA] Capture failed: {ret}")
        return None

    def set_exposure(self, ms: float):
        self.exposure_ms = ms
        if self.is_mock_env:
            logger.info(f"{self.log_tag} Set Exposure: {ms}ms")
            return
            
        # uEye APIはdouble型を要求するため変換
        new_exp = ueye.double(ms)
        ueye.is_Exposure(self.h_cam, ueye.IS_EXPOSURE_CMD_SET_EXPOSURE, new_exp, 8)
        logger.info(f"{self.log_tag} Set Exposure: {ms}ms")

    def set_gain(self, val: int):
        self.gain = val
        if self.is_mock_env:
            logger.info(f"{self.log_tag} Set Gain: {val}")
            return
            
        # ハードウェアゲイン設定 (0-100)
        ueye.is_SetHardwareGain(self.h_cam, val, ueye.IS_IGNORE_PARAMETER, ueye.IS_IGNORE_PARAMETER, ueye.IS_IGNORE_PARAMETER)
        logger.info(f"{self.log_tag} Set Gain: {val}")

    def get_available_cameras(self):
        """
        Returns a list of available cameras.
        """
        if self.is_mock_env:
            return [
                {"id": 0, "name": "Mock Camera A (Virtual)", "model": "Simulated-100", "serial": "SIM001"},
            ]
        
        if not HAS_PYUEYE:
            return []

        # 実機の実装: 接続されているカメラの数を取得
        num_cameras = ueye.int()
        if ueye.is_GetNumberOfCameras(num_cameras) == ueye.IS_SUCCESS:
            n = int(num_cameras)
            cameras = []
            
            # [注意] 本来は is_GetCameraList で詳細情報を取得すべきですが、
            # 簡易的に ID:1 から順に存在するものとしてリストを作成しています。
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
            return cameras
        
        return []

    def generate_frames(self):
        # MJPEGストリーミング用のジェネレータ関数。
        # yield を使って、無限に画像データを返し続けます。
        logger.info(f"{self.log_tag} Starting MJPEG stream")
        
        # FPS制御用
        target_fps = 30
        frame_interval = 1.0 / target_fps
        
        while self.is_connected:
            start_time = time.time()
            
            # --- 画像取得 ---
            # Mockの場合、この内部で「動く丸」を描画している
            frame_bytes = self.capture_frame()
            
            if frame_bytes:
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n') # MJPEGのパート境界フォーマット
            else:
                # エラーや取得失敗時は少し待ってリトライ（CPU暴走防止）
                time.sleep(0.1)
                continue
            
            # --- FPS調整 ---
            # Mockの場合、計算が一瞬で終わるため、全力で回すとCPU負荷が高くなりすぎます。
            # target_fps に合わせて sleep を入れます。
            elapsed = time.time() - start_time
            if self.is_mock_env:
                sleep_time = max(0, frame_interval - elapsed)
                time.sleep(sleep_time)
            else:
                # 実機でも高FPS過ぎる場合のガードとしてごく短時間待つか、
                # あるいは露光時間が短い場合のみ待つ
                if elapsed < frame_interval:
                    time.sleep(frame_interval - elapsed)
