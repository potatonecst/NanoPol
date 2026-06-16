import numpy as np
from typing import List, Dict, Any, Optional
from utils.logger import logger

class ROIProcessor:
    """
    画像データ（Numpy配列）から特定の領域（ROI）の統計情報を抽出するためのプロセッサ。
    
    【設計思想】
    1. 高速性: Numpy のスライスとベクトル演算を利用し、リアルタイム処理（30fps以上）に耐える速度を確保。
    2. 堅牢性: 画像の境界外を指定された場合でも、安全にクリップ（制限）して計算を継続。
    3. 生データ重視: データのビット深度（uint8/uint16）に関わらず、生のピクセル値をそのまま計算に使用。
    """

    @staticmethod
    def calculate_stats(image: np.ndarray, rois: List[Dict[str, Any]], include_centroid: bool = False) -> Dict[str, Any]:
        """
        指定された複数のROI（関心領域）に対して、輝度の統計情報（合計、最大値、重心）を一括で計算します。

        【技術的背景】
        画像データは Numpy 配列 (Height, Width) として渡されます。16bitカメラの場合、各ピクセルは 0〜65535 の値を持ちます。
        この関数は、物理的な測定精度を担保するため、画像全体を走査するのではなく、
        指定された領域のみを「スライス（切り出し）」して計算を行うことで、メモリ効率と実行速度を両立しています。

        Args:
            image (np.ndarray): 入力画像データ。2次元（モノクロ）または3次元（カラー）の Numpy 配列。
            rois (List[Dict]): 解析したい領域のリスト。
                各辞書のキー:
                - "index": ROIを識別する番号。
                - "x", "y": 領域の中心座標（浮動小数点数、ピクセル単位）。
                - "size": 領域の一辺の長さ（ピクセル単位）。
            include_centroid (bool): 重心（輝度の中心）計算を行うかどうか。
                デフォルトは False。測定中に不要な座標計算（np.indices 等）をスキップして高速化するためです。

        Returns:
            Dict[str, Any]: 各ROIのインデックスを文字列キーとした解析結果の辞書。
                各ROIの結果に含まれる項目:
                - "sum": 領域内のピクセル輝度の総和。光の強さに相当。
                - "max": 領域内の最高輝度。飽和（サチュレーション）の確認に使用。
                - "center_val": 領域の中心ピクセル（定点）における輝度値。
                - "cx", "cy": 輝度で重み付けされた重心座標（絶対座標）。
        """
        # 画像が空、または解析対象がない場合は即座に空の辞書を返して終了
        if image is None or len(rois) == 0:
            return {}

        # 画像の縦横サイズを取得。境界チェック（はみ出し防止）に使用します。
        height, width = image.shape[:2]
        results = {}

        for roi in rois:
            try:
                roi_idx = roi.get("index", 0)
                center_x = roi.get("x", 0.0)
                center_y = roi.get("y", 0.0)
                size = roi.get("size", 5)
                
                # 半径の計算。size が 5 なら half は 2 となり、中心から前後 2 ピクセルずつを対象にします。
                half = size // 2
                
                # --- 切り出し範囲の決定（スライス範囲） ---
                # round() で四捨五入し、int() で整数に変換することで、サブピクセル指定を実ピクセル座標に変換。
                # max(0, ...) および min(width, ...) を使うことで、ROIが画像の外にはみ出した場合に
                # プログラムがエラー（IndexError）で止まるのを防ぎ、有効な範囲内だけで計算します。
                x1 = max(0, int(round(center_x - half)))
                y1 = max(0, int(round(center_y - half)))
                x2 = min(width, x1 + size)
                y2 = min(height, y1 + size)
                
                # Numpy のスライス機能を用いて、画像の一部（パッチ）を高速に抽出します。
                # image[y方向の範囲, x方向の範囲] の順であることに注意。
                patch = image[y1:y2, x1:x2]
                
                # 指定領域が完全に画像外だった場合などは、パッチサイズが 0 になります。
                if patch.size == 0:
                    results[str(roi_idx)] = {"sum": 0.0, "max": 0.0, "cx": center_x, "cy": center_y}
                    continue

                # --- 輝度統計の計算 ---
                # np.sum: パッチ内の全ピクセル値を合計。粒子の総散乱強度を反映します。
                # np.max: パッチ内の最大値。ピクセルが 65535 等で飽和していないかの判定に重要。
                # float() にキャストしているのは、Numpy独自の型を標準の Python 型に変換し、
                # 後続の JSON 通信でシリアライズエラーが起きないようにするためです。
                roi_sum = float(np.sum(patch))
                roi_max = float(np.max(patch))
                
                # --- 中心ピクセル輝度の取得 ---
                # ROI の幾何学的中心（ユーザーが指定した固定位置）に位置する 1 ピクセルの生の値を取得します。
                # 重心（動く点）ではなく、固定された定点における輝度を観測することで、
                # アライメントの安定性や局所的な信号強度を評価する指標となります。
                cx_int = int(round(center_x))
                cy_int = int(round(center_y))
                if 0 <= cx_int < width and 0 <= cy_int < height:
                    roi_center_val = float(image[cy_int, cx_int])
                else:
                    roi_center_val = 0.0
                
                # --- 重心（Centroid）の計算（要求された場合のみ） ---
                # 物理的には「光の重心」を求めます。アライメント（光軸合わせ）の微調整に不可欠です。
                if include_centroid and roi_sum > 0:
                    # np.indices は、パッチと同じ形状の座標行列（y座標の行列とx座標の行列）を生成します。
                    # これにより、各ピクセルの「重み（輝度）」に対して「位置（座標）」を掛け合わせる計算が
                    # ループを使わずに一括（行列演算）で行えます。
                    yy, xx = np.indices(patch.shape)
                    
                    # 重心の公式: Σ(座標 * 重み) / Σ(重み)
                    # パッチ内での相対的な重心座標を算出します。
                    rel_cx = np.sum(xx * patch) / roi_sum
                    rel_cy = np.sum(yy * patch) / roi_sum
                    
                    # パッチ内座標を画像全体の絶対座標に変換
                    abs_cx = x1 + rel_cx
                    abs_cy = y1 + rel_cy
                else:
                    # 重心計算をスキップする場合や、全ピクセルが 0（真っ暗）の場合は、
                    # 元々の中心座標をそのまま返します。
                    abs_cx, abs_cy = center_x, center_y

                # 結果を辞書に格納。フロントエンドへ送るため、キーは文字列型にします。
                results[str(roi_idx)] = {
                    "sum": roi_sum,
                    "max": roi_max,
                    "center_val": roi_center_val,
                    "cx": round(abs_cx, 3), # 小数点第3位までで丸めて、データの軽量化と読みやすさを両立
                    "cy": round(abs_cy, 3)
                }

            except Exception as e:
                # 予期せぬエラー（メモリ異常など）が起きても、他のROIの計算を妨げないよう
                # 各ROIごとに例外処理を行っています。
                logger.error(f"[ROI] Error calculating stats for ROI {roi.get('index')}: {e}")
                continue

        return results
