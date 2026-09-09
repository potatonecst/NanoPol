import os
import csv
import cv2
import numpy as np
import tifffile
from typing import Callable, Optional, Dict, Any
from utils.logger import logger

# ============================================================================
# 動画変換ユーティリティ (Video Converter Module)
# 
# 録画された RAW マルチページ TIFF と タイムスタンプ CSV から、
# プレビュー・共有用の MP4 動画を生成するモジュールです。
# 
# 【主要機能】
# 1. ドロップフレーム補完 (Drop-frame Interpolation):
#    コマ落ち（遅延）が発生した区間に直前フレームを水増し挿入し、
#    動画の再生時間と現実の測定時間を 100% 一致させます。
# 2. ストリーミング処理 (省メモリ設計):
#    巨大な TIFF ファイルでも RAM を圧迫しないよう、1ページずつ順次処理します。
# 3. 階調安定化 (フリッカー防止):
#    16-bit 画像はカメラの最大階調に基づく固定スケールで 8-bit に変換し、
#    フレームごとの明滅（チラつき）を防ぎます。
# 4. フェイルセーフ設計:
#    変換成功時のみ keepRawTiff 設定に応じて元 TIFF を削除し、
#    エラー時は元データを 100% 保護します。
# ============================================================================

# 基準となるターゲットフレームレート（30.0 FPS: 1フレーム約 33.33ms）
TARGET_FPS = 30.0
FRAME_INTERVAL_MS = 1000.0 / TARGET_FPS

# コマ落ち水増し挿入の安全上限（長時間の停止等で巨大化するのを防ぐため最大10秒=300フレーム）
MAX_INTERPOLATION_FRAMES = 300

def get_bayer_conversion_code(bayer_pattern: Optional[str]) -> Optional[int]:
    """
    Bayerパターンの文字列（例: 'RG', 'BG'）から OpenCV の色変換コードを取得します。
    """
    if not bayer_pattern:
        return None
    mapping = {
        'RG': cv2.COLOR_BayerRG2BGR,
        'BG': cv2.COLOR_BayerBG2BGR,
        'GR': cv2.COLOR_BayerGR2BGR,
        'GB': cv2.COLOR_BayerGB2BGR,
    }
    return mapping.get(bayer_pattern, cv2.COLOR_BayerRG2BGR)

def convert_frame_to_8bit_bgr(
    raw_frame: np.ndarray, 
    is_color: bool, 
    bayer_pattern: Optional[str]
) -> np.ndarray:
    """
    RAW 画像（uint8 または uint16、モノクロまたは Bayer）を表示・動画用の 8-bit BGR 画像に変換します。

    【技術的解説】
    1. 16-bit (uint16) の場合:
       単純な cv2.normalize ではフレームごとの最大最小値でスケーリングが変わりフリッカーが発生するため、
       最大値 65535（または上位8ビットシフト）に基づく固定スケーリングを行います。
    2. カラーの場合:
       Bayer パターンを OpenCV の cvtColor で 3 チャンネル BGR にデモザイクします。
    3. モノクロの場合:
       VideoWriter は 3 チャンネル BGR を期待するため、グレースケールを 3 チャンネルに複製します。
    """
    # 1. 16-bit -> 8-bit 固定スケール変換
    if raw_frame.dtype == np.uint16:
        # 上位 8-bit を抽出（フリッカーのない安定した階調変換）
        frame_8u = (raw_frame >> 8).astype(np.uint8)
    else:
        frame_8u = raw_frame.astype(np.uint8)

    # 2. カラーデモザイク or モノクロ3ch化
    bayer_code = get_bayer_conversion_code(bayer_pattern) if is_color else None
    if bayer_code is not None and len(frame_8u.shape) == 2:
        bgr_frame = cv2.cvtColor(frame_8u, bayer_code)
    elif len(frame_8u.shape) == 2:
        # モノクロ 1ch -> BGR 3ch
        bgr_frame = cv2.cvtColor(frame_8u, cv2.COLOR_GRAY2BGR)
    elif len(frame_8u.shape) == 3 and frame_8u.shape[2] == 3:
        bgr_frame = frame_8u
    else:
        # 想定外の形状に対するフォールバック
        bgr_frame = cv2.cvtColor(frame_8u[:, :, 0], cv2.COLOR_GRAY2BGR)

    return bgr_frame

def read_timestamps_from_csv(csv_path: str) -> list[float]:
    """
    同名の CSV ファイルから各フレームの撮影時刻（Frame_Timestamp_ms）のリストを読み込みます。
    CSVが存在しない、またはパースエラーの場合は空リストを返します。
    """
    if not os.path.exists(csv_path):
        return []

    timestamps = []
    try:
        with open(csv_path, mode='r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                ts_str = row.get("Frame_Timestamp_ms")
                if ts_str:
                    try:
                        timestamps.append(float(ts_str))
                    except ValueError:
                        pass
    except Exception as e:
        logger.warning(f"[VideoConverter] Failed to read CSV timestamps ({csv_path}): {e}")
        return []

    return timestamps

def convert_tiff_to_mp4_with_interpolation(
    tiff_path: str,
    csv_path: Optional[str] = None,
    output_mp4_path: Optional[str] = None,
    is_color: bool = False,
    bayer_pattern: Optional[str] = None,
    keep_raw: bool = True,
    progress_callback: Optional[Callable[[int, int, int, str], None]] = None
) -> str:
    """
    マルチページ TIFF と CSV からドロップフレーム補完を適用した MP4 動画を生成します。

    引数:
        tiff_path: 入力マルチページ TIFF ファイルパス
        csv_path: タイムスタンプ CSV パス（None の場合は tiff と同名の .csv を自動探索）
        output_mp4_path: 出力 MP4 ファイルパス（None の場合は tiff と同名の .mp4）
        is_color: カラーモードかどうか
        bayer_pattern: Bayer パターン文字列 ('RG', 'BG' 等)
        keep_raw: 変換成功時に元 TIFF を保持するか（False なら削除）
        progress_callback: 進捗コールバック (percent: int, current_frame: int, total_frames: int, message: str)

    戻り値:
        str: 生成された MP4 ファイルの絶対パス
    """
    if not os.path.exists(tiff_path):
        raise FileNotFoundError(f"Input TIFF file not found: {tiff_path}")

    # 出力パスと CSV パスの解決
    base_no_ext = os.path.splitext(tiff_path)[0]
    if output_mp4_path is None:
        output_mp4_path = f"{base_no_ext}.mp4"
    if csv_path is None:
        candidate_csv = f"{base_no_ext}.csv"
        csv_path = candidate_csv if os.path.exists(candidate_csv) else None

    logger.info(f"[VideoConverter] Starting conversion: {tiff_path} -> {output_mp4_path}")
    if progress_callback:
        progress_callback(0, 0, 0, "Preparing conversion & analyzing metadata...")

    # CSV からタイムスタンプを読み込む
    timestamps = read_timestamps_from_csv(csv_path) if csv_path else []
    has_valid_timestamps = len(timestamps) > 1

    video_writer: Optional[cv2.VideoWriter] = None
    converted_successfully = False

    try:
        with tifffile.TiffFile(tiff_path) as tif:
            total_source_frames = len(tif.pages)
            if total_source_frames == 0:
                raise ValueError(f"TIFF file contains no pages: {tiff_path}")

            logger.info(f"[VideoConverter] Total source frames: {total_source_frames}, Timestamps: {len(timestamps)}")
            if progress_callback:
                progress_callback(5, 0, total_source_frames, f"Opening TIFF ({total_source_frames} frames)...")

            prev_timestamp: Optional[float] = None

            for i, page in enumerate(tif.pages):
                # 1. 1フレーム分を読み込み
                raw_frame = page.asarray()
                bgr_frame = convert_frame_to_8bit_bgr(raw_frame, is_color, bayer_pattern)
                h, w = bgr_frame.shape[:2]

                # 2. 初回フレームで VideoWriter を初期化
                if video_writer is None:
                    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
                    video_writer = cv2.VideoWriter(output_mp4_path, fourcc, TARGET_FPS, (w, h))
                    if not video_writer.isOpened():
                        raise RuntimeError(f"Failed to open OpenCV VideoWriter for: {output_mp4_path}")

                # 3. ドロップフレーム補完（埋め草水増し）の計算
                repeat_count = 1
                if has_valid_timestamps and i < len(timestamps):
                    curr_timestamp = timestamps[i]
                    if prev_timestamp is not None:
                        delta_ms = curr_timestamp - prev_timestamp
                        if delta_ms > FRAME_INTERVAL_MS * 1.5:
                            # 1.5フレーム分以上の空白時間がある場合、欠落フレーム数を算出
                            extra_frames = int(round(delta_ms / FRAME_INTERVAL_MS)) - 1
                            # 安全リミット（最大10秒分）を適用
                            extra_frames = min(extra_frames, MAX_INTERPOLATION_FRAMES)
                            if extra_frames > 0:
                                repeat_count = 1 + extra_frames
                                logger.debug(
                                    f"[VideoConverter] Dropped frame detected at index {i} "
                                    f"(delta={delta_ms:.1f}ms): repeating {extra_frames} frames."
                                )
                    prev_timestamp = curr_timestamp
                elif prev_timestamp is None and timestamps:
                    prev_timestamp = timestamps[0]

                # 4. MP4 にフレームを書き出し（水増し分を含む）
                for _ in range(repeat_count):
                    video_writer.write(bgr_frame)

                # 5. 進捗コールバック（5% 〜 95% の範囲でスムーズに進める）
                if progress_callback:
                    # 5% + (i / total * 90%)
                    percent = int(5 + ((i + 1) / total_source_frames) * 90)
                    msg = f"Processing frame {i + 1} / {total_source_frames} ({percent}%)..."
                    progress_callback(percent, i + 1, total_source_frames, msg)

        # 6. ファイナライズ（ファイルクローズ・確定）
        if progress_callback:
            progress_callback(95, total_source_frames, total_source_frames, "Finalizing MP4 video...")

        if video_writer is not None:
            video_writer.release()
            video_writer = None

        converted_successfully = True
        logger.info(f"[VideoConverter] Successfully generated MP4: {output_mp4_path}")

        # 7. keepRawTiff 設定に基づく元 TIFF の削除
        if not keep_raw:
            try:
                os.remove(tiff_path)
                logger.info(f"[VideoConverter] Removed raw TIFF (keepRawTiff=False): {tiff_path}")
            except Exception as e:
                logger.warning(f"[VideoConverter] Failed to remove raw TIFF: {e}")

        if progress_callback:
            progress_callback(100, total_source_frames, total_source_frames, "Video Conversion Completed!")

        return output_mp4_path

    except Exception as e:
        logger.exception(f"[VideoConverter] Error converting TIFF to MP4: {e}")
        # 不完全な MP4 ファイルが残っていれば削除してクリーンアップ
        if video_writer is not None:
            video_writer.release()
        if os.path.exists(output_mp4_path) and not converted_successfully:
            try:
                os.remove(output_mp4_path)
            except Exception:
                pass
        raise e
