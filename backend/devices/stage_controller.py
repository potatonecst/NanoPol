import time
#import logging
import platform
import re
import threading
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

# モジュールレベルのデバイス制限とデフォルト（マジックナンバーを避ける）
# GSC-01 コントローラのパルス引数は 0..16,777,215 の範囲
DEVICE_MAX_PULSES = 16777215
# 安全マージンとしてデバイス上限からこの分だけ余裕を取る（パルス単位）
DEFAULT_SAFETY_MARGIN_PULSES = 1000
# デフォルトの累積許容角度（度）: 実運用で十分な回転数を確保しつつ安全余裕を持つ
DEFAULT_MAX_CUMULATIVE_DEGREES = 10000.0


# Exceptions for command-layer errors
class StageCommandError(Exception):
    """操作上の理由（安全性や制限）でコマンドが拒否された場合に発生する例外。

    例: 累積移動量が許容範囲を超える、負のパルス指示、機器がエラー応答を返した等。
    """
    pass

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
        self._io_lock = threading.Lock()
        
        # --- [優先制御フラグ] ---
        # 監視タスク(Q:)と移動コマンド(A:, G:)の競合を防ぐためのフラグ。
        # 移動コマンド送信時に True になり、その間監視タスクは通信を控えて譲ります。
        self.is_priority_locked = False

        #ステージ仕様 (OSMS-60YAW)
        #分解能: Full=0.005deg/pulse, Half=0.0025deg/pulse 
        #GSC-01のデフォルトはHalfステップ駆動 
        # したがって、1度動かすのに必要なパルス数は:
        # 1 [deg] / 0.0025 [deg/pulse] = 400 [pulse]
        # この値を使って、ユーザーが入力した「角度」を機械が理解できる「パルス数」に変換します。
        self.pulses_per_degree = 400

        # 安全制限: 累積許容角度（度）および対応する総パルス数
        # デフォルトはモジュール定数 DEFAULT_MAX_CUMULATIVE_DEGREES を使用
        self.MAX_CUMULATIVE_DEGREES = DEFAULT_MAX_CUMULATIVE_DEGREES
        # 総パルス上限はデバイス上限 DEVICE_MAX_PULSES と安全マージンを考慮して計算する
        # 計算方針:
        # - ユーザーが指定する累積角度（度）をパルス換算した値
        # - 機器仕様の最大パルス（DEVICE_MAX_PULSES）から安全マージンを引いた値
        # のうち小さい方を許容総パルス上限とする。これによりソフト側の累積保護
        # とハードウェア物理上限の両方を同時に考慮できる。
        self.MAX_TOTAL_PULSES = min(int(self.pulses_per_degree * self.MAX_CUMULATIVE_DEGREES), DEVICE_MAX_PULSES - DEFAULT_SAFETY_MARGIN_PULSES)
        
        # 速度設定のデフォルト値 (SettingsView等から上書き可能)
        self.speed_min_pps = 500
        self.speed_max_pps = 5000
        self.speed_accel_ms = 200
        
        self._capture_thread = None
        self._mock_pulse = 0
        self._mock_is_busy = False # Mock用の移動中フラグ

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
        # pulses_per_degree が変わったら総パルス上限も再計算する
        self.MAX_TOTAL_PULSES = min(int(self.pulses_per_degree * self.MAX_CUMULATIVE_DEGREES), DEVICE_MAX_PULSES - DEFAULT_SAFETY_MARGIN_PULSES)
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
            # シリアルI/Oは排他的に実行し、Q: と移動コマンドの取り違えを防ぐ
            # ここでロックを取得してから低レベルの送受信関数 `_send_command_locked`
            # を呼ぶ設計にしている。理由: モニタ（Q:）と移動コマンド（A:/M:/G:）が
            # 同時にシリアルへ書き込むとプロトコルの取り違え／データ断片化が起きる
            # ため、安全に直列化する必要がある。
            with self._io_lock:
                response = self._send_command_locked(cmd)

            if response == "":
                self._mark_disconnected(f"No response for command '{cmd}'")
                raise Exception("Empty response from stage controller")
            
            return response
        except Exception as e:
            logger.error(f"{self.log_tag} Communication Error: {e}")
            self._mark_disconnected(str(e))
            raise e

    def _send_command_locked(self, cmd: str):
        """`_io_lock` を取得済みの前提で送受信を行う。

        補足:
        - ハードウェアは行末（CR+LF）で応答を返すため `readline()` を使用する。
        - 一部デバイスは固定幅で数値フィールド中に空白を含めて返すことがある
          （例: "-      499"）。そのため上位での解析時に内部空白の扱いに
          注意が必要である。

        実装上の注意:
        - このメソッドは `_io_lock` を取得した上で呼び出すことを前提としています。
        - 直接シリアルに書き込み・読み取りを行い、応答文字列を返します。
        - 呼び出し側で応答の空チェックやエラーハンドリングを行ってください。
        """
        logger.debug(f"{self.log_tag} Send: {cmd}")
        full_cmd = f"{cmd}\r\n"
        self.ser.write(full_cmd.encode("ascii"))
        response = self.ser.readline().decode("ascii").strip()
        logger.debug(f"{self.log_tag} Recv: {response} (cmd={cmd})")
        return response
    
    #---座標変換---
    
    def _deg_to_pulse(self, deg: float) -> int:
        """角度[deg]をパルス数[pulse]に変換します。

        微小移動時の切り捨てを防ぐため四捨五入(round)しています。
        """
        return int(round(deg * self.pulses_per_degree)) #四捨五入してパルス数を整数化
    
    def _pulse_to_deg(self, pulse: int) -> float:
        """パルス数[pulse]を角度[deg]に変換します。"""
        return float(pulse) / self.pulses_per_degree
    
    #---操作メソッド---
    
    def home(self):
        """H:1 コマンド（機械原点復帰）を送信します。"""
        logger.info(f"{self.log_tag} Homing...")

        if self.is_mock_env:
            time.sleep(2)
            self._mock_pulse = 0
            logger.info(f"{self.log_tag} Homed")
            return True

        self.is_priority_locked = True
        try:
            resp = "NG"
            for attempt in range(3):
                resp = self._send_command("H:1")
                if resp == "OK":
                    logger.info(f"{self.log_tag} Homed")
                    return True
                logger.warning(f"{self.log_tag} Homing (H:1) returned NG (attempt {attempt+1}/3). Waiting...")
                time.sleep(0.2)

            logger.error(f"{self.log_tag} Homing Error after retries. Resp: {resp}")
            raise StageCommandError(f"Homing failed: {resp}")
        finally:
            self.is_priority_locked = False
    def move_absolute(self, target_angle: float, allow_overflow: bool = False):
        """絶対角度[deg]を指定してステージを移動させます（移動量設定後、駆動開始）。

        `allow_overflow=True` の場合は 0..360 のソフトリミットを無視して任意の角度を指定できます。
        ただし、極端に大きな値は保護のため拒否します（累積パルスによる保護）。"""

        # ソフトリミット（安全装置）: デフォルトでは 0.0 〜 360.0度 の範囲内のみ許可
        if not allow_overflow:
            if not (0.0 <= target_angle <= 360.0):
                logger.error(f"{self.log_tag} Move Abs Error: Target angle {target_angle} is out of bounds (0-360).")
                raise ValueError(f"Target angle {target_angle} out of bounds (0-360)")
        else:
            # Overflow が許可されている場合でも、以下のチェックで極端な値は拒否する:
            # 1) 目標角度をパルスに変換した際に負の値になる（原点より下回る）指示は危険で拒否
            # 2) 目標パルスが許容総パルス上限（self.MAX_TOTAL_PULSES）を超える場合は拒否
            # これは「度」ではなく実際にデバイスへ送るパルス数を基準にした保護であり、
            # ソフトリミットの無効化（アプローチ動作等）を許す一方で機器損傷を防ぎます。
            target_pulse_check = self._deg_to_pulse(target_angle)
            # 原点より小さい（負のパルス）になる指示は拒否する
            if target_pulse_check < 0:
                logger.error(f"{self.log_tag} Move Abs Error: Target pulse {target_pulse_check} is negative (below origin).")
                raise StageCommandError(f"Target pulse {target_pulse_check} is negative (below origin)")
            # 許容累積パルスを超える指示は拒否する
            if abs(target_pulse_check) > self.MAX_TOTAL_PULSES:
                logger.error(f"{self.log_tag} Move Abs Error: Target pulse {target_pulse_check} exceeds safe cumulative pulse limit of {self.MAX_TOTAL_PULSES}.")
                raise StageCommandError(f"Target pulse {target_pulse_check} exceeds safe cumulative pulse limit")
            
        # GSC-01の仕様: 移動するには「移動量の設定(Aコマンド)」と「駆動開始(Gコマンド)」の2段階が必要
        
        target_pulse = self._deg_to_pulse(target_angle)
        direction = "+"if target_pulse >= 0 else "-"
        abs_pulse = abs(target_pulse)
        
        logger.info(f"{self.log_tag} Move Abs to {target_angle} deg ({direction}{abs_pulse} pulses)")
        
        #Mockモードの場合: スレッドで少しずつ角度を変化させて実機の挙動をシミュレートする
        if self.is_mock_env:
            self._mock_move_cancel = False
            self._mock_is_busy = True # スレッド開始前に即座にBusy状態にする
            def _mock_abs_move():
                start_pulse = self._mock_pulse
                diff = target_pulse - start_pulse
                
                # 実機の速度（PPS）に基づいて所要時間を計算する
                speed_pps = max(1, self.speed_max_pps)
                total_time = abs(diff) / speed_pps
                
                # 50ms間隔で更新する
                steps = max(1, int(total_time / 0.05))
                step_pulse = diff / steps
                step_time = total_time / steps
                
                for _ in range(steps):
                    if getattr(self, "_mock_move_cancel", False):
                        break
                    time.sleep(step_time)
                    self._mock_pulse += step_pulse
                
                if not getattr(self, "_mock_move_cancel", False):
                    self._mock_pulse = target_pulse # 最後に正確な値へ合わせる
                self._mock_is_busy = False
                logger.info(f"{self.log_tag} Move Abs Complete: {target_angle} deg")

            threading.Thread(target=_mock_abs_move, daemon=True).start()
            return True
        
        # 1. 優先ロックの有効化
        # 監視タスクに対して「重要な命令を送るので待って」という合図を送ります。
        self.is_priority_locked = True
        
        try:
            # 2. 移動量設定コマンド送信: A:1{方向}P{パルス数}
            # ハードウェア内部の完了処理との微小な重なりによる "NG" を吸収するため、リトライを行います。
            resp_a = "NG"
            for attempt in range(3):
                cmd_a = f"A:1{direction}P{abs_pulse}"
                resp_a = self._send_command(cmd_a)
                if resp_a == "OK":
                    break
                logger.warning(f"{self.log_tag} Move setup (A:1) returned NG (attempt {attempt+1}/3). Waiting...")
                time.sleep(0.1) # 100ms 待機してコントローラを落ち着かせる
            
            if resp_a != "OK":
                raise StageCommandError(f"Move setup failed after retries: {resp_a}")
            
            # 3. 駆動開始コマンド送信: G:
            resp_g = "NG"
            for attempt in range(3):
                resp_g = self._send_command("G:")
                if resp_g == "OK":
                    logger.info(f"{self.log_tag} Move Abs Command Sent: {target_angle} deg")
                    return True
                logger.warning(f"{self.log_tag} Move start (G:) returned NG (attempt {attempt+1}/3). Waiting...")
                time.sleep(0.1)
                
            raise StageCommandError(f"Move start failed after retries: {resp_g}")

        finally:
            # 命令の送信が終わったので、監視タスクへ制御を戻します（角度表示の再開）。
            self.is_priority_locked = False
    
    def move_relative(self, delta_angle: float, current_angle_hint: float | None = None):
        """現在の位置から指定した角度[deg]だけ相対移動させます。"""
            
        # M:1+Pxxx -> G:（相対移動パルス数設定命令 -> 駆動命令）
        delta_pulse = self._deg_to_pulse(delta_angle)
        
        #ゼロなら何もしない
        if delta_angle == 0:
            return True

        # 累計角度の安全チェックは、監視ループで取得済みのキャッシュ値を優先して使用する
        if current_angle_hint is not None:
            predicted_angle = current_angle_hint + delta_angle
            # current_angle_hint が与えられている場合、これを起点に予測される累積角度を
            # パルスに変換して安全性をチェックする。これは複数回の相対移動を合成した際
            # の累積オーバーランを未然に防止するための保護です。
            predicted_pulse = self._deg_to_pulse(predicted_angle)
            # 原点より小さくなる予測は拒否する（ユーザーにホームを促すべき状態）
            if predicted_pulse < 0:
                logger.error(f"{self.log_tag} Move Rel Error: Predicted pulse {predicted_pulse} is negative (below origin). Please Home the stage.")
                raise StageCommandError(f"Predicted pulse {predicted_pulse} is negative (below origin)")
            # 予測総パルスが許容上限を超える場合も拒否する
            if abs(predicted_pulse) > self.MAX_TOTAL_PULSES:
                logger.error(f"{self.log_tag} Move Rel Error: Predicted pulse {predicted_pulse} exceeds safe cumulative pulse limit of {self.MAX_TOTAL_PULSES}. Please Home the stage.")
                raise StageCommandError(f"Predicted pulse {predicted_pulse} exceeds safe cumulative pulse limit")
        
        direction = "+" if delta_pulse >= 0 else "-"
        abs_pulse = abs(delta_pulse)
        
        logger.info(f"{self.log_tag} Move Rel {delta_angle} deg ({direction}{abs_pulse} pulses)")
        
        #Mockモードの場合: スレッドで少しずつ角度を変化させて実機の挙動をシミュレートする
        if self.is_mock_env:
            self._mock_move_cancel = False
            self._mock_is_busy = True # スレッド開始前に即座にBusy状態にする
            def _mock_rel_move():
                target_pulse = self._mock_pulse + delta_pulse
                
                # 実機の速度（PPS）に基づいて所要時間を計算する
                speed_pps = max(1, self.speed_max_pps)
                total_time = abs(delta_pulse) / speed_pps
                
                # 50ms間隔で更新する
                steps = max(1, int(total_time / 0.05))
                step_pulse = delta_pulse / steps
                step_time = total_time / steps
                
                for _ in range(steps):
                    if getattr(self, "_mock_move_cancel", False):
                        break
                    time.sleep(step_time)
                    self._mock_pulse += step_pulse
                
                if not getattr(self, "_mock_move_cancel", False):
                    self._mock_pulse = target_pulse # 最後に正確な値へ合わせる
                self._mock_is_busy = False
                logger.info(f"{self.log_tag} Move Rel Complete: {delta_angle} deg")

            threading.Thread(target=_mock_rel_move, daemon=True).start()
            return True
        
        # 1. 移動量設定: M:1{方向}P{パルス数}
        cmd_m = f"M:1{direction}P{abs_pulse}"
        resp_m = self._send_command(cmd_m)
        
        if resp_m != "OK":
            logger.error(f"{self.log_tag} Move setup failed: {resp_m}")
            raise StageCommandError(f"Move setup failed: {resp_m}")
        
        # 2. 駆動開始: G:
        resp_g = self._send_command("G:")
        
        if resp_g == "OK":
            logger.info(f"{self.log_tag} Move Rel Command Sent: {delta_angle} deg")
            return True
        else:
            logger.error(f"{self.log_tag} Move Rel Command Failed: {resp_g}")
            raise StageCommandError(f"Move start failed: {resp_g}")
    
    def set_speed(self, min_pps: int, max_pps: int, accel_time_ms: int):
        """モーターの起動速度、最高速度、加減速時間を設定します。"""
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
        """ステージの移動を停止します。`immediate=True` で非常停止になります。"""
        # L:1 (減速停止) or L:E (非常停止/即停止)
        logger.info(f"{self.log_tag} Stopping... (Immediate={immediate})")
        if self.is_mock_env:
            self._mock_move_cancel = True
            self._mock_is_busy = False
            return True
        
        cmd = "L:E" if immediate else "L:1"
        resp = self._send_command(cmd)
        
        if resp == "OK":
            logger.info(f"{self.log_tag} Stop Command Sent")
            return True
        else:
            logger.error(f"{self.log_tag} Stop Command Failed: {resp}")
            raise StageCommandError(f"Stop command failed: {resp}")

    def _parse_status_response(self, resp: str) -> Tuple[float, bool] | None:
        """Q: 応答の固定幅パルス表記を角度と Busy フラグに変換します。

        実機ではパルス値が符号付きで固定幅に整形され、内部にスペースが挿入
        されることがあります（例: "+00018000" や "-      499"）。
        このヘルパーはそのような空白を削除して安全に `int()` に渡します。

        戻り値:
        - 正常: `(angle_deg, is_busy)`
        - 解析失敗: `None`
        """
        parts = resp.split(",")
        if len(parts) < 4:
            return None

        pulse_str = re.sub(r"\s+", "", parts[0])
        current_pulse = int(pulse_str)
        ack3 = parts[3].strip()
        is_busy = (ack3 == "B")
        angle = self._pulse_to_deg(current_pulse)
        return angle, is_busy

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
        logger.debug(f"{self.log_tag} get_status requested")
        if self.is_mock_env:
            angle = self._pulse_to_deg(self._mock_pulse)
            logger.debug(f"{self.log_tag} get_status mock response: angle={angle}, busy={self._mock_is_busy}")
            return angle, self._mock_is_busy
        
        resp = self._send_command("Q:")
        
        try:
            # 共通パーサを使ってレスポンスを解釈する。共通化によりモニタとAPI
            # 双方で解析ロジックがずれることを防ぐ。
            parsed = self._parse_status_response(resp)
            if parsed is not None:
                angle, is_busy = parsed
                logger.debug(f"{self.log_tag} get_status parsed: angle={angle}, busy={is_busy}, raw={resp}")
                return angle, is_busy

            # ここに到達するのはフィールド数が不足しているなどの軽微な異常時。
            # 呼び出し側は (0.0, False) を異常指標として扱う。
            logger.warning(f"{self.log_tag} get_status parse failed: too few fields raw={resp}")
            return 0.0, False
        except Exception as e:
            logger.error(f"Status parse error: {e}, Raw: {resp}")
            return 0.0, False

    def try_get_status(self) -> Tuple[float, bool] | None:
        """ロックが空いているときだけステータスを取得し、埋まっていれば None を返します。
        
        優先ロック(is_priority_locked)が有効な場合、またはロックが即座に取得できない場合は
        通信の競合を避けるために None を返します。
        """
        if self.is_mock_env:
            return self.get_status()

        # 優先ロック（移動コマンド送信中）の場合は譲る
        if getattr(self, 'is_priority_locked', False):
            return None

        if not self.ser or not self.ser.is_open:
            raise Exception("Device not connected")

        if not self._io_lock.acquire(blocking=False):
            return None

        try:
            logger.debug(f"{self.log_tag} try_get_status acquired")
            resp = self._send_command_locked("Q:")
            # 非ブロッキングで取得したレスポンスも同じ解析ルーチンを通す。
            parsed = self._parse_status_response(resp)
            if parsed is not None:
                angle, is_busy = parsed
                logger.debug(f"{self.log_tag} try_get_status parsed: angle={angle}, busy={is_busy}, raw={resp}")
                return angle, is_busy

            logger.warning(f"{self.log_tag} try_get_status parse failed: too few fields raw={resp}")
            return 0.0, False
        except Exception as e:
            logger.error(f"Status parse error: {e}, Raw: {resp if 'resp' in locals() else 'N/A'}")
            return 0.0, False
        finally:
            self._io_lock.release()