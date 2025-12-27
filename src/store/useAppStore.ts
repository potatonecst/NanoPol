import { create } from 'zustand';
import { AppMode, StageSettings } from '@/types';

//インターフェース: ストアの中身（データと関数）の設計図
interface AppState {
    //基本
    currentMode: AppMode; //今開いている画面
    setMode: (mode: AppMode) => void; //画面を切り替える関数

    //ステージコントローラ接続
    stagePort: string; //ステージコントローラのポート
    setStagePort: (port: string) => void; //ステージコントローラのポートを設定する関数
    isStageConnected: boolean; //ステージコントローラの接続状態
    setIsStageConnected: (connected: boolean) => void; //ステージコントローラの接続状態を設定する関数

    //カメラ接続
    cameraId: string; //カメラのID
    setCameraId: (id: string) => void; //カメラのIDを設定
    isCameraConnected: boolean; //カメラの接続状態
    setIsCameraConnected: (connected: boolean) => void; //カメラの接続状態を設定する関数

    //カメラの解像度
    cameraResolution: { width: number; height: number }; //カメラの解像度
    setCameraResolution: (width: number, height: number) => void; //カメラの解像度を設定する関数

    //録画状態
    isRecording: boolean; //録画中かどうか
    setIsRecording: (isRecording: boolean) => void; //録画中かどうかを設定する関数

    //ステージコントローラーマニュアル操作
    currentAngle: number; //QWPの回転角度
    setCurrentAngle: (angle: number) => void; //QWPの回転角度を設定する関数

    //システム全体が忙しいかどうか（画面遷移ロック用）
    isSystemBusy: boolean; //システムがbusyかどうか
    setIsSystemBusy: (busy: boolean) => void; //システムがbusyかどうかを設定する関数

    //カメラ設定
    exposureTime: number; //カメラの露出時間
    setExposureTime: (time: number) => void; //カメラの露出時間を設定する関数
    gain: number; //カメラのゲイン
    setGain: (gain: number) => void; //カメラのゲインを設定

    //カメラビュー
    zoomLevel: number; //ズームレベル
    setZoomLevel: (zoom: number) => void; //ズームレベルを設定する関数
    panOffset: { x: number; y: number }; //パンオフセット
    setPanOffset: (offset: { x: number; y: number }) => void; //パンオフセットを設定する関数

    //System Actions
    resetAllConnections: () => void; //接続をリセットする関数

    //ステージ設定
    stageSettings: StageSettings;
    setStageSettings: (settings: Partial<StageSettings>) => void; //設定更新用

    //ヘルパー：StepModeを変更した時にpulsesPerDegreeも自動計算する
    setStepMode: (mode: "Half" | "Full") => void;
}

//ストアの作成: 実際にデータを保管する場所（フック）を作成
export const useAppStore = create<AppState>((set) => ({
    currentMode: "devices", //初期値は「デバイス接続画面」
    setMode: (mode) => set({ currentMode: mode }), //set関数でcurrentModeを書き換え

    stagePort: "", //初期値は空文字
    setStagePort: (port) => set({ stagePort: port }), //set関数でstagePortを書き換え

    isStageConnected: false, //初期値はfalse
    setIsStageConnected: (connected) => set({ isStageConnected: connected }), //set関数でisStageConnectedを書き換え

    cameraId: "", //初期値
    setCameraId: (id) => set({ cameraId: id }), //set関数でcameraIdを書き換え
    isCameraConnected: false, //初期値
    setIsCameraConnected: (connected) => set({ isCameraConnected: connected }), //set関数でisCameraConnectedを書き換え

    cameraResolution: { width: 1280, height: 1024 }, //初期値
    setCameraResolution: (width, height) => set({ cameraResolution: { width, height } }), //set関数でcameraResolutionを書き換え

    isRecording: false, //初期値
    setIsRecording: (val) => set({ isRecording: val }), //set関数

    currentAngle: 0, //初期値
    setCurrentAngle: (angle) => set({ currentAngle: angle }), //set関数でcurrentAngleを書き換え

    isSystemBusy: false, //初期値
    setIsSystemBusy: (busy) => set({ isSystemBusy: busy }), //set関数でisBusyを書き換え

    exposureTime: 50, //初期値
    setExposureTime: (time) => set({ exposureTime: time }), //set関数

    gain: 1, //初期値
    setGain: (val) => set({ gain: val }), //set関数でgain

    zoomLevel: 1, //初期値
    setZoomLevel: (zoom) => set({ zoomLevel: zoom }), //set関数

    panOffset: { x: 0, y: 0 }, //初期値
    setPanOffset: (offset) => set({ panOffset: offset }), //set関数

    //アプリ側の状態を強制的に「未接続・初期状態」に戻す
    resetAllConnections: () => set({
        isStageConnected: false,
        stagePort: "",
        isCameraConnected: false,
        cameraId: "",
        cameraResolution: { width: 1280, height: 1024 },
        isRecording: false,
        currentAngle: 0,
        isSystemBusy: false,
        exposureTime: 50,
        gain: 1,
        zoomLevel: 1,
        panOffset: { x: 0, y: 0 },
    }),

    //設定の初期値
    stageSettings: {
        stepMode: "Half",
        pulsesPerDegree: 400, //Half: 1/0.0025 = 400
        minSpeedPPS: 500,
        accelTimeMS: 200,
        maxSpeedLimitPPS: 20000,
    },

    setStageSettings: (newSettings) => set((state) => ({
        stageSettings: { ...state.stageSettings, ...newSettings }
    })),

    setStepMode: (mode) => set((state) => ({
        stageSettings: {
            ...state.stageSettings,
            stepMode: mode,
            pulsesPerDegree: mode === "Half" ? 400 : 200,
        }
    })),
}));