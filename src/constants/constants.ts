import { documentDir, join } from "@tauri-apps/api/path";

/**
 * アプリケーション全体で共有される定数定義ファイル
 */

/**
 * アプリの全体設定を保存するファイル名
 */
export const CONFIG_FILENAME = "config.json";

/**
 * アプリの初期設定値（マスターデータ）
 * 
 * パス(`outputDirectory`)はOSによって動的に変わるため除外しています。
 * `Omit<Settings, "outputDirectory">` とすることで、「Settings型からoutputDirectoryだけを抜いた型」として
 * TypeScriptに厳密な型（"TIFF"や"Monochrome"などの文字列リテラル）を認識させます。
 */
export const DEFAULT_SETTINGS = {
    askSavePath: false,
    snapshotPrefix: "snapshot_",
    recordPrefix: "record_",
    imageFormat: "TIFF",
    recordFormat: "16-bit TIFF",
    autoConvertMp4: false,
    keepRawTiff: true,
    defaultSpeedMin: 500,
    defaultSpeedMax: 5000,
    defaultAccelTime: 200,
    cameraMode: "Monochrome",
    defaultExposure: 0.06675,
    defaultGain: 1.0,
} as const;

/**
 * デフォルトの保存先ディレクトリパスを非同期で取得します。
 * 
 * OSのドキュメントフォルダの直下に "NanoPol" フォルダを指定します。
 * 内部でTauriの `join` 関数を使用し、OSごとの区切り文字（\ や /）の違いを自動で吸収しています。
 * 
 * @returns 結合されたデフォルトのディレクトリパスのPromise（例: "Documents/NanoPol"）
 */
export const getDefaultOutputDirectory = async (): Promise<string> => {
    const docDir = await documentDir();
    return await join(docDir, "NanoPol");
};

// デバイスの露光/ゲイン範囲が取得できないときに使うフォールバック定数
export const DEFAULT_EXPOSURE_MIN_MS = 0.06675;
export const DEFAULT_EXPOSURE_MAX_MS = 99.92475;
export const DEFAULT_EXPOSURE_STEP_MS = 0.06675;

export const DEFAULT_GAIN_MIN = 1.0;
export const DEFAULT_GAIN_MAX = 13.0;

/**
 * ROI (Region of Interest) 関連の定数
 */
export const MAX_ROIS = 20;
export const MIN_ROI_SIZE = 1;

/**
 * ROIに順番に割り当てるカラーパレット（高視認性 20色）
 * 1-10番は特に区別しやすい鮮やかな色、11-20番も可能な限り視認性を確保
 */
export const ROI_COLORS = [
    "rgba(255, 255, 0, 0.8)",   // 1: Yellow
    "rgba(0, 255, 255, 0.8)",   // 2: Cyan
    "rgba(255, 0, 255, 0.8)",   // 3: Magenta
    "rgba(0, 255, 0, 0.8)",     // 4: Green (Lime)
    "rgba(255, 50, 50, 0.8)",   // 5: Red
    "rgba(255, 165, 0, 0.8)",   // 6: Orange
    "rgba(180, 0, 255, 0.8)",   // 7: Purple
    "rgba(0, 150, 255, 0.8)",   // 8: Azure Blue
    "rgba(180, 255, 0, 0.8)",   // 9: Chartreuse
    "rgba(255, 105, 180, 0.8)", // 10: Hot Pink
    "rgba(255, 215, 0, 0.8)",   // 11: Gold
    "rgba(0, 255, 127, 0.8)",   // 12: Spring Green
    "rgba(123, 104, 238, 0.8)", // 13: Medium Slate Blue
    "rgba(255, 69, 0, 0.8)",    // 14: Orange Red
    "rgba(127, 255, 212, 0.8)", // 15: Aquamarine
    "rgba(255, 20, 147, 0.8)",  // 16: Deep Pink
    "rgba(70, 130, 180, 0.8)",  // 17: Steel Blue
    "rgba(218, 112, 214, 0.8)", // 18: Orchid
    "rgba(0, 128, 128, 0.8)",   // 19: Teal
    "rgba(240, 230, 140, 0.8)", // 20: Khaki
];