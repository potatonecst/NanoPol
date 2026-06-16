import { create } from 'zustand';
import { AppMode, StageSettings, AutoMeasurementPhase, MeasurementSession, ROIData, PlotData } from '@/types';
import { MAX_ROIS, ROI_COLORS } from '@/constants/constants';
import { cameraApi } from '@/api/client';

// バックエンドへ現在のROIリストを同期するヘルパー
/**
 * 【背景と役割】
 * フロントエンド（画面）で四角い枠（ROI）を配置したり移動させたりした際、
 * その座標はフロントエンドのメモリ上にしか存在しません。
 * そのまま自動測定（Pre-Scan等）を開始すると、バックエンドは「どこを解析すれば良いか」
 * 分からず、ノイズだと判定して失敗してしまいます。
 * そのため、フロントエンドでROIが変更されるたびに、この関数を使って最新の座標とサイズを
 * バックエンドの `/camera/rois` API へ送信（同期）するようにしています。
 */
const syncRoisToBackend = (rois: ROIData[]) => {
    const payload = rois.map(r => ({
        index: r.index,
        x: r.x,
        y: r.y,
        size: r.size
    }));
    cameraApi.setRois(payload).catch(err => {
        console.error("Failed to sync ROIs to backend:", err);
    });
};

//インターフェース: ストアの中身（データと関数）の設計図
interface AppState {
    //基本
    currentMode: AppMode; //今開いている画面
    setMode: (mode: AppMode) => void; //画面を切り替える関数

    //バックエンド接続状態
    isBackendConnected: boolean; //バックエンド（Pythonサーバー）が起動しているか
    setIsBackendConnected: (connected: boolean) => void;

    //ステージコントローラ接続
    stagePort: string; //ステージコントローラのポート
    setStagePort: (port: string) => void; //ステージコントローラのポートを設定する関数
    isStageConnected: boolean; //ステージコントローラの接続状態
    setIsStageConnected: (connected: boolean) => void; //ステージコントローラの接続状態を設定する関数

    //カメラ接続
    cameraId: string; //カメラのID
    setCameraId: (id: string) => void; //カメラのIDを設定
    availableCameras: Array<{ id: number; name: string; model: string; serial: string }>; //利用可能なカメラリスト
    setAvailableCameras: (cameras: Array<{ id: number; name: string; model: string; serial: string }>) => void; //リスト設定
    isCameraConnected: boolean; //カメラの接続状態
    setIsCameraConnected: (connected: boolean) => void; //カメラの接続状態を設定する関数

    //カメラの解像度
    cameraResolution: { width: number; height: number }; //カメラの解像度
    setCameraResolution: (width: number, height: number) => void; //カメラの解像度を設定する関数

    // デバイスが報告するゲイン範囲（接続時に取得してUIで利用する）
    cameraGainRange: { min: number; max: number } | null;
    setCameraGainRange: (range: { min: number; max: number } | null) => void;

    // デバイスが報告する露光範囲（接続時に取得してUIで利用する）
    cameraExposureRange: { min: number; max: number; step: number } | null;
    setCameraExposureRange: (range: { min: number; max: number; step: number } | null) => void;

    //録画状態
    isRecording: boolean; //録画中かどうか
    setIsRecording: (isRecording: boolean) => void; //録画中かどうかを設定する関数

    //ステージコントローラーマニュアル操作
    currentAngle: number; //QWPの回転角度
    setCurrentAngle: (angle: number) => void; //QWPの回転角度を設定する関数

    //システム全体が忙しいかどうか（画面遷移ロック用）
    isSystemBusy: boolean; //システムがbusyかどうか
    setIsSystemBusy: (busy: boolean) => void; //システムがbusyかどうかを設定する関数

    isStageBusy: boolean; // ステージが物理的に回転中か
    isMeasuring: boolean; // 自動測定シーケンス（Pre-Scan または 本番）が実行中か
    isPrescan: boolean;   // 現在実行中の測定が Pre-Scan かどうか
    setIsMeasuring: (measuring: boolean) => void;
    setIsPrescan: (isPrescan: boolean) => void;

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

    // ROI (Region of Interest) 管理
    rois: ROIData[]; // ROIのリスト
    addROI: (roi: Omit<ROIData, 'id'>) => void; // ROIを追加
    updateROI: (id: string, updates: Partial<ROIData>) => void; // ROIを更新
    removeROI: (id: string) => void; // ROIを削除
    clearROIs: () => void; // 全てのROIをクリア

    // --- 自動測定 (Auto Mode) 専用の状態 ---
    autoPhase: AutoMeasurementPhase;
    setAutoPhase: (phase: AutoMeasurementPhase) => void;
    
    currentSession: MeasurementSession | null;
    setCurrentSession: (session: MeasurementSession | null) => void;
    
    selectedCategory: string | null; // 現在選択中の測定カテゴリ (例: "Left_Front")
    setSelectedCategory: (category: string | null) => void;

    // --- グラフデータ (Real-time Plot) ---
    plotData: PlotData; // キーは "roi_1", "roi_2" など
    setPlotData: (data: PlotData) => void;
    clearPlotData: () => void;

    // 自動測定に関わる状態のみを初期化
    resetAutoMeasurement: () => void;

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

    isBackendConnected: false, // 初期値
    setIsBackendConnected: (connected) => set({ isBackendConnected: connected }),

    stagePort: "", //初期値は空文字
    setStagePort: (port) => set({ stagePort: port }), //set関数でstagePortを書き換え

    isStageConnected: false, //初期値はfalse
    setIsStageConnected: (connected) => set({ isStageConnected: connected }), //set関数でisStageConnectedを書き換え

    cameraId: "", //初期値
    setCameraId: (id) => set({ cameraId: id }), //set関数でcameraIdを書き換え
    availableCameras: [], //初期値
    setAvailableCameras: (cameras) => set({ availableCameras: cameras }), //set関数
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

    isStageBusy: false, //初期値
    isMeasuring: false, //初期値
    isPrescan: false,   //初期値
    setIsMeasuring: (measuring) => set({ isMeasuring: measuring }),
    setIsPrescan: (val) => set({ isPrescan: val }),

    exposureTime: 0.06675, //初期値
    setExposureTime: (time) => set({ exposureTime: time }), //set関数

    gain: 1, //初期値
    setGain: (val) => set({ gain: val }), //set関数でgain

    cameraGainRange: null,
    setCameraGainRange: (range) => set({ cameraGainRange: range }),

    cameraExposureRange: null,
    setCameraExposureRange: (range) => set({ cameraExposureRange: range }),

    zoomLevel: 1, //初期値
    setZoomLevel: (zoom) => set({ zoomLevel: zoom }), //set関数

    panOffset: { x: 0, y: 0 }, //初期値
    setPanOffset: (offset) => set({ panOffset: offset }), //set関数

    // ROI (Region of Interest) 管理
    rois: [],
    addROI: (roi) => set((state) => {
        // 最大数制限のチェック
        if (state.rois.length >= MAX_ROIS) return state;

        // 最小の未使用インデックス (1-based) を探す
        const usedIndices = state.rois.map(r => r.index);
        let smallestAvailableIndex = 1;
        while (usedIndices.includes(smallestAvailableIndex) && smallestAvailableIndex <= MAX_ROIS) {
            smallestAvailableIndex++;
        }

        // 万が一空きがない場合（通常は length チェックで弾かれる）
        if (smallestAvailableIndex > MAX_ROIS) return state;

        const { width, height } = state.cameraResolution;
        // 型安全のため、sizeを確実に数値として取得
        const size = typeof roi.size === 'number' ? roi.size : 5;
        
        // 中心座標が画像枠内に収まるようにクランプ
        const halfSize = size / 2;
        const clampedX = Math.max(halfSize, Math.min(width - halfSize, roi.x));
        const clampedY = Math.max(halfSize, Math.min(height - halfSize, roi.y));

        // インデックスに紐づく色を割り当てる (0-based に変換して取得)
        const color = ROI_COLORS[(smallestAvailableIndex - 1) % ROI_COLORS.length];

        // ID生成: crypto.randomUUID が使えない環境へのフォールバック
        const id = (typeof crypto !== 'undefined' && (crypto as any).randomUUID) 
            ? (crypto as any).randomUUID() 
            : Math.random().toString(36).substring(2, 11) + Date.now().toString(36);

        // 新しいROIオブジェクトを作成
        const newROI: ROIData = {
            ...roi,
            id,
            index: smallestAvailableIndex,
            x: clampedX,
            y: clampedY,
            size,
            color
        };

        // UIで見やすいようにインデックス順でソートして保持
        const updatedRois = [...state.rois, newROI].sort((a, b) => a.index - b.index);
        
        // バックエンドへ同期
        syncRoisToBackend(updatedRois);

        return {
            rois: updatedRois
        };
    }),
    updateROI: (id, updates) => set((state) => {
        const { width, height } = state.cameraResolution;
        
        const updatedRois = state.rois.map((r) => {
            if (r.id !== id) return r;

            // 更新後の値を計算（無ければ現在の値）
            const newSize = updates.size ?? r.size;
            const halfSize = newSize / 2;

            // 座標またはサイズが更新される場合、常に枠内にクランプ
            let newX = updates.x ?? r.x;
            let newY = updates.y ?? r.y;

            // クランプ処理
            newX = Math.max(halfSize, Math.min(width - halfSize, newX));
            newY = Math.max(halfSize, Math.min(height - halfSize, newY));

            return { ...r, ...updates, x: newX, y: newY, size: newSize };
        });

        syncRoisToBackend(updatedRois);
        return { rois: updatedRois };
    }),
    removeROI: (id) => set((state) => {
        const updatedRois = state.rois.filter((r) => r.id !== id);
        syncRoisToBackend(updatedRois);
        return { rois: updatedRois };
    }),
    clearROIs: () => set(() => {
        syncRoisToBackend([]);
        return { rois: [] };
    }),

    // --- 自動測定 (Auto Mode) 専用の状態 ---
    autoPhase: 'select_session',
    setAutoPhase: (phase) => set({ autoPhase: phase }),
    
    currentSession: null,
    setCurrentSession: (session) => set({ currentSession: session }),
    
    selectedCategory: null,
    setSelectedCategory: (category) => set({ selectedCategory: category }),

    // --- グラフデータ ---
    plotData: {},
    setPlotData: (data) => set({ plotData: data }),
    clearPlotData: () => set({ plotData: {} }),

    resetAutoMeasurement: () => set({
        autoPhase: 'select_session',
        currentSession: null,
        selectedCategory: null,
        isMeasuring: false,
        rois: [], // ROIもリセット
        plotData: {}, // グラフデータもリセット
    }),

    //アプリ側の状態を強制的に「未接続・初期状態」に戻す
    resetAllConnections: () => set({
        isStageConnected: false,
        stagePort: "",
        isCameraConnected: false,
        cameraId: "",
        availableCameras: [],
        cameraResolution: { width: 1280, height: 1024 },
        isRecording: false,
        currentAngle: 0,
        isStageBusy: false,
        isMeasuring: false,
        isSystemBusy: false,
        exposureTime: 0.06675,
        gain: 1.0,
        cameraGainRange: null,
        cameraExposureRange: null,
        zoomLevel: 1,
        panOffset: { x: 0, y: 0 },
        rois: [],
        // 自動測定の状態もリセット
        autoPhase: 'select_session',
        currentSession: null,
        selectedCategory: null,
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
