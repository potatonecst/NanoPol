from fastapi import FastAPI, HTTPException, Response, Request, BackgroundTasks
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from pydantic import BaseModel
from serial.tools import list_ports
from typing import Optional
import sys
import os
import asyncio
import json
import csv
import signal
import threading
import time
import shutil
import glob
from pathlib import Path
from datetime import datetime, timezone
from uuid import uuid4

from utils.logger import logger, log_buffer
from utils import data_saver
from devices.stage_controller import StageController
from devices.stage_controller import StageCommandError
# `StageCommandError` はデバイス層（`StageController`）が運用上の理由でコマンドを
# 拒否した場合に投げる専用の例外クラスです。
#
# ハンドリング方針:
# - `ValueError` -> クライアント側の入力不備やリクエスト内容の誤り（HTTP 400）
# - `StageCommandError` -> 機器保護や状態（累積上限・原点未復帰等）による拒否（HTTP 409 Conflict）
# - それ以外の例外 -> サーバー/デバイスの想定外エラー（HTTP 500）
#
# これによりフロントエンドはエラーの種類に応じて適切なユーザー指示（例: ホーム要求）や
# リトライ戦略を実行できます。
from devices.camera_controller import CameraController

# グローバルインスタンスの作成
# アプリケーション全体で1つのコントローラーを共有します（シングルトンパターン）
# これにより、どのAPIエンドポイントから呼び出されても、常に同じハードウェア状態を操作・参照できます。
stage = StageController()
camera = CameraController()

class SystemState:
    """フロントエンドへ即座に返すための状態キャッシュ（メモリ）"""
    def __init__(self):
        self.current_angle = 0.0
        self.is_busy = False       # ハードウェア: ステージが物理的に移動・回転中か
        self.is_measuring = False  # ソフトウェア: Sweep等の自動測定シーケンスが実行中か
        self.last_stage_command = None  # 直近で受理したステージコマンド（完了ログ用）
        # Sweep の進捗を progress API から返すための、操作単位の状態オブジェクトです。
        # ここには operation_id、現在フェーズ、計画値、キャンセル要求フラグなどをまとめて保持します。
        self.sweep_operation = None
        # 自動測定（Auto Mode）専用の状態管理
        self.auto_measurement = AutoMeasurementState()
        
        # 自動測定（Step & Shoot）の進捗管理
        self.auto_operation = None

auto_operation_lock = threading.Lock()

def _set_auto_operation_state(**kwargs):
    with auto_operation_lock:
        current = dict(app_state.auto_operation or {})
        current.update(kwargs)
        app_state.auto_operation = current

def _get_auto_operation_snapshot() -> dict:
    with auto_operation_lock:
        return dict(app_state.auto_operation or {})

class AutoMeasurementState:
    """
    自動測定（Auto Mode）中における、精密測定データの蓄積・管理を担当します。

    【設計の意図: トリガーベースへの移行】
    以前はカメラからのデータをすべて受け取っていましたが、測定精度の向上（撮影画像と
    数値の完全な一致）のため、「Snapshot指示があった瞬間の確定データ」のみを
    蓄積する「トリガーベース」の設計に変更されました。
    これにより、グラフに表示される1点1点が、確実に保存された画像と対応することが保証されます。
    """
    def __init__(self):
        # 自動測定セッションが現在有効（実行中）かどうか
        self.is_active = False

        # データの保存先ディレクトリ
        self.folder_path = ""

        # グラフ表示用の時系列データバッファ
        # 構造: { roi_index: [ { angle: float, sum: float, max: float, timestamp: float, filepath: str }, ... ] }
        # 各 ROI ごとに、角度と輝度のペアをリスト形式で保持します。
        self.data_buffer = {}

        # バッファの最大保持数（メモリ保護のための安全装置）
        # 1測定で数千点のデータを扱うことがありますが、メモリの際限ない肥大化を防ぐため
        # 10,000点を超えると古いデータから順に削除されます。
        self.MAX_BUFFER_POINTS = 10000

        # マルチスレッド（APIスレッドとキャプチャスレッド）からの同時アクセスを防ぐロック
        # 内部メソッド同士で呼び出す場合（例: start_session -> reset）のデッドロックを防ぐため、RLockを使用します。
        self._lock = threading.RLock()

    def reset(self):
        """
        新しい測定を開始する前に、すべてのバッファと状態をクリアします。
        これにより、前の測定データが混ざることを防ぎます。
        """
        with self._lock:
            self.is_active = False
            self.folder_path = ""
            self.data_buffer = {}
            logger.info("[AUTO STATE] Reset complete. Buffer cleared for new measurement.")

    def start_session(self, folder_path: str):
        """
        新しい自動測定セッションを開始します。

        Args:
            folder_path (str): 測定画像やログの保存先フォルダ
        """
        with self._lock:
            self.reset()
            self.is_active = True
            self.folder_path = folder_path
            logger.info(f"[AUTO STATE] Session started at: {folder_path}")

    def add_point(self, angle: float, roi_stats: dict, filepath: Optional[str] = None):
        """
        確定した測定データ（1点）をバッファに追加します。

        CameraController.take_snapshot() で得られた「撮影画像と直結した解析結果」を
        ここに流し込むことで、時系列グラフ用のデータが構築されます。
        """
        if not self.is_active:
            # 測定中でない場合は無視します
            return

        with self._lock:
            timestamp = time.time()

            # roi_stats の例: { "0": {"sum": 100, ...}, "1": {...} }
            for roi_key, stats in roi_stats.items():
                # キーを統一するため "roi_0", "roi_1" 形式で管理
                key = f"roi_{roi_key}"
                if key not in self.data_buffer:
                    self.data_buffer[key] = []

                buf = self.data_buffer[key]

                # バッファに新しいデータ点を追加
                buf.append({
                    "angle": angle,           # 撮影時の角度
                    "sum": stats.get("sum", 0),# 輝度合計（メインの測定値）
                    "max": stats.get("max", 0),# 最大輝度（飽和チェック用）
                    "center_val": stats.get("center_val", 0), # 中心ピクセルの輝度
                    "cx": stats.get("cx", 0),  # 重心X（Pre-Scan時）
                    "cy": stats.get("cy", 0),  # 重心Y（Pre-Scan時）
                    "timestamp": timestamp,    # 記録時刻
                    "filepath": filepath       # 保存された画像パス
                })

                # --- メモリ保護ロジック ---
                # 非常に細かいステップで長時間測定した場合でも、
                # ブラウザやバックエンドのメモリが溢れないよう、古いデータを切り捨てます。
                if len(buf) > self.MAX_BUFFER_POINTS:
                    buf.pop(0)

    def get_plot_data(self, roi_index: Optional[int] = None) -> dict:
        """
        フロントエンドのグラフ表示用に、現在蓄積されているデータを返します。

        Args:
            roi_index (int, optional): 特定の ROI だけのデータが欲しい場合に指定。
                指定なし（None）の場合は、すべての ROI のデータを返します。
        """
        with self._lock:
            if roi_index is not None:
                key = f"roi_{roi_index}"
                return {key: self.data_buffer.get(key, [])}
            # 辞書のコピーを返すことで、外部での変更が内部バッファに影響しないようにします。
            return dict(self.data_buffer)

app_state = SystemState()
stage_command_lock = threading.Lock()
sweep_state_lock = threading.Lock()


def _now_ms() -> float:
    """現在時刻を UTC ミリ秒で返すユーティリティ関数。

    理由:
    - すべての進捗計算やログのタイムスタンプは同一基準（UTCミリ秒）に揃えておくことで、
      バックグラウンドスレッドと API スレッド間の時間差異を避けられます。
    - 軽量かつ副作用がないため頻繁に呼べます。

    返り値:
        float: UTC ミリ秒のタイムスタンプ
    """
    return datetime.now(timezone.utc).timestamp() * 1000.0


def _clamp(value: float, minimum: float, maximum: float) -> float:
    """値を [minimum, maximum] の範囲に丸めるユーティリティ。

    - 進捗率やパラメータの境界制約に繰り返し使用します。
    - 型に依存せず数値として処理します。
    """
    return max(minimum, min(maximum, value))


def _directional_progress(start: float, target: float, current: float) -> float:
    """start -> target の計画方向に沿った進捗率を 0..1 で返す。

    この関数は「最短経路」を選びません。
    代わりに、プラン上の start と target をそのまま使い、
    current がその区間をどれだけ進んだかを線形に計算します。

    重要:
    - sweep では「10 -> 350 を +方向で進む」ような計画があり得るため、
      角度の最短距離ではなく、実際に計画した start/target の並びに従う必要があります。
    - current は `app_state.current_angle` のような、同じ座標系の値を渡す前提です。

    返り値:
        float: 進捗率（0.0 から 1.0）
    """
    total = target - start
    if abs(total) < 1e-6:
        return 1.0

    traveled = current - start
    ratio = traveled / total
    return float(_clamp(ratio, 0.0, 1.0))


def _build_sweep_plan(start_deg: float, end_deg: float, speed_deg_s: float) -> dict:
    """Sweep 実行用の計画を計算する。

    助走位置・終端位置・所要時間・速度設定を一元計算し、
    フロントと実行処理で同じ前提を共有できるようにする。
    """
    # この関数は「実行そのもの」ではなく、「実行前の見積もり」と「安全な送り出し条件」を
    # ひとまとめに作る役割を持ちます。フロントエンドが独自計算を持つとズレやすいため、
    # ここで backend 側が source of truth として計画値を決めます。
    pulses_per_degree = stage.pulses_per_degree
    min_pps = stage.speed_min_pps
    max_pps = stage.speed_max_pps
    accel_time_ms = stage.speed_accel_ms

    # ユーザーが指定した速度を、実機が受け入れられるパルス速度に変換し、
    # さらにハードウェアの最小・最大値の範囲内に丸めます。
    requested_pps = int(round(speed_deg_s * pulses_per_degree))
    safe_pps = int(_clamp(requested_pps, min_pps, max_pps))
    actual_speed_deg = safe_pps / pulses_per_degree
    start_speed_deg = min_pps / pulses_per_degree
    accel_time_sec = accel_time_ms / 1000.0

    # 加減速時間の間にどれくらい進むかをざっくり見積もり、
    # その分だけ前後に余裕を持たせて「助走位置」と「終端位置」を作ります。
    accel_dist = ((start_speed_deg + actual_speed_deg) / 2.0) * accel_time_sec
    margin = max(1.0, accel_dist * 1.2)
    direction = 1 if end_deg >= start_deg else -1

    actual_start_raw = start_deg - (margin * direction)
    actual_end_raw = end_deg + (margin * direction)

    def align_to_step(value: float) -> float:
        # ステージは連続値ではなくパルス刻みで動くため、
        # 入力角度を最寄りのステップにそろえて再利用可能な値にします。
        steps = round(value * pulses_per_degree)
        return steps / pulses_per_degree

    actual_start = align_to_step(actual_start_raw)
    actual_end = align_to_step(actual_end_raw)
    
    total_offset = 0
    # 負の角度が出た場合は 360 度加算で正の表現へ寄せます。
    # これにより allow_overflow を許可した絶対移動でも、
    # デバイス側の「負パルス禁止」ルールに触れにくい経路を作れます。
    while actual_start < 0 or actual_end < 0:
        actual_start += 360
        actual_end += 360
        total_offset += 360

    # 【重要】トリガー判定に使う角度も、移動位置と同じ分だけオフセットさせます。
    # これにより 0/360度の境界をまたぐスイープでも、同じ座標系で正しく比較できます。
    trigger_start = start_deg + total_offset
    trigger_end = end_deg + total_offset

    # 助走位置から終端位置までを1本の相対移動として扱うことで、
    # chunk 分割や途中停止を避け、速度制御と安全チェックを単純化します。
    relative_total = actual_end - actual_start
    sweep_distance = abs(relative_total)
    current_angle_at_request = app_state.current_angle
    approach_distance = abs(actual_start - current_angle_at_request)

    # 進捗バー用の残り時間は「正確な保証値」ではなく、UI を破綻させないための
    # おおよその目安です。実測値との差が出ても、最終状態は status で判定します。
    estimated_approach_ms = (approach_distance / actual_speed_deg * 1.5 * 1000.0) + 10000.0
    estimated_sweep_ms = (sweep_distance / actual_speed_deg * 1.5 * 1000.0) + 10000.0

    return {
        "kind": "sweep",
        "input_start_deg": float(start_deg),
        "input_end_deg": float(end_deg),
        "trigger_start_deg": trigger_start,
        "trigger_end_deg": trigger_end,
        "actual_start_deg": actual_start,
        "actual_end_deg": actual_end,
        "relative_total_deg": relative_total,
        "direction": "forward" if direction >= 0 else "reverse",
        "total_offset_deg": total_offset,
        "estimated_approach_ms": estimated_approach_ms,
        "estimated_sweep_ms": estimated_sweep_ms,
        "requested_speed_deg_s": float(speed_deg_s),
        "actual_speed_deg_s": actual_speed_deg,
        "requested_speed_pps": requested_pps,
        "safe_speed_pps": safe_pps,
        "current_angle_at_request": current_angle_at_request,
        "margin_deg": margin,
    }


def _set_sweep_state(**kwargs):
    """Sweep 操作の共有状態を安全に更新するためのユーティリティ。

    目的:
    - `app_state.sweep_operation` に対して部分的な更新を行う（部分上書き）。
    - 更新時に `updated_at_ms` を自動で付与することで、変更時刻を追跡可能にする。
    - 複数スレッドから呼ばれてもデータ競合が起きないよう、`sweep_state_lock` を用いて排他制御を行う。

    呼び出しタイミング（例）:
    - `/stage/sweep/run` で初期状態を登録する。
    - バックグラウンド実行（`_run_sweep_operation`）がフェーズ遷移やメッセージ更新を通知する。
    - キャンセル要求やエラー発生時に状態（status/phase/message）を更新する。

    実装上の注意:
    - 返却される辞書は shallow copy です。呼び出し側で直接ミュータブルなネスト要素を変更すると
      元データを汚染する可能性があるため、状態を変更する場合は必ず `_set_sweep_state` を使ってください。

    引数:
        kwargs: 更新したいキー/値ペア（例: status='running', phase='approach'）

    戻り値:
        dict: 更新後の状態オブジェクトのコピー
    """
    with sweep_state_lock:
        current = dict(app_state.sweep_operation or {})
        current.update(kwargs)
        current["updated_at_ms"] = _now_ms()
        app_state.sweep_operation = current
        return dict(current)


def _get_sweep_state_snapshot() -> dict:
    """共有状態の安全なスナップショットを返すヘルパー。

    目的:
    - 参照側が返却されたオブジェクトを誤って変更してしまうことを避けるため、
        ロック下で浅いコピー（shallow copy）を返します。
    - バックグラウンド実行スレッドや API ハンドラは、これを使って一貫した状態判断（例: cancel_requested の確認）を行います。

    注意:
    - 浅いコピーなので、ネストされた辞書の更なるネストレベルを直接変更すると元データを書き換える恐れがあります。
        状態を書き換える必要がある場合は `_set_sweep_state` を使ってください。

    戻り値:
            dict: 現在の sweep_operation の浅いコピー（空なら空辞書）
    """
    with sweep_state_lock:
        return dict(app_state.sweep_operation or {})


def _compute_sweep_progress(state: dict) -> dict:
    """`/stage/sweep/progress` のために進捗表示用の要約オブジェクトを作成する。

    入力: `state` は `_set_sweep_state` で管理している sweep_operation オブジェクト。
    出力: progress 表示で必要な以下のキーを含む辞書を返す:
        - operation_id, kind, status, phase, percent, message,
            current_deg, target_deg, estimated_remaining_ms

    実装ノート:
    - UI はこの情報をポーリングして表示を更新します。レスポンスは軽量に抑えつつ、
        フェーズごとの進捗計算（prepare/approach/sweep/finalize）を行います。
    - `percent` は大まかな進捗表示用に設計されており、厳密な時間同期は保証しません。
    - `estimated_remaining_ms` は目安であり、実際の残り時間はデバイス応答や加減速挙動で変化します。
    """
    if not state:
        return {
            "operation_id": None,
            "kind": "sweep",
            "status": "idle",
            "phase": "idle",
            "percent": 0,
            "message": "No active sweep",
            "current_deg": app_state.current_angle,
            "target_deg": None,
            "estimated_remaining_ms": 0,
        }

    plan = state.get("plan", {})
    status = state.get("status", "idle")
    phase = state.get("phase", "idle")
    operation_id = state.get("operation_id")
    started_at_ms = state.get("started_at_ms", state.get("updated_at_ms", _now_ms()))
    phase_started_at_ms = state.get("phase_started_at_ms", started_at_ms)
    now_ms = _now_ms()

    def elapsed_ms() -> float:
        return max(0.0, now_ms - phase_started_at_ms)

    percent = 0
    estimated_remaining_ms = 0
    target_deg = None
    message = state.get("message", "")

    if status == "running":
        if phase == "prepare":
            # prepare は速度設定や前提条件の確認中なので、進捗バーはまだ動かさず 0% のままにします。
            percent = 0
            estimated_remaining_ms = max(0.0, float(plan.get("estimated_approach_ms", 0.0)))
            message = message or "Preparing sweep"
        elif phase == "approach":
            # 助走位置への移動は、計画上の current_angle_at_request -> actual_start_deg を
            # そのまま直線的に進んだ比率で表します。最短経路は選びません。
            start_deg = float(plan.get("current_angle_at_request", app_state.current_angle))
            target_deg = float(plan.get("actual_start_deg", start_deg))
            ratio = _directional_progress(start_deg, target_deg, app_state.current_angle)
            percent = int(_clamp(ratio * 15.0, 0.0, 15.0))

            actual_speed = float(plan.get("actual_speed_deg_s", 0.0))
            if actual_speed > 0:
                remaining_deg = abs(target_deg - app_state.current_angle)
                estimated_remaining_ms = int(max(0.0, remaining_deg / actual_speed * 1000.0))
            else:
                estimated_remaining_ms = int(max(0.0, float(plan.get("estimated_approach_ms", 0.0))))
            message = message or "Moving to approach position"
        elif phase == "sweep":
            # sweep 本体も、actual_start_deg -> actual_end_deg の計画方向に沿って進捗を出します。
            # ここが「10 -> 350 を +方向で進む」ケースに対応するポイントです。
            start_deg = float(plan.get("actual_start_deg", app_state.current_angle))
            target_deg = float(plan.get("actual_end_deg", start_deg))
            ratio = _directional_progress(start_deg, target_deg, app_state.current_angle)
            percent = int(_clamp(15.0 + ratio * 80.0, 15.0, 95.0))

            actual_speed = float(plan.get("actual_speed_deg_s", 0.0))
            if actual_speed > 0:
                remaining_deg = abs(target_deg - app_state.current_angle)
                estimated_remaining_ms = int(max(0.0, remaining_deg / actual_speed * 1000.0))
            else:
                estimated_remaining_ms = int(max(0.0, float(plan.get("estimated_sweep_ms", 0.0))))
            message = message or "Sweeping"
        elif phase == "finalize":
            # finalize は状態復帰・速度戻しなどの後処理を表します。
            # 実移動が終わっていても、リソース解放や状態更新が残るため、
            # ここで 95〜100% を埋めて完了直前を表現します。
            duration = max(1.0, float(state.get("finalize_estimated_ms", 1000.0)))
            percent = int(_clamp(95.0 + (elapsed_ms() / duration) * 5.0, 95.0, 100.0))
            estimated_remaining_ms = max(0.0, duration - elapsed_ms())
            message = message or "Finalizing sweep"

    elif status == "succeeded":
        percent = 100
        message = message or "Sweep completed"
    elif status == "failed":
        percent = state.get("percent", 0)
        message = message or "Sweep failed"
    elif status == "cancelled":
        percent = state.get("percent", 0)
        message = message or "Sweep cancelled"

    if phase == "approach" and target_deg is None:
        target_deg = plan.get("actual_start_deg")
    elif phase == "sweep" and target_deg is None:
        target_deg = plan.get("actual_end_deg")

    return {
        "operation_id": operation_id,
        "kind": state.get("kind", "sweep"),
        "status": status,
        "phase": phase,
        "percent": int(_clamp(percent, 0, 100)),
        "message": message,
        "current_deg": app_state.current_angle,
        "target_deg": target_deg,
        "estimated_remaining_ms": int(max(0.0, estimated_remaining_ms)),
    }


def _run_sweep_operation(operation_id: str, request_data: dict, plan: dict):
    """Sweep をバックグラウンドで実行し、progress 状態を更新する。

    フロー概要:
    1) 受理済み状態をセット -> progress API が operation_id を返せるようにする
    2) 速度設定を sweep 用に切り替え
    3) 助走位置へ絶対移動（allow_overflow=True）し、到着まで待機
    4) 助走完了後、相対移動で sweep 本体を一度に実行
    5) 高速監視ループで Start/End 角度をまたいだ瞬間に録画トリガーを引く
    6) 後処理（速度復帰、成功/失敗状態のセット、録画の安全終了）

    重要な設計上のポイント:
    - キャンセル判定: 各主要ステップの後に `_get_sweep_state_snapshot().get("cancel_requested")` を
        チェックしており、フロントからのキャンセル要求がある場合は安全に早期退出します。
    - 速度/移動コマンドはブロッキング呼び出しであり、バックグラウンドスレッド内で実行することで
        メインの API スレッドをブロックしないようにしています。
    - すべての失敗（`StageCommandError` やその他の例外）は `_set_sweep_state(status="failed", ...)` を通じて
        progress 状態へ反映されます。フロントはこれを見てユーザーへエラー表示できます。
    - 終了時は必ず待機速度に戻し、`app_state.is_measuring` を False に戻して手動操作を許可します。
    """
    try:
        # まず状態を「受付済み→実行中」へ切り替えます。
        # これにより progress API は、開始直後でも operation_id と計画を返せます。
        _set_sweep_state(
            operation_id=operation_id,
            kind="sweep",
            status="running",
            phase="prepare",
            percent=0,
            message="Sweep accepted",
            plan=plan,
            started_at_ms=_now_ms(),
            phase_started_at_ms=_now_ms(),
            request=request_data,
            cancel_requested=False,
            finalize_estimated_ms=1000.0,
        )

        auto_record = request_data.get("auto_record", False)

        # 【録画の事前準備】
        # 録画用ファイル（TIFF/CSV）の作成とオープンをここで行います。
        # ファイルI/O（読み書き）は、OSやディスクの状態によって数秒間フリーズする可能性があるため、
        # メインの実行処理を止めないよう、別スレッド（Thread）を使ってタイムアウト付きで実行します。
        if auto_record:
            prepare_success = False

            # スレッド内で実行する処理の定義
            def _do_prepare():
                # `nonlocal` キーワード:
                # この関数（_do_prepare）の外側にある変数（prepare_success）を、内部から書き換えるために必要です。
                nonlocal prepare_success
                try:
                    # prepare_recording: ファイルを開いてスタンバイするメソッド。
                    # 戻り値: 成功なら True, 失敗なら False。
                    prepare_success = camera.prepare_recording()
                except Exception:
                    prepare_success = False
            
            # 1. 新しい作業用スレッド（Thread）を作成します。
            # target: スレッドで実行する関数。 daemon=True: アプリ終了時にこのスレッドも強制終了させる設定。
            prepare_thread = threading.Thread(target=_do_prepare, daemon=True)
            # 2. スレッドの実行を開始（非同期にスタート）します。
            prepare_thread.start()
            
            # 3. .join(timeout=3.0) メソッド:
            # 「指定した秒数（ここでは3秒）だけ、そのスレッドの完了を待ち合わせる」という命令です。
            # 3秒以内に終われば即座に次の行へ進みます。3秒経っても終わらなければ、諦めて次の行へ進みます。
            prepare_thread.join(timeout=3.0)
            
            # 4. .is_alive() メソッド:
            # 3秒経った後もスレッドがまだ動いている（alive）かどうかをチェックします。
            # True の場合は、ファイルI/Oがフリーズ（タイムアウト）していると判断し、エラーにします。
            if prepare_thread.is_alive():
                raise Exception("Recording preparation timed out (>3s). Storage may be unresponsive.")
            if not prepare_success:
                raise Exception("Failed to prepare recording. Check storage permissions and disk space.")

        # Sweep の本番前には速度設定を専用値へ切り替えます。
        if not stage.set_speed(stage.speed_min_pps, plan["safe_speed_pps"], stage.speed_accel_ms):
            raise StageCommandError("Failed to apply sweep speed")

        if _get_sweep_state_snapshot().get("cancel_requested"):
            _set_sweep_state(status="cancelled", phase="prepare", percent=0, message="Sweep cancelled before start")
            return

        # 1段目: 助走位置（Startより少し手前）まで絶対移動します。
        _set_sweep_state(phase="approach", phase_started_at_ms=_now_ms(), message="Moving to approach position")
        stage.move_absolute(plan["actual_start_deg"], allow_overflow=True)
        # ========================================================================
        # 【監視遅延対策：移動開始直後の即時ビジー化（助走開始）】
        # 常時角度監視タスク（stage_monitor_loop）は、静止時のシリアルI/OおよびUSB競合を
        # 低減するため 1.0秒に1回のポーリング周期に緩和されています。そのため、ここで移動開始命令
        # を送信した直後、監視タスクが起き上がってビジー（is_busy = True）を検出してグローバル
        # 状態に上書きするまでに最大 1.0秒のタイムラグ（遅延）が生じます。
        # この遅延の間に、下の完了待ちチェック（app_state.is_busy）が「移動はまだ開始されていない（False）」
        # と誤判定してすり抜けてしまう競合を防ぐため、ここで即座に is_busy = True に強制セットします。
        # ========================================================================
        app_state.is_busy = True

        # 【移動開始の検知待ち】
        # monitor_loop が is_busy=True を検知するまで最大 0.5秒待機します。
        wait_start = time.time()
        while not app_state.is_busy and (time.time() - wait_start < 0.5):
            time.sleep(0.02)

        while app_state.is_busy:
            if _get_sweep_state_snapshot().get("cancel_requested"):
                _set_sweep_state(status="cancelled", phase="approach", message="Sweep cancelled during approach")
                return
            # monitor_loop による app_state の更新を待ちます
            time.sleep(0.05)

        # 2段目: 助走位置から終端位置までを、1回の相対移動コマンドで流し切ります。
        _set_sweep_state(phase="sweep", phase_started_at_ms=_now_ms(), message="Sweeping")
        stage.move_relative(plan["relative_total_deg"], current_angle_hint=app_state.current_angle)
        # ========================================================================
        # 【監視遅延対策：移動開始直後の即時ビジー化（スイープ本番）】
        # 助走位置に到達しステージが一度静止した際、監視ポーリングは再び 1.0秒間隔に戻っています。
        # 本番の相対移動コマンドを送信した瞬間にも、同様の検知遅れ（最大1.0秒のタイムラグ）が生じるため、
        # 録画トリガーを判定する高速監視ループが即座に開始されずに移動完了判定がすり抜けてしまうのを
        # 防ぐ目的で、ここでも送信と同時に is_busy = True を即時強制適用します。
        # ========================================================================
        app_state.is_busy = True

        # 移動開始の検知待ち
        wait_start = time.time()
        while not app_state.is_busy and (time.time() - wait_start < 0.5):
            time.sleep(0.02)

        # 【本番移動中の高速監視と録画トリガー】
        # 10ms間隔で app_state (モニターが 100ms ごとに更新) をチェックします。
        direction_forward = plan["direction"] == "forward"
        start_deg = plan["trigger_start_deg"]
        end_deg = plan["trigger_end_deg"]
        
        has_started_recording = False
        has_stopped_recording = False
        
        while app_state.is_busy:
            if _get_sweep_state_snapshot().get("cancel_requested"):
                _set_sweep_state(status="cancelled", phase="finalize", percent=0, message="Sweep cancelled by user")
                return
                
            current_angle = app_state.current_angle
            
            if auto_record:
                if not has_started_recording:
                    # Start角度を越えたかを判定
                    if (direction_forward and current_angle >= start_deg) or (not direction_forward and current_angle <= start_deg):
                        camera.trigger_recording()
                        has_started_recording = True
                
                if has_started_recording and not has_stopped_recording:
                    # End角度を越えたかを判定
                    if (direction_forward and current_angle >= end_deg) or (not direction_forward and current_angle <= end_deg):
                        camera.stop_recording()
                        has_stopped_recording = True

            time.sleep(0.01)

        # 【フェイルセーフ】
        # 移動が終了しても録画が止まっていない場合は確実に停止させる
        if auto_record and has_started_recording and not has_stopped_recording:
            camera.stop_recording()
            has_stopped_recording = True

        # 後処理
        _set_sweep_state(phase="finalize", phase_started_at_ms=_now_ms(), message="Finalizing sweep")
        if not stage.set_speed(stage.speed_min_pps, stage.speed_max_pps, stage.speed_accel_ms):
            raise StageCommandError("Failed to restore default speed")
        _set_sweep_state(status="succeeded", phase="finalize", percent=100, message="Sweep completed")
    except StageCommandError as e:
        _set_sweep_state(status="failed", phase="finalize", message=str(e))
    except Exception as e:
        _set_sweep_state(status="failed", phase="finalize", message=str(e))
    finally:
        # 【全経路共通の後始末】
        if request_data.get("auto_record", False):
            try:
                # 既に停止済み（has_stopped_recording=True）なら重ねて呼ばないように
                # ここではフラグが関数スコープなので、念のため CameraController 側の状態も考慮されるべきですが、
                # 少なくともこのスレッド内での重複は防ぎます。
                if not locals().get("has_stopped_recording", False):
                    camera.stop_recording()
            except Exception:
                pass

        try:
            # 速度を元に戻す処理（安全のため finally でも実行）
            stage.set_speed(stage.speed_min_pps, stage.speed_max_pps, stage.speed_accel_ms)
        except Exception:
            pass
        with stage_command_lock:
            app_state.is_measuring = False
            if app_state.last_stage_command and app_state.last_stage_command.get("name") == "sweep":
                app_state.last_stage_command = None


def _run_auto_measurement(
    operation_id: str,
    start_angle: float,
    end_angle: float,
    step_angle: float,
    save_directory: str,
    is_prescan: bool = False,
    metadata: dict = None
):
    """
    Step & Shoot 方式による精密な自動測定シーケンスをバックグラウンドで実行します。
    """
    # finally ブロックで安全に参照できるよう、変数を関数の冒頭で定義・初期化します
    start_time_iso = datetime.now(timezone.utc).isoformat()
    initial_rois = []
    saturated_angles = [] # 測定中に飽和（白飛び）が発生した角度を追跡し、finallyブロックで警告ステータスに反映します。
    
    try:
        # Pre-Scan開始前（ユーザーが手動で配置したまま）の初期ROIをコピーして保持
        initial_rois = [dict(r) for r in camera.rois]

        # 初期状態のセット
        _set_auto_operation_state(
            operation_id=operation_id,
            status="running",
            percent=0,
            message="Initializing Pre-Scan..." if is_prescan else "Initializing measurement...",
            current_angle=start_angle,
            target_angle=end_angle,
            cancel_requested=False
        )

        # 測定セッションの開始（データバッファのリセット等）
        app_state.auto_measurement.start_session(save_directory)

        # --- 保存先パスの動的決定（モードによる分岐） ---
        if is_prescan:
            prescan_dir = os.path.join(save_directory, "prescan")
            os.makedirs(prescan_dir, exist_ok=True)
            attempt_number = 1
            while os.path.exists(os.path.join(prescan_dir, f"attempt_{attempt_number}.csv")):
                attempt_number += 1
            csv_filename = f"attempt_{attempt_number}.csv"
            csv_path = os.path.join(prescan_dir, csv_filename)
            images_dir = os.path.join(prescan_dir, f"attempt_{attempt_number}_images")
            multipaged_path = os.path.join(prescan_dir, f"attempt_{attempt_number}.tif")
        else:
            csv_filename = os.path.basename(os.path.normpath(save_directory)) + ".csv"
            csv_path = os.path.join(save_directory, csv_filename)
            images_dir = os.path.join(save_directory, "images")
            multipaged_path = os.path.join(save_directory, "images.tif")

        os.makedirs(images_dir, exist_ok=True)

        # --- 測定角度リストの生成 ---
        if start_angle == end_angle:
            angles = [start_angle]
        else:
            direction = 1 if end_angle > start_angle else -1
            step = abs(step_angle) * direction
            angles = []
            curr = start_angle
            while (direction > 0 and curr <= end_angle + 1e-6) or \
                  (direction < 0 and curr >= end_angle - 1e-6):
                angles.append(round(curr, 4))
                curr += step
                
        num_steps = len(angles)
        logger.info(f"[AUTO] Generated {num_steps} angles for measurement.")

        # --- CSVヘッダーの準備 ---
        # 測定データの完全なトレーサビリティを確保するため、以下の項目を出力します。
        # 1. Angle: ステージの現在角度。
        # 2. Timestamp: 計測時の正確な時刻。
        # 3. Filepath: 対応する画像へのパス。解析時に画像と数値を紐付けるための命綱です。
        # 4. ROIごとの統計量 (Sum, Max, Center, CX, CY, Drift)。
        try:
            with open(csv_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                headers = ["Angle", "Timestamp", "Filepath"]
                current_rois = camera.rois 
                sorted_rois = sorted(current_rois, key=lambda r: r.get("index", 0))
                for r in sorted_rois:
                    roi_idx = r.get("index", 0)
                    headers.extend([
                        f"roi_{roi_idx}_Sum",     # 全散乱強度
                        f"roi_{roi_idx}_Max",     # 飽和チェック用（最大輝度）
                        f"roi_{roi_idx}_Center",  # ROI中心（定点）の輝度
                        f"roi_{roi_idx}_CX",      # 輝度重心X
                        f"roi_{roi_idx}_CY",      # 輝度重心Y
                        f"roi_{roi_idx}_Drift"    # 基準点からの重心移動距離 [px]
                    ])
                writer.writerow(headers)
            logger.info(f"[AUTO] CSV initialized at {csv_path}")
        except Exception as e:
            logger.error(f"[AUTO] Failed to initialize CSV: {e}")

        # --- Step & Shoot メインループ ---
        for i, target_deg in enumerate(angles):
            if _get_auto_operation_snapshot().get("cancel_requested"):
                _set_auto_operation_state(status="cancelled", message="Measurement cancelled by user")
                break

            percent = int((i / num_steps) * 100)
            
            # ====================================================================
            # 【警告（Warning）状態の伝播】
            # これまでに見つかった「飽和した角度」のリストから、フロントエンド向けの警告メッセージを生成します。
            # 測定を強制停止（Abort）はせず、この has_warning フラグを True にして送ることで、
            # フロントエンド（React）側でプログレスバーをオレンジ色に変え、ユーザーに自発的なキャンセルを促します。
            # ====================================================================
            has_warning = len(saturated_angles) > 0
            warning_msg = f"Saturated at: {', '.join([f'{a:.1f}°' for a in saturated_angles])}" if has_warning else ""
            
            _set_auto_operation_state(
                percent=percent, 
                message=f"Moving to {target_deg:.2f}°", 
                current_angle=app_state.current_angle,
                has_warning=has_warning,
                warning_message=warning_msg
            )

            stage.move_absolute(target_deg, allow_overflow=True)
            # 【重要】ステージが実際に動き出すより前に、ここで即座に Busy フラグを True にし、
            # 監視ポーリング（静止時1.0秒間隔）が完了する前のタイムラグによって
            # 移動完了待ちループがスルーされてしまう競合を確実に防止します。
            app_state.is_busy = True
            
            # ステージが実際に動き出し、Busy フラグが True になるまでの猶予
            time.sleep(0.15)
            while app_state.is_busy:
                if _get_auto_operation_snapshot().get("cancel_requested"):
                    break
                time.sleep(0.05)

            if _get_auto_operation_snapshot().get("cancel_requested"):
                _set_auto_operation_state(status="cancelled", message="Measurement cancelled by user")
                break

            # ステージが電気的に停止した直後、物理的な「慣性振動」が残っている可能性があります。
            # この微小な揺れが完全に収まり、かつコントローラ内部の完了処理が確実に終わるのを待つため、
            # 待機時間を 0.2s から 0.3s に延長します。これにより実機での NG エラーを徹底的に防ぎます。
            time.sleep(0.3)
            _set_auto_operation_state(
                message=f"Taking snapshot at {target_deg:.2f}°",
                has_warning=has_warning,
                warning_message=warning_msg
            )
            
            filename = f"angle_{target_deg:09.4f}.tif"
            snapshot_result = camera.take_snapshot(filename_override=filename, save_dir_override=images_dir, force_centroid=is_prescan)
            
            if snapshot_result and snapshot_result.get("roi_stats"):
                stats = snapshot_result["roi_stats"]
                rois_map = {r.get("index"): r for r in camera.rois}
                
                # --- 飽和判定 ---
                # カメラのビット深度（例: 8-bit なら 255, 10-bit なら 1023）を取得し、
                # ギリギリのダイナミックレンジを活用するため、マージンは設けず理論上の最大値に達したかを判定する
                sensor_bpp = getattr(camera, 'input_bpp', 8)
                theoretical_max = (1 << sensor_bpp) - 1
                sat_threshold = theoretical_max
                
                is_saturated_this_frame = False
                
                try:
                    with open(csv_path, "a", newline="", encoding="utf-8") as f:
                        writer = csv.writer(f)
                        row = [snapshot_result["angle"], snapshot_result["timestamp"], snapshot_result.get("filepath", "")]
                        for r_idx_str in sorted(stats.keys(), key=lambda x: int(x)):
                            r_idx = int(r_idx_str)
                            r_data = stats[r_idx_str]
                            
                            if r_data.get("max", 0) >= sat_threshold:
                                is_saturated_this_frame = True
                                
                            drift = 0.0
                            roi_def = rois_map.get(r_idx)
                            if roi_def:
                                base_x = roi_def.get("x", 0.0)
                                base_y = roi_def.get("y", 0.0)
                                drift = ((r_data.get("cx",0) - base_x)**2 + (r_data.get("cy",0) - base_y)**2)**0.5
                            row.extend([r_data.get("sum",0), r_data.get("max",0), r_data.get("center_val",0), r_data.get("cx",0), r_data.get("cy",0), round(drift, 4)])
                        writer.writerow(row)
                        
                        if is_saturated_this_frame and target_deg not in saturated_angles:
                            saturated_angles.append(target_deg)
                            
                except Exception as e:
                    logger.error(f"[AUTO] Failed to append to CSV: {e}")

                app_state.auto_measurement.add_point(angle=target_deg, roi_stats=stats, filepath=snapshot_result.get("filepath"))
            else:
                logger.warning(f"[AUTO] Snapshot failed at {target_deg:.2f}°")

        # --- ループ終了後の後処理 ---
        current_state = _get_auto_operation_snapshot()
        if current_state.get("status") != "cancelled":
            _set_auto_operation_state(percent=100, message="Generating Multipage TIFF...")
            try:
                import tifffile
                image_files = sorted(glob.glob(os.path.join(images_dir, "*.tif")))
                if image_files:
                    with tifffile.TiffWriter(multipaged_path, append=False) as tif:
                        for img_file in image_files:
                            img = tifffile.imread(img_file)
                            if img is not None:
                                tif.write(img)
                    shutil.rmtree(images_dir, ignore_errors=True)
                    
                    if is_prescan:
                        _set_auto_operation_state(message="Calculating optimal ROI (Centroid)...")
                        plot_data = app_state.auto_measurement.get_plot_data()
                        updated_rois = []
                        for i, r in enumerate(camera.rois):
                            roi_idx = r.get("index", i)
                            key = f"roi_{roi_idx}"
                            if key not in plot_data or len(plot_data[key]) == 0:
                                updated_rois.append(r)
                                continue
                            pts = plot_data[key]
                            max_sum = max(p["sum"] for p in pts)
                            min_val = min(p["sum"] for p in pts)
                            if max_sum == 0 or (max_sum - min_val) / max_sum < 0.1:
                                updated_rois.append(r)
                                continue
                            threshold = max_sum * 0.2
                            valid_pts = [p for p in pts if p["sum"] > threshold]
                            if not valid_pts:
                                updated_rois.append(r)
                                continue
                            total_weight = sum(p["sum"] for p in valid_pts)
                            weighted_cx = sum(p["cx"] * p["sum"] for p in valid_pts) / total_weight
                            weighted_cy = sum(p["cy"] * p["sum"] for p in valid_pts) / total_weight
                            updated_r = dict(r)
                            updated_r.update({"x": int(round(weighted_cx)), "y": int(round(weighted_cy)), "optical_centroid_x": round(weighted_cx, 4), "optical_centroid_y": round(weighted_cy, 4)})
                            updated_rois.append(updated_r)
                        camera.set_rois(updated_rois)
                _set_auto_operation_state(status="succeeded", message="Measurement complete")
            except Exception as e:
                logger.error(f"[AUTO] Post-processing failed: {e}")
                _set_auto_operation_state(status="failed", message=str(e))
        else:
            logger.info("[AUTO] Measurement cancelled. Temporary images kept.")

    except Exception as e:
        logger.exception("[AUTO] Fatal error during measurement")
        _set_auto_operation_state(status="failed", message=str(e))
    finally:
        # ====================================================================
        # 【最優先クリーンアップ：測定中フラグの即座解除】
        # 後続のファイル保存（I/O）やステージの物理的な原点復帰で例外が発生しても、
        # システム全体が「測定中」のままフリーズしてデッドロックするのを完全に防ぐため、
        # 何よりも先に測定中ロックフラグを解除します。
        # ====================================================================
        try:
            with stage_command_lock:
                app_state.is_measuring = False
        except Exception as e:
            logger.error(f"[AUTO] Failed to release measuring flag: {e}")

        # 最終状態の取得。succeeded はユーザー表示用の completed にマッピングします。
        final_state = _get_auto_operation_snapshot()
        raw_status = final_state.get("status", "failed")
        
        # 【飽和警告ステータスの永続化】
        # 物理的に正常終了（succeeded）した場合でも、測定の過程で一度でも飽和角度が検出されていた場合
        # （len(saturated_angles) > 0）は、最終的な保存ステータスを "completed" ではなく "saturated" に設定します。
        if raw_status == "succeeded":
            final_status = "saturated" if len(saturated_angles) > 0 else "completed"
        else:
            final_status = raw_status
            
        final_message = final_state.get("message", "")

        # measurement_details.json (旧 roi_settings.json) の更新
        try:
            if os.path.exists(save_directory):
                details_path = os.path.join(save_directory, "measurement_details.json")
                details_data = {}
                if os.path.exists(details_path):
                    with open(details_path, "r", encoding="utf-8") as f:
                        details_data = json.load(f)
                
                # --- [重要] 試行履歴 (prescan_history) の記録 ---
                # リネーム時に失われていた試行ごとの履歴を復元します。
                # Pre-Scan の場合は、 attempt ごとのスナップショットを残します。
                if "prescan_history" not in details_data:
                    details_data["prescan_history"] = []
                
                # その時点の環境メタデータを取得
                current_env = {
                    "metadata": metadata or {},
                    "camera": {
                        "exposure_time_ms": camera.get_exposure(),
                        "gain": camera.get_gain(),
                        "input_bpp": getattr(camera, 'input_bpp', 8)
                    }
                }

                if is_prescan:
                    # attempt_number は try ブロック内で計算されているはずですが、
                    # 万が一未定義の場合は履歴の長さから推測します。
                    actual_attempt = attempt_number if 'attempt_number' in locals() else len(details_data["prescan_history"]) + 1
                    details_data["prescan_history"].append({
                        "attempt": actual_attempt,
                        "status": final_status,
                        "message": final_message,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "environment": current_env
                    })
                else:
                    # 本番測定時は、最終的に使用された確定設定として環境情報を記録します
                    details_data["final_environment"] = current_env

                # ROI情報の記録（初期の手動指定座標と、Pre-Scan後の最終確定座標）
                details_rois = []
                current_rois_map = {r.get("index"): r for r in camera.rois}
                for i_roi in initial_rois:
                    r_idx = i_roi.get("index")
                    f_roi = current_rois_map.get(r_idx, i_roi)
                    details_rois.append({
                        "index": r_idx,
                        "initial": {"x": i_roi.get("x"), "y": i_roi.get("y"), "size": i_roi.get("size")},
                        "final_aligned": {
                            "x": f_roi.get("x"), 
                            "y": f_roi.get("y"), 
                            "size": f_roi.get("size"),
                            "optical_centroid_x": f_roi.get("optical_centroid_x"),
                            "optical_centroid_y": f_roi.get("optical_centroid_y")
                        }
                    })
                
                details_data.update({
                    "measurement_id": os.path.basename(os.path.normpath(save_directory)),
                    "status": final_status,
                    "message": final_message,
                    "timestamp_start": start_time_iso,
                    "timestamp_end": datetime.now(timezone.utc).isoformat(),
                    "rois": details_rois
                })
                
                with open(details_path, "w", encoding="utf-8") as f:
                    json.dump(details_data, f, indent=2, ensure_ascii=False)
                logger.info(f"[AUTO] Updated measurement details at {details_path}")
        except Exception as e:
            logger.error(f"[AUTO] Failed to save details: {e}")

        # settings.json の更新（本番測定のみ）
        if not is_prescan:
            try:
                m_id = os.path.basename(os.path.normpath(save_directory))
                history_entry = {
                    "id": m_id,
                    "step_category": "_".join(m_id.split("_")[:-1]),
                    "status": final_status,
                    "message": final_message,
                    "timestamp_start": start_time_iso,
                    "timestamp_end": datetime.now(timezone.utc).isoformat()
                }
                data_saver.append_measurement_history(os.path.dirname(os.path.normpath(save_directory)), history_entry)
                logger.info(f"[AUTO] Appended history to settings.json with status={final_status}")
            except Exception as e:
                logger.error(f"[AUTO] Failed to append history: {e}")

        # --- 自動原点復帰 (Auto Homing) ---
        # 測定エラー等によりステージがまだ移動中の場合、その完了（静止）を最大15秒待ってから
        # 原点復帰コマンドを送信し、重複送信による NG エラーを防ぎます。
        try:
            if app_state.is_busy:
                logger.info("[AUTO] Stage is busy. Waiting for stop before homing...")
                wait_start = time.time()
                while app_state.is_busy and (time.time() - wait_start < 15.0):
                    time.sleep(0.1)

            logger.info("[AUTO] Returning stage to hardware origin (Home)...")
            stage.home()
            app_state.is_busy = True # 監視ポーリングの遅延タイムラグを防ぐため即座にビジー化
        except Exception as e:
            logger.error(f"[AUTO] Failed to return to origin: {e}")


def _terminate_backend_process():
    """/system/shutdown 応答送信後に、バックエンド自身を終了させる。"""
    pid = os.getpid()
    logger.info(f"[SYSTEM] Requesting backend process termination (pid={pid}).")
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception as e:
        logger.error(f"[SYSTEM] Failed to terminate backend process cleanly: {e}")
        # ここまで失敗した場合は最終手段で即終了する
        os._exit(0)

async def stage_monitor_loop():
    """【常時監視タスク】ステージの角度を定期的に取得し、キャッシュとカメラに最新値を配ります。
    静止時は通信負荷・USBバス負荷（およびカメラのキャプチャ干渉）を抑えるため1.0秒間隔（1000ms）とし、
    移動中（app_state.is_busy）のみ表示のリアルタイム性を保つため0.1秒間隔（100ms）に動的に引き上げます。

    Returns:
        None
    """
    logger.info("[SYSTEM] Stage monitor loop started.")
    prev_busy = False
    while True:
        try:
            # ========================================================================
            # 【動的ポーリング間隔の算出と非同期待機】
            # ステージが接続されている環境において、同じUSBホストコントローラ（USBバスライン）上で
            # 高解像度・高頻度な画像転送（uc480カメラ）とシリアルパケット（RS232C通信）が走り続けると、
            # 帯域や電源供給の競合からカメラの転送エラー（Capture failed）が発生する問題がありました。
            #
            # 解決策として、ステージの状態（app_state.is_busy）を評価し、以下のように待機間隔を動的に制御します。
            # - [ステージ静止時]: 角度の変化がないため、監視頻度を 1.0 秒（1000ms）に下げ、不要なシリアルI/Oを激減させます。
            # - [ステージ移動中]: 角度が動くため、追従性を保つために 0.1 秒（100ms）に一時的に引き上げます。
            # 
            # ※自動測定中（スキャン中）は、測定スレッド側で優先ロック（is_priority_locked）が作動するため、
            #   この監視タスクによるシリアル通信自体が自動的に完全に遮断（無効化）されます。
            #   これにより、測定中のカメラ撮影プロセスは完全に通信競合から守られます。
            # ========================================================================
            interval = 0.1 if app_state.is_busy else 1.0
            # asyncio.sleep は非ブロッキングなスリープを指示する非同期関数であり、
            # 指定時間の間、FastAPI のイベントループの制御権を一旦別の非同期タスクに譲る動作をします。
            await asyncio.sleep(interval)
            
            if stage.is_connected:
                # シリアル通信はI/O待ちが発生するため、try_get_status は非同期ラッパー経由で呼び出します。
                # `stage.try_get_status` は内部で `_io_lock` を使って短時間だけロックを試み、
                # ロックが取得できない（別リクエストが未完了）場合は None を返します。
                # その場合はこのサイクルをスキップして次回ポーリングを待ち、UI 側が固まらないようにします。
                status = await asyncio.to_thread(stage.try_get_status)
                if status is None:
                    logger.debug("[SYSTEM] Stage status poll skipped (I/O busy)")
                    continue

                pos, busy = status
                sampled_at_ms = datetime.now(timezone.utc).timestamp() * 1000.0
                app_state.current_angle = pos
                app_state.is_busy = busy

                # Busy -> Ready の遷移を「移動完了」とみなし、最終角度を1行で残す
                if prev_busy and not busy:
                    cmd = app_state.last_stage_command
                    # 注意: `last_stage_command` は API 呼び出し側で設定され、
                    # monitor は移動完了時にログ出力とクリアのみ行います。
                    # monitor 側で状態変更を行う場合はロックを検討してください（現状は単純化しています）。
                    if cmd:
                        logger.info(
                            "[STAGE COMPLETE] name=%s requested=%s final_angle=%.4f",
                            cmd.get("name"),
                            cmd.get("requested"),
                            pos,
                        )
                    else:
                        logger.info("[STAGE COMPLETE] final_angle=%.4f", pos)
                    app_state.last_stage_command = None

                prev_busy = busy
                
                # カメラのCSV記録用にも常に最新の角度を供給し続ける
                camera.current_angle = pos
                camera.current_angle_timestamp_ms = sampled_at_ms
        except asyncio.CancelledError:
            break # サーバー終了時にタスクがキャンセルされたらループを抜ける
        except Exception as e:
            logger.debug(f"[SYSTEM] Monitor error: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    【ライフサイクル管理】FastAPIアプリケーションの起動・終了時の処理を定義します。
    
    yield の前のコードはサーバー起動時（startup）に実行され、
    yield の後のコードはサーバー終了時（shutdown、Ctrl+Cなど）に実行されます。
    これにより、アプリケーション終了時にハードウェアリソースを安全かつ確実に解放できます。
    
    Args:
        app (FastAPI): FastAPIのアプリケーションインスタンス。

    Returns:
        AsyncGenerator: 起動・終了処理を管理するコンテキスト。
    """
    logger.info("[SYSTEM] Backend Starting...")
    logger.debug(f"[SYSTEM] Backend PID={os.getpid()} PPID={os.getppid()}")

    # 【システム連携】
    # 以前はここでカメラの解析データを常時バッファに流し込む設定をしていましたが、
    # 測定精度の確保（撮影画像と計算値の厳密な一致）のため、
    # 蓄積は自動測定シーケンス内での明示的な Snapshot 呼び出し時に行う方針に変更されました。
    camera.on_roi_stats_computed = None
    logger.info("[SYSTEM] Data pipeline initialized (Trigger-based mode)")
    
    # 常時監視タスクの起動
    # asyncio.create_task は、非同期関数をバックグラウンドで並行実行させる標準機能です。
    monitor_task = asyncio.create_task(stage_monitor_loop())
    
    # ここでサーバーが起動し、リクエストの受付を開始します。
    yield # ここでサーバーがリクエストを受け付け続ける（稼働状態）
    
    # サーバー終了時(shutdown)の処理
    # Ctrl+Cなどで停止した際に、開いているリソース（COMポート、カメラ）を確実に閉じます。
    logger.info("[SYSTEM] Backend Shutting Down...")
    
    # 監視タスクの停止
    monitor_task.cancel()
    logger.info("[SYSTEM] Stage monitor task cancellation requested.")
    try:
        await monitor_task
    except asyncio.CancelledError:
        logger.info("[SYSTEM] Stage monitor task cancelled cleanly.")
    
    # 強制的に切断処理
    logger.info("[SYSTEM] Releasing Stage Conection...")
    if stage.is_connected:
        stage.close()
    
    logger.info("[SYSTEM] Releasing Camera Conection...")
    if camera.is_connected:
        camera.disconnect()
    
    logger.info("[SYSTEM] Cleanup Complete.")

app = FastAPI(title="NanoPol Backend", version="0.1.0", lifespan=lifespan)

# ==========================================
# CORS (Cross-Origin Resource Sharing) の設定
# ==========================================
# Tauriのフロントエンド（React: 通常は localhost:1420 や tauri://localhost）から、
# このバックエンドサーバー（localhost:14201）へのHTTPリクエストを許可するためのセキュリティ設定です。
# 
# 【重要】allow_credentials=True（認証情報の送信許可）に設定する場合、
# Web標準のセキュリティ仕様により allow_origins=["*"]（全許可）は使用できずエラーになります。
# そのため、Tauriアプリが使用する固有のオリジンを明示的にリストアップして許可します。
# CORSの許可オリジンを一元管理します。
# この配列を CORSMiddleware 設定と起動時ログ出力の両方で共通利用することで、
# 「実際に許可している値」と「ログで表示している値」の不一致を防ぎます。
allowed_origins = [
    "http://localhost:1420",  # 開発中のTauriフロントエンド (Viteローカルサーバー)
    "tauri://localhost",      # ビルド後のTauriアプリ (macOS / Linux)
    "https://tauri.localhost",# ビルド後のTauriアプリ (Windows HTTPS)
    "http://tauri.localhost"  # ビルド後のTauriアプリ (Windows HTTP)
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True, # クッキーや認証情報の送信を許可します。
    allow_methods=["*"], # GET, POST, OPTIONSなど、全てのHTTPメソッドを許可します。
    allow_headers=["*"], # 全てのHTTPヘッダーの送信を許可します。
)

# ==========================================
# CORS ログ出力（スタートアップ確認用）
# ==========================================
# 起動直後に「現在のCORS許可設定」を必ず1回表示します。
# 運用時に問題が発生した際、設定ファイルや環境変数を追わなくても
# コンソールログだけで有効なオリジン一覧を確認できるようにするためです。
logger.info("[STARTUP] CORS allow_origins configured:")
for origin in allowed_origins:
    logger.info(f"[STARTUP] [OK] {origin}")

# ==========================================
# OPTIONS リクエスト ログ用ミドルウェア
# ==========================================
@app.middleware("http")
async def log_cors_requests(request: Request, call_next):
    """CORS preflight（OPTIONS）リクエストの往復情報をログに出力する。"""
    # CORS障害の初動切り分けでは、まず「どのOriginが来たか」を確認する必要があります。
    # ここで request.headers["origin"] を記録することで、
    # フロント実際のOriginと allow_origins の不一致を即座に判断できます。
    origin = request.headers.get("origin", "N/A")
    method = request.method
    path = request.url.path
    
    if method == "OPTIONS":
        # preflight受信ログ: ブラウザが本リクエスト前に送る検証要求。
        # ここが出ない場合は、クライアント側で到達していない可能性が高いです。
        logger.debug(f"[CORS PREFLIGHT] {method} {path} Origin={origin}")
    
    response = await call_next(request)
    
    if method == "OPTIONS":
        # preflight応答ログ: ステータスと Access-Control-Allow-Origin を確認します。
        # Status が 400/500、または Allow-Origin が NOT SET の場合は CORS 設定不整合の可能性が高いです。
        allow_origin = response.headers.get("access-control-allow-origin", "NOT SET")
        if response.status_code >= 400 or allow_origin == "NOT SET":
            logger.warning(
                f"[CORS RESPONSE] Status={response.status_code} Allow-Origin={allow_origin} "
                f"Method={method} Path={path} Origin={origin}"
            )
        else:
            logger.debug(
                f"[CORS RESPONSE] Status={response.status_code} Allow-Origin={allow_origin} "
                f"Method={method} Path={path} Origin={origin}"
            )
    
    return response

# ==========================================
# リクエストボディの型定義 (Pydantic Models)
# ==========================================
# クライアント（フロントエンド）からPOST送信されるJSONデータの構造を定義します。
# FastAPIはこれらのモデルを使用して、自動的に以下の処理を行います：
# 1. データの型変換（例: 文字列 "123" を 整数 123 に変換）
# 2. バリデーション（必須項目が欠けていたり、型が間違っている場合は自動でHTTP 422エラーを返す）
# 3. OpenAPI(Swagger UI) ドキュメントの自動生成

class ConnectStageRequest(BaseModel):
    port: str # 接続先のCOMポート名（例: "COM3", "/dev/ttyUSB0"）

class MoveAbsoluteRequest(BaseModel):
    angle: float # 目標とする絶対角度（度）
    allow_overflow: bool = False  # True の場合は 0..360 のソフトリミットを超える値を許可する
    # 詳細:
    # - 通常はフロントエンドが 0.0〜360.0 の範囲に収めるべきです。
    # - `allow_overflow=True` は「アプローチ動作」などで意図的に360度範囲を越えて
    #   絶対位置を指定するためのフラグです（例: 送り出し → 相対sweep の手順）。
    # - ただしバックエンドは受信角度をパルスに換算して追加の保護を行い、
    #   負のパルスや許容総パルス上限を超える指示は拒否します。

class MoveRelativeRequest(BaseModel):
    delta: float # 現在位置からの相対的な移動量（度）

class StopStageRequest(BaseModel):
    immediate: bool = False # Trueの場合は非常停止（即時停止）、Falseの場合は減速停止

class SetSpeedRequest(BaseModel):
    min_pps: int = 500 # 最小速度（パルス/秒）。初速として使用されます。
    max_pps: int # 最大速度（パルス/秒）
    accel_time_ms: int = 200 # 最小速度から最大速度に到達するまでの加減速時間（ミリ秒）

class SweepRunRequest(BaseModel):
    start_deg: float
    end_deg: float
    speed_deg_s: float
    auto_record: bool = False

class AutoMeasurementRunRequest(BaseModel):
    start_angle: float
    end_angle: float
    step_angle: float
    save_directory: str
    is_prescan: bool = False
    metadata: dict = None

class UpdateConfigRequest(BaseModel):
    pulses_per_degree: int # 1度回転させるために必要なモーターのパルス数（分解能）

class CameraConfigRequest(BaseModel):
    exposure_ms: float
    gain: float

class CameraConnectRequest(BaseModel):
    camera_id: int = 0

class ROISetRequest(BaseModel):
    rois: list

class SystemSettingsRequest(BaseModel):
    settings: dict # config.json の内容を含む、任意のキー・バリュー設定データ

class SaveSnapshotRequest(BaseModel):
    filepath: str # スナップショット画像を保存する絶対パス

class LogPostRequest(BaseModel):
    level: str # ログレベル（"ERROR", "WARNING", "INFO" など）
    message: str # 記録するログメッセージ

class MeasurementSessionCreateRequest(BaseModel):
    sample_name: str = "" # 空の場合は自動採番されます

# ==========================================
# システム関連 API
# ==========================================

@app.get("/health")
def health_check(request: Request):
    """
    【フロントエンド起動時の生存確認用API】
    バックエンドサーバーが正常に起動しているか、および各ハードウェアの現在の接続状態を返します。
    
    Args:
        request (Request): 呼び出し元の HTTP リクエスト。origin や host の記録に使います。

    Returns:
        dict: ステータス、ステージの接続状態、カメラの接続状態、動作モード（Mock/Real）。
    """
    # 接続切り分け用: UI/WebViewから到達しているかを system.log だけで判定できるようにする
    # Request.headers は受信した HTTP ヘッダ群へのアクセス手段です。
    # Health checks are frequent; keep them at DEBUG to avoid log noise in INFO logs
    logger.debug(
        "[HEALTH] %s %s origin=%s host=%s",
        request.method,
        request.url.path,
        request.headers.get("origin", "-"),
        request.headers.get("host", "-"),
    )

    return {
        "status": "OK",
        "stage_connected": stage.is_connected,
        "camera_connected": camera.is_connected,
        "mode": "Mock" if stage.is_mock_env else "Real"
    }

@app.post("/system/reset")
def system_reset():
    """
    【強制リセットAPI】
    システムに異常が発生した際などに、すべてのハードウェアデバイス（ステージ・カメラ）の
    接続を強制的に切断し、リソースを解放します。

    Returns:
        dict: リセット結果のステータスとメッセージ。
    """
    logger.warning("[SYSTEM] FORCE RESET TRIGGERD")
    
    # Python では if obj: で None/空/False 相当をまとめて判定できます。
    if stage:
        stage.close()
    if camera:
        camera.disconnect()
    
    return {"status": "success", "message": "All connections forcefully reset."}

@app.post("/system/shutdown")
def system_shutdown(background_tasks: BackgroundTasks):
    """アプリ終了直前に、ログを残したうえで機器を安全に閉じます。"""
    logger.info("[SYSTEM] Shutdown requested by Tauri sidecar.")

    if stage.is_connected:
        logger.info("[SYSTEM] Closing stage during shutdown request...")
        stage.close()
    else:
        logger.info("[SYSTEM] Stage already disconnected at shutdown request.")

    if camera.is_connected:
        logger.info("[SYSTEM] Disconnecting camera during shutdown request...")
        camera.disconnect()
    else:
        logger.info("[SYSTEM] Camera already disconnected at shutdown request.")

    for handler in logger.handlers:
        try:
            handler.flush()
        except Exception:
            pass

    # レスポンス返却後に自身を終了させる。これにより sidecar kill が失敗しても残留しにくくなる。
    background_tasks.add_task(_terminate_backend_process)

    return {"status": "success", "message": "Shutdown cleanup completed."}

@app.get("/system/ports")
def get_system_ports():
    """
    PCに現在接続されているシリアル（COM）ポートの一覧を取得します。
    
    Returns:
        dict: 利用可能なポート名のリスト（例: ["COM1", "COM3"]）。Mock環境時はダミーを返します。
    """
    if stage.is_mock_env:
        logger.info("[PORT ENUM] mode=Mock")
        return {
            "ports": [
                "COM1（Mock）",
                "COM3（Mock）",
                "COM4（Mock）",
            ],
        }
    
    # 実機環境ならOSからCOMポート一覧を取得
    ports = [p.device for p in list_ports.comports()]
    logger.info("[PORT ENUM] mode=Real count=%d", len(ports))
    
    if not ports:
        return {"ports": []}
    
    return {"ports": ports}

@app.post("/system/settings")
def update_system_settings(req: SystemSettingsRequest):
    """
    システム全体（カメラ・ステージ）のデフォルト設定を一括で更新・反映します。
    フロントエンドの設定画面（SettingsView）で「Save Settings」が押された際に呼び出されます。

    Args:
        req (SystemSettingsRequest): フロントエンドの config.json の内容。

    Returns:
        dict: 更新結果のステータス。
    """
    camera.update_settings(req.settings)
    
    if "defaultSpeedMin" in req.settings:
        min_pps = req.settings["defaultSpeedMin"]
        max_pps = req.settings["defaultSpeedMax"]
        accel_time_ms = req.settings["defaultAccelTime"]

        if stage.is_connected or stage.is_mock_env:
            stage.set_speed(min_pps, max_pps, accel_time_ms)
        else:
            # ステージ未接続時はハードウェアへ送れないため、再接続時に再適用できるよう設定値だけ保持する。
            stage.speed_min_pps = min_pps
            stage.speed_max_pps = max_pps
            stage.speed_accel_ms = accel_time_ms
            logger.info(
                "[SYSTEM] Stage not connected; cached speed settings without applying to hardware."
            )
    return {"status": "success"}

# ==========================================
# ステージ制御関連 API
# ==========================================

@app.post("/stage/connect")
def connect_stage(req: ConnectStageRequest):
    """
    指定されたCOMポートを使用して、回転ステージ（OptoSigma GSC-01）とのシリアル接続を確立します。
    
    【設計のポイント】
    FastAPIでは、I/O待ちが発生する通信処理を `async def` ではなく通常の `def` で定義することで、
    内部の別スレッド（スレッドプール）で実行され、他のAPIリクエストをブロック（停止）させません。
    """
    try:
        stage.connect(req.port)
        
        mode = "Mock" if stage.is_mock_env else "Real"
        
        logger.info(f"Connected to stage on {req.port} (Mode: {mode})")
        return {
            "status": "success",
            "mode": mode,
            "message": f"Connected to {req.port} (mode)"
        }
    except Exception as e:
        # HTTPException: フロントエンドに明示的なエラーを伝えるためのFastAPIの機能です。
        # 500 (Internal Server Error): サーバーやハードウェア側で予期せぬ問題が発生したことを示します。
        # 400 (Bad Request): クライアント（フロントエンド）からのリクエスト内容が間違っている場合に使います。
        # 503 (Service Unavailable): デバイスが接続されていないなど、現在サービスが提供できない状態を示します。
        
        # 接続失敗時は500エラーを返し、フロントエンド側でcatchさせる
        logger.error(f"Stage Connection Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/stage/disconnect")
def disconnect_stage():
    """ステージ接続を明示的に切断します。"""
    if app_state.is_measuring:
        raise HTTPException(status_code=409, detail="Sweep is running")
    stage.disconnect()
    logger.info("[STAGE] Disconnected by API request")
    return {"status": "success", "message": "Stage disconnected"}

@app.post("/stage/config")
def stage_update_config(req: UpdateConfigRequest):
    """
    ステージの分解能（1度回転させるのに必要なパルス数）などの内部設定を更新します。
    このAPIは、ステージが未接続の状態でも実行可能です。
    """
    stage.update_settings(req.pulses_per_degree)
    
    return {
        "status": "success",
        "message": "Configuration updated",
    }

@app.post("/stage/home")
def stage_home():
    """
    ステージを機械的な原点（ホーム位置）に復帰させます。（H:1 コマンドの発行）
    
    Raises:
        HTTPException (400): ステージが未接続の場合。
        HTTPException (500): 機器からの応答がエラーであった場合。
    """
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")
    if app_state.is_measuring:
        raise HTTPException(status_code=409, detail="Sweep is running")

    with stage_command_lock:
        if app_state.is_busy:
            raise HTTPException(status_code=409, detail="Stage is busy")
        app_state.is_busy = True
        app_state.last_stage_command = {"name": "home", "requested": "origin"}

    logger.info("[STAGE API] home requested")
    # 実行: デバイス層呼び出しによるエラーマッピング
    # - ValueError: クライアント入力エラー -> HTTP 400
    # - StageCommandError: 機器保護による拒否 -> HTTP 409 (Conflict)
    # - その他の例外: 予期せぬサーバー/デバイスエラー -> HTTP 500
    try:
        stage.home()
    except ValueError as e:
        with stage_command_lock:
            app_state.is_busy = False
        raise HTTPException(status_code=400, detail=str(e))
    except StageCommandError as e:
        with stage_command_lock:
            app_state.is_busy = False
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        with stage_command_lock:
            app_state.is_busy = False
        raise HTTPException(status_code=500, detail=str(e))
    
    logger.info("[STAGE API] home accepted")
    
    return {
        "status": "success",
        "command": "home",
        "accepted": True,
    }

@app.post("/stage/move/absolute")
def stage_move_absolute(req: MoveAbsoluteRequest):
    """
    ステージを指定した絶対角度（0〜360度などの固定位置）へ移動させます。
    """
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")
    if app_state.is_measuring:
        raise HTTPException(status_code=409, detail="Sweep is running")

    with stage_command_lock:
        if app_state.is_busy:
            raise HTTPException(status_code=409, detail="Stage is busy")
        app_state.is_busy = True
        app_state.last_stage_command = {"name": "move_absolute", "requested": req.angle}

    logger.info("[STAGE API] move_absolute requested: angle=%s", req.angle)
    # 注意: `allow_overflow` を受け取ることでフロントエンドは
    # "アプローチは絶対位置で送り、その後相対移動で一気にsweepする" といった
    # 動作を行えます。しかしバックエンドはパルスベースの安全チェックを行い、
    # 危険な指示は `StageCommandError` で拒否します。
    try:
        stage.move_absolute(req.angle, allow_overflow=req.allow_overflow)
    except ValueError as e:
        with stage_command_lock:
            app_state.is_busy = False
        raise HTTPException(status_code=400, detail=str(e))
    except StageCommandError as e:
        with stage_command_lock:
            app_state.is_busy = False
        # ここで HTTP 409 を返すことでフロントは「状態により拒否された」ことを
        # 明確に判断でき、ユーザーにホームを促すなど具体的な指示が出せます。
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        with stage_command_lock:
            app_state.is_busy = False
        raise HTTPException(status_code=500, detail=str(e))
    
    logger.info("[STAGE API] move_absolute accepted: angle=%s", req.angle)
    
    return {
        "status": "success",
        "command": "move_absolute",
        "requested_angle": req.angle,
        "accepted": True,
    }

@app.post("/stage/move/relative")
def stage_move_relative(req: MoveRelativeRequest):
    """
    ステージを現在の位置から、指定した角度分だけ相対的に移動させます（プラスで正転、マイナスで逆転）。
    """
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")
    if app_state.is_measuring:
        raise HTTPException(status_code=409, detail="Sweep is running")

    with stage_command_lock:
        if app_state.is_busy:
            raise HTTPException(status_code=409, detail="Stage is busy")
        app_state.is_busy = True
        app_state.last_stage_command = {"name": "move_relative", "requested": req.delta}

    logger.info("[STAGE API] move_relative requested: delta=%s", req.delta)
    # 相対移動では `current_angle_hint` を与えることで累積予測チェックを行い、
    # 連続実行によるオーバーランを未然に防ぎます。フロントは HTTP ステータスに基づき
    # 適切なユーザー指示（ホーム、再試行、ログ表示等）を行ってください。
    try:
        stage.move_relative(req.delta, current_angle_hint=app_state.current_angle)
    except ValueError as e:
        with stage_command_lock:
            app_state.is_busy = False
        raise HTTPException(status_code=400, detail=str(e))
    except StageCommandError as e:
        with stage_command_lock:
            app_state.is_busy = False
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        with stage_command_lock:
            app_state.is_busy = False
        raise HTTPException(status_code=500, detail=str(e))
    
    logger.info("[STAGE API] move_relative accepted: delta=%s", req.delta)
    
    return {
        "status": "success",
        "command": "move_relative",
        "requested_delta": req.delta,
        "accepted": True,
    }

@app.post("/stage/stop")
def stage_stop(req: StopStageRequest):
    """
    ステージの移動を直ちに、または減速して停止させます。
    """
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")

    logger.info("[STAGE API] stop requested: immediate=%s", req.immediate)
    app_state.last_stage_command = {"name": "stop", "requested": "immediate" if req.immediate else "decelerate"}
    if app_state.is_measuring:
        with sweep_state_lock:
            if app_state.sweep_operation:
                app_state.sweep_operation["cancel_requested"] = True
                app_state.sweep_operation["message"] = "Sweep cancellation requested"
    # stop は機器保護や緊急停止のための操作であり、失敗時には 409 を返すケースがある。
    # 例: 機器が既に致命的状態にある、または内部チェックにより停止コマンドを拒否した場合。
    try:
        stage.stop(immediate=req.immediate)
    except StageCommandError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    logger.info("[STAGE API] stop accepted: immediate=%s", req.immediate)
    
    return {
        "status": "success",
        "command": "stop",
        "immediate": req.immediate,
        "accepted": True,
    }

@app.post("/stage/config/speed")
def stage_set_speed(req: SetSpeedRequest):
    """
    ステージの駆動速度（初速、最高速度、加減速時間）を設定します。
    """
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")
    
    try:
        ok = stage.set_speed(req.min_pps, req.max_pps, req.accel_time_ms)
        if not ok:
            raise HTTPException(status_code=500, detail="Failed to set speed")
    except StageCommandError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    return { "status": "success" }


@app.post("/stage/sweep/run")
def stage_sweep_run(req: SweepRunRequest):
    """Sweep を開始し、進捗追跡に必要な operation_id と計画を返す。"""
    if not stage.is_connected:
        raise HTTPException(status_code=400, detail="Stage not connected")

    # 安全のためのバリデーション: スイープ時間が極端に短い（0.2秒未満）場合は拒否します。
    # 理由: カメラの録画処理（ファイルのオープン・ヘッダー書き込み等）が完了する前に
    # 停止命令が飛ぶと、TIFFファイルが破損して開けなくなるリスクが高いためです。
    duration = abs(req.end_deg - req.start_deg) / req.speed_deg_s
    if duration < 0.2:
        raise HTTPException(
            status_code=400, 
            detail="Sweep duration too short (min 0.2s). Widen the angle or decrease the speed."
        )

    # このエンドポイントは「実際の移動をここで完了させる」のではなく、
    # 「実行を受付けてバックグラウンドへ渡す」ことが責務です。
    # そのため、ここでは重い処理を行わず、競合状態の確認と計画生成だけを行います。
    with sweep_state_lock:
        current_state = dict(app_state.sweep_operation or {})
        if current_state.get("status") == "running":
            raise HTTPException(status_code=409, detail="Sweep is already running")
        if app_state.is_measuring:
            raise HTTPException(status_code=409, detail="Sweep is already running")

        # operation_id は progress API とログ追跡をつなぐ識別子です。
        # 画面更新や将来のキャンセル処理で「どの Sweep を指しているか」を
        # 明確に区別するため、毎回ユニークな値を発行します。
        operation_id = f"sweep_{uuid4().hex[:12]}"
        plan = _build_sweep_plan(req.start_deg, req.end_deg, req.speed_deg_s)
        request_data = {
            "start_deg": req.start_deg,
            "end_deg": req.end_deg,
            "speed_deg_s": req.speed_deg_s,
            "auto_record": req.auto_record,
        }

        # app_state.is_measuring は「手動移動ではなく自動シーケンスが走っている」ことを示します。
        # これにより、他の手動API（home/move/stop など）を一律でブロックできます。
        app_state.is_measuring = True
        app_state.last_stage_command = {"name": "sweep", "requested": request_data}
        app_state.sweep_operation = {
            "operation_id": operation_id,
            "kind": "sweep",
            "status": "prepare",
            "phase": "prepare",
            "percent": 0,
            "message": "Preparing sweep",
            "plan": plan,
            "request": request_data,
            "started_at_ms": _now_ms(),
            "phase_started_at_ms": _now_ms(),
            "cancel_requested": False,
            "updated_at_ms": _now_ms(),
        }

    logger.info(
        "[STAGE API] sweep requested: start=%s end=%s speed=%s auto_record=%s",
        req.start_deg,
        req.end_deg,
        req.speed_deg_s,
        req.auto_record,
    )

    worker = threading.Thread(
        target=_run_sweep_operation,
        args=(operation_id, request_data, plan),
        daemon=True,
    )
    worker.start()

    # ここでは実行完了を待たず、受付結果と計画だけを返します。
    # UI は operation_id を使って progress API をポーリングし、
    # 進捗バーや状態表示を更新します。
    return {
        "status": "accepted",
        "operation_id": operation_id,
        "plan": plan,
    }


@app.get("/stage/sweep/progress")
def stage_sweep_progress(operation_id: str | None = None):
    """Sweep の進捗状態を返す。operation_id があればそれを優先する。"""
    # progress API は「今どの Sweep を見ればいいか」をUI側から解決できるように、
    # 単純な最新状態返却だけでなく、必要なら operation_id で対象を絞ります。
    state = _get_sweep_state_snapshot()
    # state が存在しない場合（現在どの Sweep も登録されていない）:
    # - クライアントが特定の operation_id を要求しているなら、その操作は存在しないため 404 を返す。
    # - operation_id を指定していない通常の呼び出しなら、idle 状態を返して UI がアイドル表示できるようにする。
    if not state:
        if operation_id is not None:
            raise HTTPException(status_code=404, detail="Sweep operation not found")
        return _compute_sweep_progress({})

    # 登録済みの state がある場合、指定された operation_id と一致するか確認する。
    if operation_id is not None and state.get("operation_id") != operation_id:
        # 別の Sweep を参照しようとした場合は、誤表示を避けるため 404 を返します。
        raise HTTPException(status_code=404, detail="Sweep operation not found")

    return _compute_sweep_progress(state)

@app.post("/measurement/auto/run")
def measurement_auto_run(req: AutoMeasurementRunRequest):
    """Step & Shoot 方式による自動測定シーケンスを開始します。"""
    if not stage.is_connected or not camera.is_connected:
        raise HTTPException(status_code=400, detail="Stage or Camera not connected")

    with auto_operation_lock:
        current_state = dict(app_state.auto_operation or {})
        if current_state.get("status") == "running":
            raise HTTPException(status_code=409, detail="Auto measurement is already running")
        if app_state.is_measuring:
            raise HTTPException(status_code=409, detail="System is busy with another measurement")

        operation_id = f"auto_{uuid4().hex[:12]}"
        
        # 共有ステートを更新
        app_state.is_measuring = True
        app_state.auto_operation = {
            "operation_id": operation_id,
            "status": "starting",
            "percent": 0,
            "message": "Starting auto measurement...",
            "cancel_requested": False
        }

    logger.info(f"[AUTO API] Auto measurement requested: {req.dict()}")

    worker = threading.Thread(
        target=_run_auto_measurement,
        args=(operation_id, req.start_angle, req.end_angle, req.step_angle, req.save_directory, req.is_prescan, req.metadata),
        daemon=True,
    )
    worker.start()

    return {
        "status": "accepted",
        "operation_id": operation_id,
    }

@app.get("/measurement/auto/progress")
def measurement_auto_progress(operation_id: str | None = None):
    """自動測定の進捗状況を返します。"""
    state = _get_auto_operation_snapshot()
    
    if not state:
        if operation_id is not None:
            raise HTTPException(status_code=404, detail="Operation not found")
        return {"status": "idle", "percent": 0, "message": "No active measurement"}

    if operation_id is not None and state.get("operation_id") != operation_id:
        raise HTTPException(status_code=404, detail="Operation not found")

    return state

@app.post("/measurement/auto/cancel")
def measurement_auto_cancel():
    """実行中の自動測定をキャンセルします。"""
    with auto_operation_lock:
        if not app_state.auto_operation or app_state.auto_operation.get("status") != "running":
            return {"status": "ignored", "message": "No running measurement to cancel"}
            
        app_state.auto_operation["cancel_requested"] = True
        app_state.auto_operation["message"] = "Cancellation requested..."
        
        # 物理的にステージが動いている最中にキャンセルされた場合、即座に停止させます。
        if stage.is_connected:
            try:
                # immediate=False（減速停止）で安全に止める
                stage.stop(immediate=False)
            except Exception as e:
                logger.error(f"[AUTO API] Failed to send stop command during cancellation: {e}")
        
    logger.info("[AUTO API] Auto measurement cancellation requested by user")
    
    return {"status": "success", "message": "Cancellation requested"}

@app.get("/stage/position")
def stage_get_position():
    """
    システム（ステージ等）の最新のステータスを取得します。
    フロントエンドから高頻度（例: 200msごと）でポーリングされることを想定しています。
    """
    if not stage.is_connected:
        return {
            "status": "disconnected",
            "current_angle": "--",
            "is_busy": False,
            "is_measuring": False
        }
    
    # 【超重要】シリアル通信を叩かず、常時監視タスクが更新しているキャッシュを即座に返す！
    return {
        "status": "success",
        "current_angle": app_state.current_angle,
        "is_busy": app_state.is_busy,
        "is_measuring": app_state.is_measuring,
    }

@app.get("/stage/diagnostics")
def stage_diagnostics():
    """
    ステージの初期化・接続不具合の切り分けに必要な診断情報を返します。
    """
    try:
        available_ports = [p.device for p in list_ports.comports()]
    except Exception as e:
        available_ports = []
        logger.warning(f"[STAGE DIAG] Failed to enumerate ports: {e}")

    return {
        "status": "success",
        "stage_connected": stage.is_connected,
        "stage_mode": "Mock" if stage.is_mock_env else "Real",
        "has_pyserial": stage.has_pyserial,
        "pyserial_import_error": stage.pyserial_import_error,
        "serial_is_open": bool(stage.ser and stage.ser.is_open),
        "last_error": stage.last_error,
        "last_connected_port": stage.last_connected_port,
        "last_baudrate": stage.last_baudrate,
        "pulses_per_degree": stage.pulses_per_degree,
        "speed_min_pps": stage.speed_min_pps,
        "speed_max_pps": stage.speed_max_pps,
        "speed_accel_ms": stage.speed_accel_ms,
        "cached_current_angle": app_state.current_angle,
        "cached_is_busy": app_state.is_busy,
        "available_ports": available_ports,
        "platform": sys.platform,
        "python_executable": sys.executable,
        "is_frozen": bool(getattr(sys, "frozen", False)),
    }

# ==========================================
# カメラ制御・画像保存関連 API
# ==========================================

@app.post("/camera/connect")
def connect_camera(req: CameraConnectRequest):
    """
    指定されたカメラIDでデバイスを初期化し、メモリを確保して、
    画像を超高速で取得し続けるバックグラウンドスレッド（特急レーン）を起動します。
    """
    logger.info(f"[CMD] Connect Camera ID {req.camera_id}")
    
    success = camera.connect(req.camera_id)
    if not success:
        raise HTTPException(status_code=500, detail="Camera connection failed")
        
    mode = "Mock" if camera.is_mock_env else "Real"
    # 接続直後に、デバイスが実際に報告できるゲイン範囲をできるだけ返します。
    # ここで返す値は UI 側のスライダー初期値・最小値・最大値の決定に使います。
    # 取得できない場合は None のままにして、既存のフォールバック値を壊さないようにします。
    gain_range = None
    try:
        if hasattr(camera, "get_gain_range"):
            gmin, gmax = camera.get_gain_range()
            gain_range = {"min": float(gmin), "max": float(gmax)}
    except Exception as e:
        logger.debug(f"[CAMERA] Failed to read gain range: {e}")

    # フロントエンド側の画面レイアウト（画像フィットサイズ・比率）およびSVGでのROI描画位置の
    # 座標計算が実際のカメラ映像と完全に一致するように、接続されたカメラの物理解像度（width, height）を
    # レスポンスに含めて返却します。これによりフロントエンドは解像度を動的に同期できます。
    resp = {
        "status": "success",
        "mode": mode,
        "message": f"Connected to Camera {req.camera_id} ({mode})",
        "resolution": {"width": camera.width, "height": camera.height}
    }
    if gain_range is not None:
        resp["gain_range"] = gain_range
    # exposure_range も同様に、接続時だけ取得してフロントへ渡します。
    # これは連続ポーリングする値ではなく、機器の能力値としてキャッシュする前提です。
    # 戻り値はミリ秒単位の {min_ms, max_ms, step_ms} を想定します。
    try:
        if hasattr(camera, "get_exposure_range"):
            er = camera.get_exposure_range()
            if er is not None and isinstance(er, (list, tuple)) and len(er) >= 2:
                # get_exposure_range() の戻り値は、(min_ms, max_ms, step_ms) を優先します。
                # ただしデバイスやラッパーの都合で step が取れない場合は、
                # (min_ms, max_ms) の2要素だけでも受け入れます。
                if len(er) >= 3:
                    resp["exposure_range"] = {"min_ms": float(er[0]), "max_ms": float(er[1]), "step_ms": float(er[2])}
                else:
                    resp["exposure_range"] = {"min_ms": float(er[0]), "max_ms": float(er[1])}
    except Exception as e:
        logger.debug(f"[CAMERA] Failed to read exposure range: {e}")
    return resp

@app.post("/camera/disconnect")
def disconnect_camera():
    """
    カメラの接続を安全に切断し、メモリ解放とスレッドの停止を行います。
    """
    camera.disconnect()
    return {"status": "success"}

@app.post("/camera/config")
def config_camera(req: CameraConfigRequest):
    """
    カメラの露出時間（ミリ秒）とハードウェアゲイン倍率（例: 1.0〜13.0）を設定します。
    """
    if not camera.is_connected:
        raise HTTPException(status_code=400, detail="Camera not connected")
        
    camera.set_exposure(req.exposure_ms)
    camera.set_gain(req.gain)
    return {"status": "success"}

@app.post("/camera/rois")
async def set_camera_rois(req: ROISetRequest):
    """解析対象の ROI リストを更新します"""
    try:
        camera.set_rois(req.rois)
        return {"status": "success", "count": len(req.rois)}
    except Exception as e:
        logger.exception("Failed to set ROIs")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/camera/rois")
async def get_camera_rois():
    """
    【現在設定されている解析対象の ROI リストの取得】
    
    【目的・役割】
    フロントエンド（UI画面）とバックエンド（画像処理エンジン）との間で、ROI（関心領域）の設定を同期するためのGETエンドポイントです。
    特に、Pre-Scan（プレスキャン）などの画像解析によって、バックエンド側でROIの重心位置が自動で再計算された後、
    フロントエンドが最新の重心座標をプル（取得）して画面上の枠線位置をアップデートするために使用されます。

    【戻り値の仕様】
    - リスト型 (JSON配列): 各要素は以下のキーを持つ辞書（オブジェクト）です。
        - "index": ROIの識別番号（1から始まる整数値）。
        - "x", "y": 画像全体の絶対ピクセル座標における、ROIの中心位置（浮動小数点数）。
        - "size": ROIの一辺の長さ（整数値、奇数ピクセル）。
        - "optical_centroid_x", "optical_centroid_y" (任意): サブピクセル精度の重心計算値。

    【エラーハンドリング】
    - エラー発生時はエラーログを出力し、HTTP 500 (Internal Server Error) をクライアントに返します。
    """
    try:
        # camera.rois には [ {"index": 1, "x": 500.0, "y": 300.0, "size": 33}, ... ] という形式でリストが保持されています。
        # FastAPI は Python の辞書リストを自動で JSON 配列形式にシリアライズしてクライアントに返送します。
        return camera.rois
    except Exception as e:
        logger.exception("[CAMERA API] Failed to retrieve ROI configurations from camera controller")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/camera/roi_stats")
async def get_camera_roi_stats():
    """最新の ROI 解析統計（Sum, Max, Centroid）を取得します"""
    try:
        stats = camera.get_latest_roi_stats()
        return stats
    except Exception as e:
        logger.exception("Failed to get ROI stats")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/system/cameras")
def get_cameras():
    """
    PCに接続されている対応カメラ（Thorlabs/uEye）の一覧を取得します。
    """
    cameras_list = camera.get_available_cameras()
    logger.info(
        "[CAMERA API] mode=%s count=%d",
        "Mock" if camera.is_mock_env else "Real",
        len(cameras_list),
    )
    return {"cameras": cameras_list}

@app.get("/camera/diagnostics")
def camera_diagnostics():
    """
    カメラ初期化の切り分けに必要な診断情報を返します。
    研究室PCでの原因調査をAPI経由で完結させるためのエンドポイントです。
    """
    windows_dll_candidates = []
    if sys.platform.startswith("win"):
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        system_root = os.environ.get("SystemRoot", r"C:\Windows")
        candidate_paths = [
            os.path.join(program_files, "IDS", "uEye", "Bin", "ueye_api_64.dll"),
            os.path.join(system_root, "System32", "ueye_api_64.dll"),
            os.path.join(system_root, "SysWOW64", "ueye_api.dll"),
        ]
        windows_dll_candidates = [
            {"path": p, "exists": os.path.exists(p)} for p in candidate_paths
        ]

    return {
        "status": "success",
        "camera_connected": camera.is_connected,
        "camera_mode": "Mock" if camera.is_mock_env else "Real",
        "has_uc480": camera.has_uc480,
        "uc480_import_error": camera.uc480_import_error,
        "python_executable": sys.executable,
        "is_frozen": bool(getattr(sys, "frozen", False)),
        "platform": sys.platform,
        "windows_dll_candidates": windows_dll_candidates,
    }

@app.get("/camera/video_feed")
def video_feed():
    """
    【各駅停車レーン】カメラのプレビュー映像をブラウザ向けにMJPEG形式でストリーミング配信します。
    
    FastAPIの StreamingResponse を使用し、HTTPの `multipart/x-mixed-replace` ヘッダーを
    設定することで、1つの接続を開いたまま次々と新しいJPEG画像をクライアントに送信（Push）し続けます。
    これにより、Webブラウザの `<img>` タグのsrcにこのURLを指定するだけで、動画として表示されます。
    """
    if not camera.is_connected:
        raise HTTPException(status_code=503, detail="Camera not connected")
    
    return StreamingResponse(
        camera.generate_frames(), 
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@app.post("/camera/snapshot")
def take_snapshot():
    """
    【Snapshot撮影トリガー】
    撮影ボタンが押された瞬間のフレームを取得します。
    設定により、自動保存されたファイルパスを返すか、
    ダイアログでのパス指定を待つために `{"status": "pending"}` を返します。
    """
    if not camera.is_connected:
        raise HTTPException(status_code=503, detail="Camera not connected")

    # Snapshot 実行時点の設定をまとめて残す。
    # ここでのログは「保存先がどこだったか」「自動保存か手動保存か」を
    # 後から追えるようにするための入口ログです。
    logger.info(
        "[CAMERA API] snapshot requested: askSavePath=%s outputDirectory=%s imageFormat=%s",
        camera.settings.get("askSavePath", False),
        camera.settings.get("outputDirectory", "<unset>"),
        camera.settings.get("imageFormat", "TIFF"),
    )
    result = camera.take_snapshot()
    if result == "PENDING":
        return {"status": "pending", "message": "Waiting for save path"}
    elif result is not None:
        return {"status": "saved", "filepath": result}
    else:
        # camera.take_snapshot() 側で例外内容を詳細ログに残しているが、
        # API 境界でも失敗した設定値を補助的に記録しておく。
        logger.error(
            "[CAMERA API] snapshot failed: outputDirectory=%s imageFormat=%s",
            camera.settings.get("outputDirectory", "<unset>"),
            camera.settings.get("imageFormat", "TIFF"),
        )
        raise HTTPException(status_code=500, detail="Failed to take snapshot")

@app.post("/camera/snapshot/save")
def save_pending_snapshot(req: SaveSnapshotRequest):
    """
    フロントエンドの保存ダイアログでユーザーが指定したパスを受け取り、
    メモリ上に一時保持（PENDING）していたSnapshot画像を実際にディスクに書き込みます。
    """
    # ダイアログで選ばれたパスをそのまま残し、Windows 側のアクセス権問題を
    # そのファイルパス単位で追跡できるようにする。
    logger.info("[CAMERA API] save snapshot requested: filepath=%s", req.filepath)
    success = camera.save_pending_snapshot(req.filepath)
    if success:
        return {"status": "saved", "filepath": req.filepath}
    # 保存失敗時はフロントに一般化したエラーを返すが、
    # ログには具体的なパスを残して、権限/存在/パス不正の切り分けに使う。
    logger.error("[CAMERA API] save snapshot failed: filepath=%s", req.filepath)
    raise HTTPException(status_code=500, detail="Failed to save snapshot")

@app.post("/camera/record/start")
def start_recording():
    """
    【動画記録開始】
    マルチページTIFFへの超高速直書き（SSDへの追記）を開始します。
    設定が「8-bit TIFF」の場合は、開始と同時にハードウェアモードを切り替えます。
    """
    if not camera.is_connected:
        raise HTTPException(status_code=503, detail="Camera not connected")

    # 録画開始時も、どの保存先・接頭辞・形式設定で動かしたかを残す。
    # 後から Permission denied が出た際に、録画生成先がどこだったかを確認するためです。
    logger.info(
        "[CAMERA API] record start requested: outputDirectory=%s recordPrefix=%s keepRawTiff=%s",
        camera.settings.get("outputDirectory", "<unset>"),
        camera.settings.get("recordPrefix", "record_"),
        camera.settings.get("keepRawTiff", True),
    )
    success = camera.start_recording()
    if success:
        return {"status": "recording", "filepath": camera.record_filepath}
    # start_recording() 側で詳細ログを出しているが、API でも失敗時の設定値を残す。
    logger.error(
        "[CAMERA API] record start failed: outputDirectory=%s recordPrefix=%s",
        camera.settings.get("outputDirectory", "<unset>"),
        camera.settings.get("recordPrefix", "record_"),
    )
    raise HTTPException(status_code=500, detail="Failed to start recording")

@app.post("/camera/record/stop")
def stop_recording():
    """
    【動画記録停止】
    TIFFファイルの書き込みを終了し、必要に応じてMP4変換処理（貨物レーン）を非同期で開始します。
    """
    filepath = camera.stop_recording()
    if filepath is not None:
        return {"status": "stopped", "filepath": filepath}
    raise HTTPException(status_code=400, detail="Not currently recording")

# ==========================================
# ログ関連 API
# ==========================================

@app.get("/system/logs")
def get_logs():
    """
    バックエンド内部のメモリバッファ（collections.deque）に蓄積された
    直近のログメッセージリストを返します。フロントエンドのログパネル表示用です。
    """
    return {"logs": list(log_buffer)}

@app.post("/system/logs")
def post_log(req: LogPostRequest):
    """
    フロントエンド側（React）で発生したエラーや操作イベントをバックエンドに送信し、
    Python側の `logger` に統合してファイル（nanopol.log）に書き出します。
    """
    msg = f"[UI] {req.message}"
    
    if req.level.upper() == "ERROR":
        logger.error(msg)
    elif req.level.upper() == "WARNING":
        logger.warning(msg)
    else:
        logger.info(msg)
    
    return {"status": "success"}

# ==========================================
# 自動測定（Auto Mode）セッション管理 API
# ==========================================
# これらの API は、自動測定の「進行状況」と「保存フォルダ」を管理する中核機能です。
# 詳細な設計思想については docs/08_auto_measurement.md を参照してください。

@app.get("/measurement/sessions")
def get_measurement_sessions(date_dir: str | None = None):
    """
    今日の日付フォルダ内にある既存の測定セッション（サンプル）一覧を取得します。
    
    【用途】
    フロントエンドの Auto Mode 起動直後（State 0）にて、
    「今日すでに行った測定の続きから始める」ためのリストを表示するために使用します。

    【動作詳細】
    1. camera.settings["outputDirectory"] から保存先のルートを取得します。
    2. その配下の AutoMeasurementData/<指定または今日の日付>/ をスキャンします。
    3. settings.json が存在する有効なフォルダのみを抽出し、名前順で返します。

    戻り値:
        dict: {
            "sessions": 有効なサンプル名のリスト,
            "base_dir": 自動測定データの保存起点,
            "today_dir": 今日の日付フォルダのフルパス,
            "selected_dir": 現在リストアップ対象となっている日付フォルダのフルパス
        }
    """
    # 保存先ディレクトリは設定画面で指定された値（camera.settings内）を使用します。
    # camera.settings は /system/settings 経由で config.json の内容が同期されています。
    output_dir = camera.settings.get("outputDirectory")
    
    if not output_dir or output_dir.strip() == "":
        # 保存先が未設定の場合は、エラーではなく空のリストを返し、
        # フロントエンド側で適切に（「保存先を設定してください」等）表示できるようにします。
        return {"sessions": [], "base_dir": "", "today_dir": "", "selected_dir": ""}
    
    try:
        # data_saver を使って、指定された日付（または今日）のセッションを探します。
        sessions = data_saver.get_sessions(output_dir, date_dir)
        base_dir = data_saver.get_base_dir(output_dir)
        today_dir = data_saver.get_today_dir(base_dir)
        selected_dir = data_saver.get_date_dir(base_dir, date_dir)
        
        return {
            "sessions": sessions,
            "base_dir": base_dir,
            "today_dir": today_dir,
            "selected_dir": selected_dir
        }
    except Exception as e:
        logger.error(f"[AUTO] Failed to get sessions from {output_dir} (date={date_dir}): {e}")
        raise HTTPException(status_code=500, detail=f"Failed to scan sessions: {str(e)}")

@app.post("/measurement/session")
def create_measurement_session(req: MeasurementSessionCreateRequest):
    """
    新しい測定セッション（サンプルフォルダと初期 settings.json）を物理的に作成します。

    【用途】
    新しいサンプルに対して測定を開始する際（State 0 -> A への遷移）に呼び出されます。

    【動作詳細】
    1. 名前が空の場合は "Sample_1", "Sample_2" と自動で採番します。
    2. 名前が重複している場合は "SampleName_2" のように枝番を付けて衝突を回避します。
    3. 物理的なフォルダを作成し、中に空の履歴を持つ settings.json を生成します。

    引数:
        req (MeasurementSessionCreateRequest): 
            - sample_name: ユーザーが入力した希望のサンプル名（空でも可）

    戻り値:
        dict: {
            "status": "success",
            "sample_name": 最終的に決まったサンプル名,
            "folder_path": 作成されたフォルダのフルパス
        }
    """
    output_dir = camera.settings.get("outputDirectory")
    if not output_dir or output_dir.strip() == "":
        # 書き込み先が不明な状態でフォルダを作ることは、データ紛失のリスクがあるため
        # HTTP 400 (Bad Request) で厳格に拒否します。
        raise HTTPException(status_code=400, detail="Output directory is not configured. Please set it in Settings.")
    
    try:
        # 新しいフォルダと settings.json を作成し、確定した名前とパスを返します。
        result = data_saver.create_new_session(output_dir, req.sample_name)
        logger.info(f"[AUTO] Created new session: {result['sample_name']} at {result['folder_path']}")
        
        return {
            "status": "success",
            "sample_name": result["sample_name"],
            "folder_path": result["folder_path"]
        }
    except Exception as e:
        logger.error(f"[AUTO] Failed to create session: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create session directory: {str(e)}")

@app.get("/measurement/session/settings")
def get_session_settings(folder_path: str):
    """
    指定されたフォルダパスにある settings.json を読み込み、現在の測定進捗を返します。

    【用途】
    既存のセッションをロードした際（State 0 -> A）に、
    「どの項目が測定済みか」「過去のROIはどこか」を復元するために使用します。

    引数:
        folder_path (str): 読み込みたいサンプルフォルダの絶対パス

    戻り値:
        dict: settings.json の中身（app_version, sample_name, measurements 等）

    例外:
        - HTTP 404: 指定されたフォルダに settings.json が存在しない場合.
        - HTTP 500: ファイルが壊れていて JSON としてパースできない場合.
    """
    if not folder_path:
        raise HTTPException(status_code=400, detail="folder_path is required")

    try:
        # 指定されたパスにある settings.json を辞書形式で読み込みます。
        settings = data_saver.read_session_settings(folder_path)
        return settings
    except FileNotFoundError as e:
        # ファイルがない場合は 404 Not Found。UI 側で「データが見つかりません」と表示できます。
        raise HTTPException(status_code=404, detail=str(e))
    except json.JSONDecodeError as e:
        # ファイルはあるが JSON 形式として不正な場合は 500 Error。
        logger.error(f"[AUTO] Broken settings.json in {folder_path}: {e}")
        raise HTTPException(status_code=500, detail="settings.json is corrupted")
    except Exception as e:
        logger.error(f"[AUTO] Failed to read session settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class MeasurementBranchGenerateRequest(BaseModel):
    session_path: str
    category: str

@app.post("/measurement/branch/generate")
def generate_measurement_branch(req: MeasurementBranchGenerateRequest):
    """
    指定されたセッション内で、新しい測定カテゴリ（枝番付き）のフォルダを生成します。
    """
    if not req.session_path or not req.category:
        raise HTTPException(status_code=400, detail="session_path and category are required")
        
    try:
        measurement_id, folder_path = data_saver.generate_measurement_branch(req.session_path, req.category)
        logger.info(f"[AUTO] Generated branch: {measurement_id} at {folder_path}")
        return {
            "measurement_id": measurement_id,
            "folder_path": folder_path
        }
    except Exception as e:
        logger.error(f"[AUTO] Failed to generate branch: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/measurement/plot_data")
def get_measurement_plot_data(roi_index: Optional[int] = None):
    """
    自動測定中のグラフ表示用データ（角度ごとの輝度）を返します。
    フロントエンドのグラフコンポーネントが定期的に（例: 500msごと）呼び出すことを想定しています。
    """
    try:
        return app_state.auto_measurement.get_plot_data(roi_index)
    except Exception as e:
        logger.exception("Failed to get plot data")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/measurement/reset")
def reset_measurement_data():
    """
    バックエンドのメモリ上に蓄積された測定データをリセットします。
    新しいカテゴリの測定（Pre-Scan から Main への切り替え時など）に呼び出されます。
    """
    try:
        app_state.auto_measurement.reset()
        return {"status": "success"}
    except Exception as e:
        logger.exception("Failed to reset measurement data")
        raise HTTPException(status_code=500, detail=str(e))

def write_backend_port_hint(app_data_dir: str | None, port: int) -> None:
    """
    Tauri連携用のポートヒントファイル (`backend_port.json`) をAppDataに保存します。

    Rustのログ受信が遅延/取りこぼしした場合でも、フロントエンドが
    AppData経由でポート番号を取得して復旧できるようにする保険経路です。
    JSONにすることで、ポート番号だけでなく更新時刻やPIDも持たせられます。

    Args:
        app_data_dir: `NANOPOL_APP_DATA_DIR` の値。None/空なら何もしません。
        port: 動的割り当てされたバックエンドの待受ポート。

    Returns:
        None
    """
    # 起動元がTauriでない場合はAppDataの保存先がないため何もしない
    if not app_data_dir:
        return

    # AppData配下にヒントファイルを作成（上書き）して最新ポートを共有する
    os.makedirs(app_data_dir, exist_ok=True)

    # 一時ファイルへ完全なJSONを書き、最後に置き換えることで途中書き込みを避ける
    hint_path = Path(app_data_dir) / "backend_port.json"
    tmp_path = hint_path.with_suffix(".json.tmp")

    hint_payload = {
        "port": port,
        "pid": os.getpid(),
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }

    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(hint_payload, f, ensure_ascii=False)

    os.replace(tmp_path, hint_path)
    logger.info(f"[SYSTEM] Wrote backend port hint to {hint_path}")

if __name__ == "__main__":
    # ------------------------------------------------------------------
    # 開発用オプション（--reload）についての説明
    # ------------------------------------------------------------------
    # このスクリプトは2つの起動モードを想定しています。
    # 1) Tauri (アプリバンドル) 経由で起動される本番相当モード
    # 2) ローカル開発者が直接 python main.py で起動する開発モード
    #
    # 開発時はファイル変更を検知して自動でサーバーを再起動する
    # `uvicorn --reload` 相当の振る舞いが便利なので、`--reload` フラグを用意しています。
    #
    # 実際に `--reload` を付けた場合は、Uvicorn にモジュール参照文字列
    # ("main:app") を渡して再読み込み対象のモジュール解決を行わせます。
    # これは Uvicorn の reload 機構がモジュール名ベースで監視を行うためです。
    #
    # 注意事項:
    # - 本番運用や Tauri 経由の起動では `--reload` を使わないでください。
    # - reload モードはファイル監視のために追加プロセスを起動するため、開発以外
    #   の用途では予期しない副作用が出る可能性があります。
    # ------------------------------------------------------------------

    import argparse
    import uvicorn
    import socket
    import os

    parser = argparse.ArgumentParser(description="NanoPol backend runner")
    parser.add_argument(
        "--reload",
        action="store_true",
        help=(
            "Enable Uvicorn reload mode (development only). "
            "When set, the server restarts on code changes."
        ),
    )
    args = parser.parse_args()

    # Tauri(Rust)経由で起動されたかどうかの判定（環境変数の有無）
    # Tauri 起動時は Rust 側がポートを監視するため、空きポートを先に確保して
    # 親プロセスに通知する必要があります。このフローは production 相当です。
    is_tauri = os.getenv("NANOPOL_APP_DATA_DIR") is not None

    if is_tauri:
        # ------------------------------------------------------------------
        # Tauri(Rust)側から特定のポートが指定されている（NANOPOL_BACKEND_PORT）場合は
        # それを優先して使用します（再起動時に同じポートを維持するため）。
        # 指定がない場合は、OSに空きポートを動的に確保させます。
        # ------------------------------------------------------------------
        env_port = os.getenv("NANOPOL_BACKEND_PORT")
        if env_port and env_port.strip().isdigit():
            port = int(env_port.strip())
        else:
            # 1) OSに空きポートを確保させ、そのポート番号を Tauri(Rust) 側に通知する
            #    -> Rust 側がこのポートへ接続してバックエンドを利用できるようにする
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0))  # port=0 で OS に任せる
            port = sock.getsockname()[1]
            sock.close()

        # 2) Tauri に渡すための標準出力/標準エラーへポート番号を出力
        #    flush=True により出力の遅延を避ける
        print(f"[PORT] {port}", flush=True)
        import sys
        # 出力先差異に備えてstderrにも同じ通知を流す
        print(f"[PORT] {port}", file=sys.stderr, flush=True)

        # 3) (任意) AppData にポートヒントを書き込み、他コンポーネントの保険とする
        try:
            app_data_dir = os.getenv("NANOPOL_APP_DATA_DIR")
            # React側の保険経路が読めるよう、ポートヒントを永続化
            write_backend_port_hint(app_data_dir, port)
        except Exception as e:
            # ヒント書き込みに失敗しても起動自体は継続させる
            logger.warning(f"[SYSTEM] Failed to write backend port hint: {e}")
    else:
        # 開発モード: 固定ポートを使うことでフロントエンドから直接アクセスしやすくする
        port = 14201

    # ------------------------------------------------------------------
    # Uvicorn を起動する際の挙動
    # - 開発時に --reload を指定した場合、`uvicorn.run("main:app", ..., reload=True)`
    #   のようにモジュール名で指定します。これにより、Uvicorn はソースファイルの
    #   変更を検知してプロセスを再起動します。
    # - reload_dirs に現在のディレクトリを渡すことで、監視対象フォルダを限定します。
    # - 本番（Tauri）起動時は `app` オブジェクトを直接渡して起動します。
    # ------------------------------------------------------------------
    if args.reload:
        # reload=True を有効にするため、文字列で参照（モジュール:attribute）を渡す
        uvicorn.run(
            "main:app",
            host="127.0.0.1",
            port=port,
            reload=True,
            reload_dirs=[os.path.dirname(__file__)],
        )
    else:
        uvicorn.run(app, host="127.0.0.1", port=port)