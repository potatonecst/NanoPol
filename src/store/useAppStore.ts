import { create } from 'zustand';
import { AppMode } from '@/types';

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

    //ステージコントローラーマニュアル操作
    currentAngle: number; //カメラの回転角度
    setCurrentAngle: (angle: number) => void; //カメラの回転角度を設定する関数

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


    currentAngle: 0, //初期値
    setCurrentAngle: (angle) => set({ currentAngle: angle }), //set関数でrotationAngleを書き換え

    exposureTime: 50, //初期値
    setExposureTime: (time) => set({ exposureTime: time }), //set関数

    gain: 1, //初期値
    setGain: (val) => set({ gain: val }), //set関数でgain

    zoomLevel: 1, //初期値
    setZoomLevel: (zoom) => set({ zoomLevel: zoom }), //set関数

    panOffset: { x: 0, y: 0 }, //初期値
    setPanOffset: (offset) => set({ panOffset: offset }), //set関数
}));