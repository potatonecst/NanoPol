//アプリ全体で使う共通の型

//アプリのモード（画面）定義
export type AppMode = "devices" | "manual" | "auto" | "settings";

//ステージの設定パラメータ型
export interface StageSettings {
    stepMode: "Half" | "Full", //駆動モード
    pulsesPerDegree: number, //1°あたりのパルス数（Half=400, Full=200）
    minSpeedPPS: number, //起動速度 S（デフォルト 500）
    accelTimeMS: number, //加減速時間 R（デフォルト 200）
    maxSpeedLimitPPS: number, //ハードウェア上限（GSC-01は20000）
}

export interface LogEntry {
    timestamp: string; //ISO 8601形式の日時文字列
    level: string; //ログレベル（例: "info", "error"）
    message: string; //ログメッセージ
    name: string; //ログ発生元の名前
}

/**
 * ROI（関心領域）のデータ型
 * 
 * カメラ映像上の特定の領域（粒子など）を指し示し、その範囲内の輝度を計算するために使用します。
 * 座標はカメラの生ピクセル座標（1280x1024など）を基準とし、表示上の拡大率に左右されません。
 */
export interface ROIData {
    id: string;      // ユニークなID
    index: number;   // 固定インデックス (1, 2, 3...)
    x: number;       // 中心座標 X (ピクセル)
    y: number;       // 中心座標 Y (ピクセル)
    size: number;    // 辺の長さ (ピクセル)。常に奇数であることを期待します。
    color?: string;  // 表示用の色（オプション）
}

// --- 自動測定（Auto Mode）関連の型定義 ---

/**
 * 自動測定の進行状況を表すフェーズ（画面）
 */
export type AutoMeasurementPhase = 
    | 'select_session'    // 初期画面：サンプルの新規作成、または今日のリストからロード
    | 'select_category'   // カテゴリ選択：どの条件（Left-Front等）を測定するか選ぶ
    | 'measuring';        // 測定実行：アライメント、プレスキャン、本番測定を行う

/**
 * 自動測定の「履歴エントリ」
 * backend の settings.json 内の measurements 配列の各要素に対応します
 */
export interface AutoMeasurementHistoryEntry {
    id: string;               // 枝番付きID（例: "Left_Front_001"）
    step_category: string;    // カテゴリ名（例: "Left_Front"）
    status: 'completed' | 'saturated' | 'cancelled' | 'failed'; // 測定結果の状態
    message?: string;          // 詳細メッセージ（エラー理由など）
    timestamp_start?: string; // 開始時刻
    timestamp_end?: string;   // 終了時刻
    folder_path: string;      // この枝番データの保存先フォルダ
}

/**
 * 測定セッション全体の情報
 * 作業中のサンプルに関するすべてのメタデータを保持します
 */
export interface MeasurementSession {
    folderPath: string;       // サンプルのルートフォルダ（絶対パス）
    sampleName: string;       // サンプル名
    settings: {
        app_version: string;
        sample_name: string;
        created_at: string;
        measurements: AutoMeasurementHistoryEntry[]; // 過去の測定履歴
    };
}

/**
 * グラフ描画用の1点分のデータ型
 * バックエンドの AutoMeasurementState.data_buffer 内の各要素に対応します。
 */
export interface PlotDataPoint {
    angle: number;      // ステージの角度 [deg]
    sum: number;        // ROI内の全ピクセル輝度の合計（散乱強度）
    max: number;        // ROI内の最大輝度（飽和確認用。8bitなら255、16bitなら65535が上限）
    center_val: number; // ROIの幾何学的中心（固定位置）における生のピクセル値
    cx: number;         // 輝度重心のX座標 [pixel]（アライメントの安定性評価用）
    cy: number;         // 輝度重心のY座標 [pixel]
    timestamp: number;  // データ取得時の Unix タイムスタンプ [s]
}

/**
 * 全ての ROI のグラフデータを保持する型
 * キーは "roi_1", "roi_2" などのインデックス付き文字列です。
 */
export type PlotData = Record<string, PlotDataPoint[]>;
