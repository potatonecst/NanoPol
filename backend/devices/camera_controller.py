import numpy as np
import cv2
import platform
import time
import ctypes
from typing import Tuple, Optional

# Try importing pyueye, fallback to mock if missing
try:
    from pyueye import ueye
    HAS_PYUEYE = True
except ImportError:
    HAS_PYUEYE = False

from utils.logger import logger

class CameraController:
    def __init__(self):
        self.h_cam = None # Camera handle
        self.mem_ptr = None # Pointer to image memory
        self.mem_id = None # Memory ID
        self.width = 0
        self.height = 0
        self.bpp = 24  # Bits per pixel (RGB)
        self.pitch = 0 # Line width in bytes
        
        self.is_connected = False
        # If pyueye is missing or OS is not Windows/Linux (depending on driver support), use Mock
        # Generally uEye drivers are Windows/Linux. Mac support is limited/non-existent for some models.
        self.is_mock_env = not HAS_PYUEYE or platform.system() == "Darwin"
        
        # Camera settings
        self.exposure_ms = 10.0
        self.gain = 50
        
    def connect(self, camera_id: int = 0):
        if self.is_mock_env:
            self.is_connected = True
            self.width = 1280
            self.height = 1024
            logger.info(f"[CAMERA-MOCK] Connected to Virtual Camera (ID: {camera_id})")
            return True
        
        if not HAS_PYUEYE:
            logger.error("[CAMERA] pyueye library not found.")
            return False

        # Real Camera Initialization
        self.h_cam = ueye.HIDS(camera_id) # Camera handle
        ret = ueye.is_InitCamera(self.h_cam, None)
        if ret != ueye.IS_SUCCESS:
            logger.error(f"[CAMERA] InitCamera failed. Ret: {ret}")
            return False
            
        self.is_connected = True
        logger.info(f"[CAMERA] Connected to Camera ID {camera_id}")
        
        # Set Color Mode
        ueye.is_SetColorMode(self.h_cam, ueye.IS_CM_BGR8_PACKED) # 24 bpp
        
        # Get Sensor Info to set width/height
        sensor_info = ueye.SENSORINFO() # Sensor Info structure
        ueye.is_GetSensorInfo(self.h_cam, sensor_info) # Fill structure
        self.width = int(sensor_info.nMaxWidth) # Maximum Width
        self.height = int(sensor_info.nMaxHeight) # Maximum Height
        
        # Allocate Memory
        self.mem_ptr = ueye.c_mem_p() # Pointer to image memory C言語のポインタ型変数を準備
        self.mem_id = ueye.int() # Memory ID メモリIDを入れる変数を準備
        
        ueye.is_AllocImageMem(self.h_cam, self.width, self.height, self.bpp, self.mem_ptr, self.mem_id) # Allocate memory
        ueye.is_SetImageMem(self.h_cam, self.mem_ptr, self.mem_id) # Set memory
        
        # Get Pitch (Line width in bytes)
        # Use is_GetImageMemPitch to get the correct stride/pitch including hardware padding
        pc_pitch = ueye.int()
        ueye.is_GetImageMemPitch(self.h_cam, pc_pitch)
        self.pitch = int(pc_pitch)
        
        # Set default parameters
        self.set_exposure(self.exposure_ms)
        self.set_gain(self.gain)
        
        return True

    def disconnect(self):
        if self.is_mock_env:
            self.is_connected = False
            logger.info("[CAMERA-MOCK] Disconnected")
            return

        if self.h_cam is not None:
            # Free memory
            if self.mem_ptr is not None:
                ueye.is_FreeImageMem(self.h_cam, self.mem_ptr, self.mem_id)
            
            ueye.is_ExitCamera(self.h_cam)
            self.h_cam = None
            
        self.is_connected = False
        logger.info("[CAMERA] Disconnected")

    def capture_frame(self) -> Optional[bytes]:
        """
        Captures a single frame and returns it as JPEG bytes.
        """
        if not self.is_connected:
            return None
            
        if self.is_mock_env:
            # Generate Mock Image (Noise + Moving Circle)
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

        # Real Capture
        # Freeze video is simple for single frame capture
        ret = ueye.is_FreezeVideo(self.h_cam, ueye.IS_WAIT)
        if ret == ueye.IS_SUCCESS:
            # Extract data from memory with proper stride handling
            
            # 1. Total buffer size = height * pitch
            total_size = self.height * self.pitch
            
            # 2. Access memory as a 1D byte array
            c_array = (ctypes.c_ubyte * total_size).from_address(ctypes.addressof(self.mem_ptr.contents))
            raw_data = np.frombuffer(c_array, dtype=np.uint8)
            
            # 3. Use as_strided to handle padding (pitch) without copying yet
            # strides = (bytes_per_row, bytes_per_pixel_col, bytes_per_channel)
            # pitch is bytes per row. 3 is bytes per pixel (BGR). 1 is byte per channel.
            image_data = np.lib.stride_tricks.as_strided(
                raw_data,
                shape=(self.height, self.width, 3),
                strides=(self.pitch, 3, 1)
            )
            
            # 4. Make a copy to get a contiguous standard array for OpenCV
            success, encoded_img = cv2.imencode('.jpg', image_data.copy())
            return encoded_img.tobytes() if success else None
            
        logger.error(f"[CAMERA] Capture failed: {ret}")
        return None

    def set_exposure(self, ms: float):
        self.exposure_ms = ms
        if self.is_mock_env:
            logger.info(f"[CAMERA-MOCK] Set Exposure: {ms}ms")
            return
            
        # uEye uses double for exposure
        new_exp = ueye.double(ms)
        ueye.is_Exposure(self.h_cam, ueye.IS_EXPOSURE_CMD_SET_EXPOSURE, new_exp, 8)
        logger.info(f"[CAMERA] Set Exposure: {ms}ms")

    def set_gain(self, val: int):
        self.gain = val
        if self.is_mock_env:
            logger.info(f"[CAMERA-MOCK] Set Gain: {val}")
            return
            
        # uEye gain is 0-100 master gain
        ueye.is_SetHardwareGain(self.h_cam, val, ueye.IS_IGNORE_PARAMETER, ueye.IS_IGNORE_PARAMETER, ueye.IS_IGNORE_PARAMETER)
        logger.info(f"[CAMERA] Set Gain: {val}")

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

        # Real implementation using ueye.is_GetNumberOfCameras
        num_cameras = ueye.int()
        if ueye.is_GetNumberOfCameras(num_cameras) == ueye.IS_SUCCESS:
            n = int(num_cameras)
            cameras = []
            
            # [WARNING] uEye Camera IDs are persistent and may not be sequential (1, 2, 3...).
            # Proper implementation requires 'is_GetCameraList' with C-structs.
            # For this prototype, we ASSUME the connected camera has ID 1.
            # If you have multiple cameras or custom IDs, this needs a fix.
            if n > 0:
                # 簡易的に ID:1 だけを返す、あるいは ID:1〜ID:n を返す
                for i in range(1, n + 1):
                    cameras.append({
                        "id": i, 
                        "name": f"uEye Camera (ID: {i})", 
                        "model": "DCC1645C", 
                        "serial": "Unknown"
                    })
            return cameras
        
        return []

    def generate_frames(self):
        """
        Generator function for MJPEG streaming.
        Handles both Mock (simulated motion) and Real (hardware capture).
        """
        prefix = "[CAMERA-MOCK]" if self.is_mock_env else "[CAMERA]"
        logger.info(f"{prefix} Starting MJPEG stream")
        
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
                       b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
            else:
                # エラーや取得失敗時は少し待ってリトライ（CPU暴走防止）
                time.sleep(0.1)
                continue
            
            # --- FPS調整 ---
            # Realカメラの場合、露光時間で待たされるのでSleepはほぼ不要だが、
            # Mockの場合は計算が速すぎるのでSleepが必要。
            elapsed = time.time() - start_time
            if self.is_mock_env:
                sleep_time = max(0, frame_interval - elapsed)
                time.sleep(sleep_time)
            else:
                # 実機でも高FPS過ぎる場合のガードとしてごく短時間待つか、
                # あるいは露光時間が短い場合のみ待つ
                if elapsed < frame_interval:
                     time.sleep(frame_interval - elapsed)

