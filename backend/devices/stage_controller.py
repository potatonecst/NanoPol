import serial
import time
#import logging
import platform
from typing import Tuple

from utils.logger import logger

#logger = logging.getLogger("uvicorn")

class StageController:
    def __init__(self):
        self.ser = None
        self.is_mock_env = platform.system() != "Windows" #Windows以外のOSではMock環境とみなす
        self.is_connected = False
        
        #ステージ仕様 (OSMS-60YAW)
        #分解能: Full=0.005deg/pulse, Half=0.0025deg/pulse 
        #GSC-01のデフォルトはHalfステップ駆動 
        #したがって、1度 = 1 / 0.0025 = 400 パルス
        self.pulses_per_degree = 400
        
        self._mock_pulse = 0 #Mock用の内部変数
    
    def update_settings(self, pulses_per_degree: int):
        self.pulses_per_degree = pulses_per_degree
        logger.info(f"[STAGE] Update Resolution: {self.pulses_per_degree} pulses/deg")
    
    def connect(self, port: str, baudrate: int = 9600):
        #接続処理
        #Mac: 強制的にMock接続
        #Windows: 実機接続を試み、失敗したらエラーを投げる（Mockにはしない）
        if self.is_mock_env:
            self.is_connected = True
            logger.info(f"[STAGE-MOCK] Connected to Virtual Device (OS: {platform.system()})")
            return True
        
        #Windows実機環境
        try:
            self.ser = serial.Serial(
                port=port,
                baudrate=baudrate, #9600 or 38400
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1.0, #タイムアウト
                xonxoff=False,
                rtscts=True, #ハードウェアフロー制御: 有効
                dsrdtr=False,
            )
            self.is_connected = True
            logger.info(f"[STAGE-REAL] Connected to Real Device at {port}")
            
            #接続確認: バージョン情報の問い合わせなど
            #self._send_command("?:V")
            
            return True
        except serial.SerialException as e:
            logger.error(f"[STAGE-REAL] Connection Failed: {e}")
            self.ser = None
            self.is_connected = False
            raise e
    
    def close(self):
        if self.ser and self.ser.is_open:
            self.ser.close()
            logger.info("[STAGE] Connection closed")
        
        self.ser = None
        self.is_connected = False
    
    def _send_command(self, cmd: str):
        #コマンド送信とレスポンス受信（CR+LF終端）
        if self.is_mock_env:
            logger.debug(f"[STAGE-MOCK] Send: {cmd}")
            return "OK"
        
        if not self.ser or not self.ser.is_open:
            raise Exception("Device not connected")
        
        try:
            #コマンド送信（CR+LF）
            full_cmd = f"{cmd}\r\n"
            self.ser.write(full_cmd.encode("ascii"))
            
            #レスポンス受信
            response = self.ser.readline().decode("ascii").strip()
            #logger.debug(f"[STAGE] Send: {cmd} / Recv: {response}")
            
            return response
        except Exception as e:
            logger.error(f"[STAGE] Communication Error: {e}")
            
            raise e
    
    #---座標変換---
    
    #角度をパルスに変換
    def _deg_to_pulse(self, deg: float) -> int:
        return int(round(deg * self.pulses_per_degree)) #四捨五入してパルス数を整数化
    
    #パルスを角度に変換
    def _pulse_to_deg(self, pulse: int) -> float:
        return float(pulse) / self.pulses_per_degree
    
    #---操作メソッド---
    
    #原点復帰
    def home(self):
        #H:（機械原点復帰命令）
        logger.info("[Stage] Homing...")
        
        if self.is_mock_env:
            time.sleep(2)
            self._mock_pulse = 0
            logger.info("[Stage] Homed (Mock)")
            return True
        
        resp = self._send_command("H:1")
        
        if resp == "OK":
            logger.info("[Stage] Homed")
            return True
        else:
            logger.error(f"[Stage] Homing Error. Resp: {resp}")
            return False
    
    #絶対移動
    def move_absolute(self, target_angle: float):
        #A:1+Pxxx -> G:（絶対移動パルス数設定命令 -> 駆動命令）
        target_pulse = self._deg_to_pulse(target_angle)
        direction = "+"if target_pulse >= 0 else "-"
        abs_pulse = abs(target_pulse)
        
        logger.info(f"[STAGE] Move Abs to {target_angle} deg ({direction}{abs_pulse} pulses)")
        
        #Mockモードの場合
        if self.is_mock_env:
            time.sleep(0.5)
            self._mock_pulse = target_pulse
            logger.info(f"[STAGE] Move Abs Complete (Mock): {target_angle} deg")
            return True
        
        #移動量設定コマンド A:1{+/-}P{pulse}
        cmd_a = f"A:1{direction}P{abs_pulse}"
        resp_a = self._send_command(cmd_a)
        
        if resp_a != "OK":
            logger.error(f"[STAGE] Move setup failed: {resp_a}")
            return False
        
        #駆動コマンド G:
        resp_g = self._send_command("G:")
        
        if resp_g == "OK":
            logger.info(f"[STAGE] Move Abs Command Sent: {target_angle} deg")
            return True
        else:
            logger.error(f"[STAGE] Move Abs Command Failed: {resp_g}")
            return False
    
    #相対移動
    def move_relative(self, delta_angle: float):
        #M1+Pxxx -> G:（相対移動パルス数設定命令 -> 駆動命令）
        delta_pulse = self._deg_to_pulse(delta_angle)
        
        #ゼロなら何もしない
        if delta_angle == 0:
            return True
        
        direction = "+" if delta_pulse >= 0 else "-"
        abs_pulse = abs(delta_pulse)
        
        logger.info(f"[STAGE] Move Rel {delta_angle} deg ({direction}{abs_pulse} pulses)")
        
        #Mockモードの場合
        if self.is_mock_env:
            time.sleep(0.2)
            self._mock_pulse += delta_pulse
            logger.info(f"[STAGE] Move Rel Complete (Mock): {delta_angle} deg")
            return True
        
        #移動量設定コマンド M:1{+/-}P{pulse}
        cmd_m = f"M:1{direction}P{abs_pulse}"
        resp_m = self._send_command(cmd_m)
        
        if resp_m != "OK":
            logger.error(f"[STAGE] Move setup failed: {resp_m}")
            return False
        
        #駆動コマンド G:
        resp_g = self._send_command("G:")
        
        if resp_g == "OK":
            logger.info(f"[STAGE] Move Rel Command Sent: {delta_angle} deg")
            return True
        else:
            logger.error(f"[STAGE] Move Rel Command Failed: {resp_g}")
            return False
    
    #スピード指定
    def set_speed(self, min_pps: int, max_pps: int, accel_time_ms: int):
        #D:（速度設定命令）
        logger.info(f"[STAGE] Set Speed: ={min_pps}, F={max_pps}, ={accel_time_ms}")
        
        if self.is_mock_env:
            return True
        
        #速度設定コマンド D:1S{min}F{max}R{accel}
        cmd = f"D:1S{min_pps}F{max_pps}R{accel_time_ms}"
        resp = self._send_command(cmd)
        
        return resp == "OK"
    
    #停止
    def stop(self, immediate: bool = False):
        #L:1 or L:E（減速停止命令または即停止命令）
        logger.info(f"[STAGE] Stopping... (Immediate={immediate})")
        if self.is_mock_env:
            logger.info("[STAGE] Stopped (Mock)")
            return True
        
        cmd = "L:E" if immediate else "L:1" #immediate=TrueでL:E
        resp = self._send_command(cmd)
        
        if resp == "OK":
            logger.info("[STAGE] Stop Command Sent")
            return True
        else:
            logger.error(f"[STAGE] Stop Command Failed: {resp}")
            return False

    #状態取得(戻り値: 現在の角度（float）, Busyかどうか（bool）)
    def get_status(self) -> Tuple[float, bool]:
        #Q:（ステータス確認1命令: ステージ動作状況、座標値を返送）
        #フォーマット: 座標値, ACK1, ACK2, ACK3
        #座標値: 符号含めて10桁固定（正符号は省略）
        #ACK1: X -> コマンドエラー, K -> コマンド正常受付
        #ACK2: L -> リミットセンサで停止, K -> 正常停止
        #ACK3: B -> Busy状態, R -> Ready状態
        if self.is_mock_env:
            return self._pulse_to_deg(self._mock_pulse), False
        
        resp = self._send_command("Q:")
        
        try:
            parts = resp.split(",")
            if len(parts) >= 4:
                #座標値
                pulse_str = parts[0].strip()
                current_pulse = int(pulse_str)
                
                #ステータス（ack3）
                ack3 = parts[3].strip()
                is_busy = (ack3 == "B")
                
                return self._pulse_to_deg(current_pulse), is_busy
            else:
                return 0.0, False
        except Exception as e:
            logger.error(f"Status parse error: {e}, Raw: {resp}")