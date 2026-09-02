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
    defaultStagePort: "", // デフォルトのステージCOMポート（初期値は空文字列）
    outputPresets: [] as Array<{ id: string; name: string; path: string }>, // 保存先プロファイルプリセットの初期リスト
    activePresetId: "", // 現在選択中のプロファイルID（初期値は空文字列）
    rememberLastProfile: false, // 起動時に前回のプロファイル選択を復元するか（デフォルトは安全のためfalse）
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

/**
 * 座標変換時のピクセル中心オフセット（1画素の半分 = 0.5ピクセル）
 * 
 * 【解説】
 * 画像処理（バックエンド）では「ピクセルの中心」を整数（0.0, 1.0...）と定義するのに対し、
 * UI上の描画（CSS座標）は「ピクセルの左端エッジ」を 0.0 とする座標系を使用します。
 * この両者の座標系の原点のズレ（0.5ピクセル分）を埋めるためのオフセット値です。
 */
export const PIXEL_CENTER_OFFSET = 0.5;

/**
 * 自動測定（Auto Mode）における角度範囲プリセットの型定義
 */
export interface AngleRangePreset {
    id: string;          // プリセットの一意識別子
    name: string;        // UI上のボタグラベル（例: "Standard (5°)"）
    startAngle: number;  // 測定開始角度 (deg)
    endAngle: number;    // 測定終了角度 (deg)
    stepAngle: number;   // 測定ステップ角度 (deg)
    points: number;      // 総測定点数
    description: string; // ツールチップ等に表示する用途・補足説明
}

/**
 * 自動測定（Auto Mode）の標準角度範囲プリセット一覧
 * 
 * 【解説】
 * 偏光散乱光測定（QWP回転）において頻出する測定パターンをあらかじめ定義したマスターデータです。
 * ユーザーはボタンを1クリックするだけで、Start/End/Step の3つのパラメータを一括でセットできます。
 */
export const DEFAULT_ANGLE_PRESETS: AngleRangePreset[] = [
    {
        id: "std_5deg",
        name: "Standard (5°)",
        startAngle: 0,
        endAngle: 360,
        stepAngle: 5,
        points: 73,
        description: "標準測定: 0°〜360° を 5° 刻みで走査 (計 73 点)。全体的な偏光プロファイルを素早く取得します。"
    },
    {
        id: "fine_1deg",
        name: "High-Res (1°)",
        startAngle: 0,
        endAngle: 360,
        stepAngle: 1,
        points: 361,
        description: "高解像度測定: 0°〜360° を 1° 刻みで精密走査 (計 361 点)。鋭いピークや消光比の精密解析に最適です。"
    },
    {
        id: "half_2deg",
        name: "Half (2°)",
        startAngle: 0,
        endAngle: 180,
        stepAngle: 2,
        points: 91,
        description: "半周測定: 0°〜180° を 2° 刻みで走査 (計 91 点)。サンプルの半波長対称性を利用して測定時間を短縮します。"
    },
    {
        id: "quarter_1deg",
        name: "Quarter (1°)",
        startAngle: 0,
        endAngle: 90,
        stepAngle: 1,
        points: 91,
        description: "1/4周測定: 0°〜90° を 1° 刻みで走査 (計 91 点)。QWPの基本周期における異方性の確認に適しています。"
    },
    {
        id: "quick_15deg",
        name: "Quick (15°)",
        startAngle: 0,
        endAngle: 360,
        stepAngle: 15,
        points: 25,
        description: "粗スキャン: 0°〜360° を 15° 刻みで高速走査 (計 25 点)。アライメントやシグナル強度の簡易チェック用です。"
    }
];