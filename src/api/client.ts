import { LogEntry } from "../types";

// ==========================================
// API クライアント設定
// ==========================================

/**
 * バックエンドサーバー（FastAPI）のベースURL。
 * 開発中はローカルの8000番ポートを使用します。
 * 本番環境（ビルド後）やポートが変わる場合は、ここを一箇所変更するだけで済みます。
 */
export let API_BASE = "http://127.0.0.1:14201"; // 初期値（フォールバック用）

export const setApiBase = (port: number) => {
    API_BASE = `http://127.0.0.1:${port}`;
    console.log(`[API Client] Base URL dynamically updated to: ${API_BASE}`);
};

/**
 * 共通のフェッチ（HTTP通信）ラッパー関数。
 * 
 * アプリ内のすべてのAPI呼び出しはこの関数を経由して行われます。
 * これにより、「ベースURLの結合」「JSONヘッダーの付与」「エラーチェック」を
 * 毎回書く必要がなくなり、コードが非常に簡潔になります。
 * 
 * @template T - バックエンドから返ってくるJSONデータ（レスポンス）の型（TypeScriptのジェネリクス）
 * @param endpoint - 呼び出すAPIのエンドポイント（例: "/stage/connect"）
 * @param options - HTTPメソッドや送信データ(body)などの追加設定
 * @returns バックエンドから返ってきたJSONデータを、指定された型 `T` として返すPromise
 */
async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const headers = new Headers(options?.headers);
    // GET/HEAD 等のボディなしリクエストでは Content-Type を付けない。
    // WebView環境で不要な preflight(OPTIONS) を避け、CORS切り分けを容易にする。
    if (options?.body != null && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    // window.fetch を使用してバックエンドと通信します。
    const response = await window.fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
    });

    // HTTPステータスコードが 200番台(成功) 以外の場合（例: 400 Bad Request, 500 Internal Server Error）
    if (!response.ok) {
        // エラーを投げて、呼び出し元（UIコンポーネントの try-catch）に処理を任せます。
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    // レスポンスのJSON文字列をJavaScriptのオブジェクトに変換して返します。
    return response.json();
}

// ==========================================
// ステージ操作API (stageApi)
// ==========================================
// 回転ステージ（OptoSigma GSC-01）の接続、移動、設定などを行うAPI群です。

export const stageApi = {
    // 指定したCOMポートでステージに接続します
    connect: (port: string) =>
        request<{ status: string, mode: string, message: string }>("/stage/connect", {
            method: "POST",
            body: JSON.stringify({ port })
        }),

    // ステージの分解能（1度あたりのパルス数）を更新します
    updateConfig: (pulsesPerDegree: number) =>
        request<{ status: string }>("/stage/config", {
            method: "POST",
            body: JSON.stringify({ pulses_per_degree: pulsesPerDegree })
        }),

    // ステージを機械的な原点（ホーム）に復帰させます
    home: () =>
        request<{ status: string, current_angle: number }>("/stage/home", { method: "POST" }),

    // 指定した絶対角度（例: 90度）へステージを移動させます
    moveAbsolute: (angle: number) =>
        request<{ status: string, current_angle: number }>("/stage/move/absolute", {
            method: "POST",
            body: JSON.stringify({ angle })
        }),

    // 現在の位置から指定した角度（プラス・マイナス）だけ相対移動させます
    moveRelative: (delta: number) =>
        request<{ status: string, current_angle: number }>("/stage/move/relative", {
            method: "POST",
            body: JSON.stringify({ delta })
        }),

    // ステージの移動を停止します（immediate = true で即時非常停止）
    stop: (immediate: boolean = false) =>
        request<{ status: string, current_angle: number }>("/stage/stop", {
            method: "POST",
            body: JSON.stringify({ immediate })
        }),

    // ステージの駆動速度（初速、最高速度、加減速時間）を設定します
    setSpeed: (min_pps: number, max_pps: number, accel_time_ms: number) =>
        request<{ status: string }>("/stage/config/speed", {
            method: "POST",
            body: JSON.stringify({ min_pps, max_pps, accel_time_ms })
        }),

    // 現在の角度と、移動中（Busy）かどうかのステータスを取得します（ポーリング用）
    getPosition: () =>
        request<{ status: string, current_angle: number, is_busy: boolean, is_measuring: boolean }>("/stage/position", { method: "GET" }),
}

// ==========================================
// カメラ操作API (cameraApi)
// ==========================================
// Thorlabs/uEyeカメラの接続、設定、スナップショット撮影、録画を行うAPI群です。

export const cameraApi = {
    // 接続可能なカメラの一覧を取得します
    listCameras: () =>
        request<{ cameras: Array<{ id: number, name: string, model: string, serial: string }> }>("/system/cameras"),

    // 指定したIDのカメラに接続し、プレビュー用のバックグラウンドスレッドを起動します
    connect: (id: number = 0) =>
        request<{ status: string, mode: string, message: string }>("/camera/connect", {
            method: "POST",
            body: JSON.stringify({ camera_id: id })
        }),

    // カメラを切断し、リソースを解放します
    disconnect: () =>
        request<{ status: string }>("/camera/disconnect", { method: "POST" }),

    // 露出時間とゲインを設定します
    config: (exposure_ms: number, gain: number) =>
        request<{ status: string }>("/camera/config", {
            method: "POST",
            body: JSON.stringify({ exposure_ms, gain })
        }),

    // スナップショット（1枚の静止画）の撮影をトリガーします。
    // バックエンドの設定により、即座に保存先パス(filepath)が返るか、
    // "pending" ステータスが返り、フロントエンド側の保存ダイアログを待つ状態になります。
    takeSnapshot: () =>
        request<{ status: string, filepath?: string, message?: string }>("/camera/snapshot", { method: "POST" }),

    // ダイアログでユーザーが決定したパスをバックエンドに送り、保留中(pending)の画像を実際に保存します
    saveSnapshot: (filepath: string) =>
        request<{ status: string, filepath: string }>("/camera/snapshot/save", {
            method: "POST",
            body: JSON.stringify({ filepath })
        }),

    // マルチページTIFFへの超高速直書き（録画）を開始します
    startRecording: () =>
        request<{ status: string, filepath: string }>("/camera/record/start", { method: "POST" }),

    // 録画を停止し、必要に応じてMP4変換などを開始します
    stopRecording: () =>
        request<{ status: string, filepath: string }>("/camera/record/stop", { method: "POST" }),

    // 【特殊なエンドポイント】
    // このURLはJSONを返すAPIではなく、MJPEG形式の画像ストリームを無限に送信し続けるURLです。
    // そのため fetch() は使わず、そのまま <img> タグの src 属性にセットするための文字列を返します。
    getVideoFeedUrl: () => `${API_BASE}/camera/video_feed`,
}

// ==========================================
// システム操作API (systemApi)
// ==========================================
// アプリケーション全体の状態管理、ログ、設定の同期を行うAPI群です。

export const systemApi = {
    // 起動時にバックエンドの生存確認と各デバイスの接続状態を取得します
    health: () =>
        request<{ status: string, stage_connected: boolean, camera_connected: boolean, mode: string }>("/health"),

    // 全デバイスの接続を強制切断し、システムを初期状態に戻します
    reset: () =>
        request<{ status: string, mesage: string }>("/system/reset", { method: "POST" }),

    // 利用可能なCOMポート（ステージ接続用）の一覧を取得します
    getPorts: () =>
        request<{ ports: string[] }>("/system/ports", { method: "GET" }),

    // バックエンドのメモリにある直近のログリストを取得します
    getLogs: () =>
        request<{ logs: LogEntry[] }>("/system/logs", { method: "GET" }),

    // フロントエンド（UI）で発生したエラーや操作イベントをバックエンドのロガーに送信します
    postLogs: (level: "INFO" | "WARNING" | "ERROR", message: string) =>
        request("/system/logs", {
            method: "POST",
            body: JSON.stringify({ level, message })
        }),

    // フロントエンドで保存された config.json の内容をバックエンドに送信し、各デバイスに反映します
    updateSettings: (settings: any) =>
        request<{ status: string }>("/system/settings", {
            method: "POST",
            body: JSON.stringify({ settings })
        }),
};