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