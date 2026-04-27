import time
#import logging
import platform
from typing import Tuple

PYSERIAL_IMPORT_ERROR = None
try:
    import serial
    HAS_PYSERIAL = True
except ImportError as e:
    serial = None
    HAS_PYSERIAL = False
    PYSERIAL_IMPORT_ERROR = str(e)

from utils.logger import logger

#logger = logging.getLogger("uvicorn")

class StageController:
    def __init__(self):
        self.ser = None
        # Windows以外のOS（Mac/Linux）ではドライバがないため、自動的にMock（シミュレータ）環境とみなす
        self.is_mock_env = platform.system() != "Windows" or not HAS_PYSERIAL
        self.is_connected = False
        self.log_tag = "[STAGE-MOCK]" if self.is_mock_env else "[STAGE]"
        self.has_pyserial = HAS_PYSERIAL
        self.pyserial_import_error = PYSERIAL_IMPORT_ERROR
        self.last_error = None
        self.last_connected_port = None
        self.last_baudrate = None
        
        #ステージ仕様 (OSMS-60YAW)
        #分解能: Full=0.005deg/pulse, Half=0.0025deg/pulse 
        #GSC-01のデフォルトはHalfステップ駆動 
        # したがって、1度動かすのに必要なパルス数は:
        # 1 [deg] / 0.0025 [deg/pulse] = 400 [pulse]
        # この値を使って、ユーザーが入力した「角度」を機械が理解できる「パルス数」に変換します。
        self.pulses_per_degree = 400
        
        # 速度設定のデフォルト値 (SettingsView等から上書き可能)
        self.speed_min_pps = 500
        self.speed_max_pps = 5000
        self.speed_accel_ms = 200
        
        self._mock_pulse = 0 #Mock用の内部変数

        # 起動時にステージ実行モードの判定根拠を残す（切り分け用）
        logger.info(
            "[STAGE INIT] mode=%s os=%s HAS_PYSERIAL=%s",
            "Mock" if self.is_mock_env else "Real",
            platform.system(),
            HAS_PYSERIAL,
        )

        if self.pyserial_import_error:
            logger.warning(f"[STAGE INIT] pyserial import failed: {self.pyserial_import_error}")

    def _mark_disconnected(self, reason: str):
        """通信異常時に接続状態を確実に落として、上位の状態表示を同期させる。"""
        logger.error(f"{self.log_tag} Disconnected due to communication failure: {reason}")
        self.last_error = reason
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass
        self.ser = None
        self.is_connected = False
    
    def update_settings(self, pulses_per_degree: int):
        """分解能（1度あたりのパルス数）の設定を更新します"""
        self.pulses_per_degree = pulses_per_degree
        logger.info(f"{self.log_tag} Update Resolution: {self.pulses_per_degree} pulses/deg")
    
    def connect(self, port: str, baudrate: int = 9600):
        """
        指定されたCOMポートを開き、ステージコントローラと接続します。
        Mac/Linux環境の場合は、自動的にMock（シミュレータ）接続として成功を返します。
        """
        self.last_connected_port = port
        self.last_baudrate = baudrate
        self.last_error = None

        if self.is_mock_env:
            self.is_connected = True
            logger.info(f"[STAGE-MOCK] Connected to Virtual Device (OS: {platform.system()})")
            # Mockでも設定適用ログを出すために呼び出す
            self.set_speed(self.speed_min_pps, self.speed_max_pps, self.speed_accel_ms)
            return True

        if not self.has_pyserial:
            self.last_error = "pyserial is not available"
            raise RuntimeError(self.last_error)
        
        # Windows実機環境: pyserialを使ってCOMポートを開く
        try:
            self.ser = serial.Serial(
                port=port,
                baudrate=baudrate, #9600 or 38400
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1.0, # 読み込み時にデータが来なくても1秒で諦める（無限待機防止）
                xonxoff=False,
                # 【重要】ハードウェアフロー制御 (RTS/CTS) を有効にする
                # GSC-01は処理が追いつかない時にRTS信号を使って「待って」と合図を送ります。
                # これを無視するとコマンドの取りこぼしが発生します。
                rtscts=True, 
                dsrdtr=False,
            )
            self.is_connected = True
            logger.info(f"[STAGE-REAL] Connected to Real Device at {port}")
            
            #接続確認: バージョン情報の問い合わせなど
            #self._send_command("?:V")
            
            # 接続成功時に、現在の速度設定を適用する
            self.set_speed(self.speed_min_pps, self.speed_max_pps, self.speed_accel_ms)
            
            return True
        except serial.SerialException as e:
            logger.error(f"[STAGE-REAL] Connection Failed: {e}")
            self.ser = None
            self.is_connected = False
            self.last_error = str(e)
            raise e
    
    def close(self):
        """通信ポートを閉じ、デバイスから切断します"""
        if self.ser and self.ser.is_open:
            self.ser.close()
            logger.info(f"{self.log_tag} Connection closed")
        
        self.ser = None
        self.is_connected = False

    def disconnect(self):
        """APIから明示的に呼びやすい切断メソッド（closeの別名）。"""
        self.close()
    
    def _send_command(self, cmd: str):
        """
        【内部用】デバイスにコマンドを送信し、レスポンスを受信します（自動でCR+LF終端）。
        GSC-01の通信プロトコルは、コマンドの末尾に必ず改行コード(\r\n)が必要です。
        """
        if self.is_mock_env:
            logger.debug(f"{self.log_tag} Send: {cmd}")
            return "OK"
        
        if not self.ser or not self.ser.is_open:
            raise Exception("Device not connected")
        
        try:
            # 1. コマンド送信
            # 文字列をバイト列(ascii)にエンコードし、末尾にCR+LFを付与
            full_cmd = f"{cmd}\r\n"
            self.ser.write(full_cmd.encode("ascii"))
            
            # 2. レスポンス受信
            # readline()は改行コードが来るまで待機します（またはタイムアウト）
            response = self.ser.readline().decode("ascii").strip()
            #logger.debug(f"[STAGE] Send: {cmd} / Recv: {response}")

            if response == "":
                self._mark_disconnected(f"No response for command '{cmd}'")
                raise Exception("Empty response from stage controller")
            
            return response
        except Exception as e:
            logger.error(f"{self.log_tag} Communication Error: {e}")
            self._mark_disconnected(str(e))
            raise e
    
    #---座標変換---
    
    def _deg_to_pulse(self, deg: float) -> int:
        """
        角度[deg]をパルス数[pulse]に変換します。微小移動時（0.0024度のような角度の移動）の無視を防ぐため四捨五入(round)します。
        """
        return int(round(deg * self.pulses_per_degree)) #四捨五入してパルス数を整数化
    
    def _pulse_to_deg(self, pulse: int) -> float:
        """パルス数[pulse]を角度[deg]に変換します"""
        return float(pulse) / self.pulses_per_degree
    
    #---操作メソッド---
    
    def home(self):
        """H:1 コマンド（機械原点復帰）を送信します"""
        logger.info(f"{self.log_tag} Homing...")
        
        if self.is_mock_env:
            time.sleep(2)
            self._mock_pulse = 0
            logger.info(f"{self.log_tag} Homed")
            return True
        
        resp = self._send_command("H:1")
        
        if resp == "OK":
            logger.info(f"{self.log_tag} Homed")
            return True
        else:
            logger.error(f"{self.log_tag} Homing Error. Resp: {resp}")
            return False
    
    def move_absolute(self, target_angle: float):
        """絶対角度[deg]を指定してステージを移動させます（移動量設定後、駆動開始）"""
        
        # ソフトリミット（安全装置）: 絶対角度は 0.0 〜 360.0度 の範囲内のみ許可
        if not (0.0 <= target_angle <= 360.0):
            logger.error(f"{self.log_tag} Move Abs Error: Target angle {target_angle} is out of bounds (0-360).")
            return False
            
        # GSC-01の仕様: 移動するには「移動量の設定(Aコマンド)」と「駆動開始(Gコマンド)」の2段階が必要
        
        target_pulse = self._deg_to_pulse(target_angle)
        direction = "+"if target_pulse >= 0 else "-"
        abs_pulse = abs(target_pulse)
        
        logger.info(f"{self.log_tag} Move Abs to {target_angle} deg ({direction}{abs_pulse} pulses)")
        
        #Mockモードの場合
        if self.is_mock_env:
            time.sleep(0.5)
            self._mock_pulse = target_pulse
            logger.info(f"{self.log_tag} Move Abs Complete: {target_angle} deg")
            return True
        
        # 1. 移動量設定コマンド送信: A:1{方向}P{パルス数}
        cmd_a = f"A:1{direction}P{abs_pulse}"
        resp_a = self._send_command(cmd_a)
        
        if resp_a != "OK":
            logger.error(f"{self.log_tag} Move setup failed: {resp_a}")
            return False
        
        # 2. 駆動開始コマンド送信: G:
        resp_g = self._send_command("G:")
        
        if resp_g == "OK":
            logger.info(f"{self.log_tag} Move Abs Command Sent: {target_angle} deg")
            return True
        else:
            logger.error(f"{self.log_tag} Move Abs Command Failed: {resp_g}")
            return False
    
    def move_relative(self, delta_angle: float):
        """現在の位置から指定した角度[deg]だけ相対移動させます"""
        
        # ソフトリミット（安全装置）: 1回の相対移動は -360.0 〜 +360.0度 の範囲内のみ許可（誤入力での無限回転防止）
        if not (-360.0 <= delta_angle <= 360.0):
            logger.error(f"{self.log_tag} Move Rel Error: Delta angle {delta_angle} is too large. Must be between -360 and 360.")
            return False
            
        # 累計パルスの上限超過を防ぐための安全装置（約80周でストップ）
        # 動かす前に「今の角度」を聞き、予測される移動先の角度を計算する
        current_angle, _ = self.get_status()
        predicted_angle = current_angle + delta_angle
        if abs(predicted_angle) > 30000.0:
            logger.error(f"{self.log_tag} Move Rel Error: Cumulative angle {predicted_angle:.1f} exceeds safe limit of ±30000 deg. Please Home the stage.")
            return False
            
        # M:1+Pxxx -> G:（相対移動パルス数設定命令 -> 駆動命令）
        delta_pulse = self._deg_to_pulse(delta_angle)
        
        #ゼロなら何もしない
        if delta_angle == 0:
            return True
        
        direction = "+" if delta_pulse >= 0 else "-"
        abs_pulse = abs(delta_pulse)
        
        logger.info(f"{self.log_tag} Move Rel {delta_angle} deg ({direction}{abs_pulse} pulses)")
        
        #Mockモードの場合
        if self.is_mock_env:
            time.sleep(0.2)
            self._mock_pulse += delta_pulse
            logger.info(f"{self.log_tag} Move Rel Complete: {delta_angle} deg")
            return True
        
        # 1. 移動量設定: M:1{方向}P{パルス数}
        cmd_m = f"M:1{direction}P{abs_pulse}"
        resp_m = self._send_command(cmd_m)
        
        if resp_m != "OK":
            logger.error(f"{self.log_tag} Move setup failed: {resp_m}")
            return False
        
        # 2. 駆動開始: G:
        resp_g = self._send_command("G:")
        
        if resp_g == "OK":
            logger.info(f"{self.log_tag} Move Rel Command Sent: {delta_angle} deg")
            return True
        else:
            logger.error(f"{self.log_tag} Move Rel Command Failed: {resp_g}")
            return False
    
    def set_speed(self, min_pps: int, max_pps: int, accel_time_ms: int):
        """モーターの起動速度、最高速度、加減速時間を設定します"""
        # D:（速度設定命令）
        # 内部設定値を更新（再接続時などに再適用できるようにするため保持しておく）
        self.speed_min_pps = min_pps
        self.speed_max_pps = max_pps
        self.speed_accel_ms = accel_time_ms

        logger.info(f"{self.log_tag} Set Speed: S(min)={min_pps}, F(max)={max_pps}, R={accel_time_ms}")
        
        if self.is_mock_env:
            return True
        
        # 速度設定コマンド D:1S{起動速度}F{最高速度}R{加減速時間}
        cmd = f"D:1S{min_pps}F{max_pps}R{accel_time_ms}"
        resp = self._send_command(cmd)
        
        return resp == "OK"
    
    def stop(self, immediate: bool = False):
        """ステージの移動を停止します (immediate=True で非常停止)"""
        # L:1 (減速停止) or L:E (非常停止/即停止)
        logger.info(f"{self.log_tag} Stopping... (Immediate={immediate})")
        if self.is_mock_env:
            logger.info(f"{self.log_tag} Stopped")
            return True
        
        cmd = "L:E" if immediate else "L:1" #immediate=TrueでL:E
        resp = self._send_command(cmd)
        
        if resp == "OK":
            logger.info(f"{self.log_tag} Stop Command Sent")
            return True
        else:
            logger.error(f"{self.log_tag} Stop Command Failed: {resp}")
            return False

    def get_status(self) -> Tuple[float, bool]:
        """
        Q:（ステータス確認コマンド）を送信し、現在の座標とBusy状態を取得します。
        
        レスポンスフォーマット: "座標値, ACK1, ACK2, ACK3"
        
        例: "+00018000,K,K,B"
          - 座標値: パルス数
          - ACK3: 'B'=Busy(移動中), 'R'=Ready(停止中)
        
        Returns:
            Tuple[float, bool]: (現在の角度[deg], 移動中(Busy)かどうか)
        """
        if self.is_mock_env:
            return self._pulse_to_deg(self._mock_pulse), False
        
        resp = self._send_command("Q:")
        
        try:
            parts = resp.split(",")
            if len(parts) >= 4:
                # 1つ目の要素: 座標値（パルス）
                pulse_str = parts[0].strip()
                current_pulse = int(pulse_str)
                
                # 4つ目の要素: ステータス（B or R）
                ack3 = parts[3].strip()
                is_busy = (ack3 == "B")
                
                return self._pulse_to_deg(current_pulse), is_busy
            else:
                return 0.0, False
        except Exception as e:
            logger.error(f"Status parse error: {e}, Raw: {resp}")
            return 0.0, False