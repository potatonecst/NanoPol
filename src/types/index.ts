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
    status: 'completed' | 'aborted' | 'failed'; // 測定結果の状態
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
