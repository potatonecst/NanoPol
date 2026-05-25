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