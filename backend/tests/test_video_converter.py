import os
import sys
import csv
import json
import cv2
import numpy as np
import tifffile
import tempfile

# パス解決（backend ディレクトリを sys.path に追加）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.video_converter import convert_tiff_to_mp4_with_interpolation

def test_convert_tiff_to_mp4_8bit_basic():
    """8-bit モノクロ TIFF の基本的な MP4 変換および JSON 生成テスト"""
    with tempfile.TemporaryDirectory() as temp_dir:
        tiff_path = os.path.join(temp_dir, "test_8bit.tif")
        csv_path = os.path.join(temp_dir, "test_8bit.csv")
        mp4_path = os.path.join(temp_dir, "test_8bit.mp4")
        json_path = os.path.join(temp_dir, "test_8bit.json")

        # 5フレームの 8-bit 画像を作成して保存
        frames = [np.full((100, 100), i * 50, dtype=np.uint8) for i in range(5)]
        with tifffile.TiffWriter(tiff_path) as tw:
            for f in frames:
                tw.write(f)

        # CSV タイムスタンプ（33.33ms 等間隔、ドロップなし）
        with open(csv_path, "w", newline="", encoding="utf-8") as cf:
            writer = csv.writer(cf)
            writer.writerow(["Frame_Index", "Frame_Timestamp_ms"])
            for i in range(5):
                writer.writerow([i, i * 33.33])

        progress_records = []
        def on_progress(p, cur, tot, msg):
            progress_records.append((p, cur, tot))

        result_path, summary = convert_tiff_to_mp4_with_interpolation(
            tiff_path=tiff_path,
            csv_path=csv_path,
            output_mp4_path=mp4_path,
            is_color=False,
            keep_raw=True,
            progress_callback=on_progress
        )

        assert os.path.exists(result_path)
        assert os.path.exists(tiff_path)  # keep_raw=True なので残る
        assert os.path.exists(json_path)  # JSON が生成されていること
        assert len(progress_records) > 0
        assert progress_records[-1][0] == 100  # 100% で終了

        # サマリー辞書の検証（ドロップなし）
        assert summary["source_frames"] == 5
        assert summary["interpolated_frames"] == 0
        assert summary["output_mp4_frames"] == 5
        assert summary["drop_events_count"] == 0
        assert len(summary["drop_details"]) == 0
        assert summary["raw_tiff_kept"] is True

        # JSON ファイル内容の検証
        with open(json_path, mode="r", encoding="utf-8") as jf:
            json_data = json.load(jf)
            assert "conversion_summary" in json_data
            assert json_data["conversion_summary"]["source_frames"] == 5
            assert json_data["conversion_summary"]["interpolated_frames"] == 0

        # OpenCV で動画を読み込んで確認
        cap = cv2.VideoCapture(result_path)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        assert frame_count == 5

def test_convert_tiff_to_mp4_16bit_with_drop_frame_interpolation():
    """16-bit TIFF とコマ落ち（遅延）あり CSV でのドロップフレーム補完＆サマリーJSON検証テスト"""
    with tempfile.TemporaryDirectory() as temp_dir:
        tiff_path = os.path.join(temp_dir, "test_16bit_drop.tif")
        csv_path = os.path.join(temp_dir, "test_16bit_drop.csv")
        mp4_path = os.path.join(temp_dir, "test_16bit_drop.mp4")
        json_path = os.path.join(temp_dir, "test_16bit_drop.json")

        # 3フレームの 16-bit 画像を作成
        frames = [np.full((120, 160), (i + 1) * 10000, dtype=np.uint16) for i in range(3)]
        with tifffile.TiffWriter(tiff_path) as tw:
            for f in frames:
                tw.write(f)

        # タイムスタンプ: 0ms, 100ms (2フレーム分欠落), 133ms
        with open(csv_path, "w", newline="", encoding="utf-8") as cf:
            writer = csv.writer(cf)
            writer.writerow(["Frame_Index", "Frame_Timestamp_ms"])
            writer.writerow([0, 0.0])
            writer.writerow([1, 100.0])   # 100ms 差分 -> 約3フレーム分（2枚水増し）
            writer.writerow([2, 133.33])

        result_path, summary = convert_tiff_to_mp4_with_interpolation(
            tiff_path=tiff_path,
            csv_path=csv_path,
            output_mp4_path=mp4_path,
            is_color=False,
            keep_raw=False  # 変換後に元 TIFF 削除
        )

        assert os.path.exists(result_path)
        assert not os.path.exists(tiff_path)  # keep_raw=False なので削除される
        assert os.path.exists(json_path)      # JSON が生成されていること

        # サマリー辞書の検証（2フレーム補完あり）
        assert summary["source_frames"] == 3
        assert summary["interpolated_frames"] == 2
        assert summary["output_mp4_frames"] == 5
        assert summary["drop_events_count"] == 1
        assert len(summary["drop_details"]) == 1
        assert summary["drop_details"][0]["frame_index"] == 1
        assert summary["drop_details"][0]["added_frames"] == 2
        assert summary["raw_tiff_kept"] is False

        # JSON ファイル内容の検証
        with open(json_path, mode="r", encoding="utf-8") as jf:
            json_data = json.load(jf)
            assert json_data["conversion_summary"]["interpolated_frames"] == 2
            assert json_data["conversion_summary"]["output_mp4_frames"] == 5

        cap = cv2.VideoCapture(result_path)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        # 元 3 フレーム + 補完分（100ms / 33.33ms = 3枚 -> +2枚水増し）= 5 フレーム
        assert frame_count == 5

if __name__ == "__main__":
    print("Running test_convert_tiff_to_mp4_8bit_basic...")
    test_convert_tiff_to_mp4_8bit_basic()
    print("Running test_convert_tiff_to_mp4_16bit_with_drop_frame_interpolation...")
    test_convert_tiff_to_mp4_16bit_with_drop_frame_interpolation()
    print("All tests passed successfully!")

