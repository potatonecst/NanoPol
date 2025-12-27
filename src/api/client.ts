import { LogEntry } from "../types";

const API_BASE = "http://127.0.0.1:8000"

//共通のフェッチ関数
async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await window.fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...options?.headers,
        },
    });

    if (!response.ok) {
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

//ステージ操作
export const stageApi = {
    connect: (port: string) =>
        request<{ status: string, mode: string, message: string }>("/stage/connect", {
            method: "POST",
            body: JSON.stringify({ port })
        }),

    updateConfig: (pulsesPerDegree: number) =>
        request<{ status: string }>("/stage/config", {
            method: "POST",
            body: JSON.stringify({ pulses_per_degree: pulsesPerDegree })
        }),

    //原点復帰
    home: () =>
        request<{ status: string, current_angle: number }>("/stage/home", { method: "POST" }),

    //絶対移動
    moveAbsolute: (angle: number) =>
        request<{ status: string, current_angle: number }>("/stage/move/absolute", {
            method: "POST",
            body: JSON.stringify({ angle })
        }),

    //相対移動
    moveRelative: (delta: number) =>
        request<{ status: string, current_angle: number }>("/stage/move/relative", {
            method: "POST",
            body: JSON.stringify({ delta })
        }),

    //停止
    stop: (immediate: boolean = false) =>
        request<{ status: string, current_angle: number }>("/stage/stop", {
            method: "POST",
            body: JSON.stringify({ immediate })
        }),

    //速度設定
    setSpeed: (min_pps: number, max_pps: number, accel_time_ms: number) =>
        request<{ status: string }>("/stage/config/speed", {
            method: "POST",
            body: JSON.stringify({ min_pps, max_pps, accel_time_ms })
        }),

    getPosition: () =>
        request<{ status: string, current_angle: number, is_busy?: boolean }>("/stage/position", { method: "GET" }),
}

//カメラ操作
export const cameraApi = {
    connect: (id: string) =>
        request<{ status: string, message: string }>(`/connect/camera?camera_id=${id}`, { method: "POST" }),

    //あとで追加: snap, record, etc.
}

export const systemApi = {
    health: () =>
        request<{ status: string }>("/health"),

    reset: () =>
        request<{ status: string, mesage: string }>("system/reset", { method: "POST" }),

    getPorts: () =>
        request<{ ports: string[] }>("/system/ports", { method: "GET" }),

    getLogs: () =>
        request<{ logs: LogEntry[] }>("/system/logs", { method: "GET" }),

    postLogs: (level: "INFO" | "WARNING" | "ERROR", message: string) =>
        request("system/logs", {
            method: "POST",
            body: JSON.stringify({ level, message })
        }),
};