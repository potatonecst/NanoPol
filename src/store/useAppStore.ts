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
    isSettingsDirty: boolean; // 設定画面で未保存の変更があるかどうかのフラグ
    setIsSettingsDirty: (isDirty: boolean) => void; // 未保存フラグを更新する関数
    pendingNavigationMode: AppMode | null; // 未保存確認ダイアログ中に遷移しようとしている保留先モード
    setPendingNavigationMode: (mode: AppMode | null) => void; // 保留先モードを設定する関数

    //バックエンド接続状態
    isBackendConnected: boolean; //バックエンド（Pythonサーバー）が起動しているか
    setIsBackendConnected: (connected: boolean) => void;

    //ステージコントローラ接続
    stagePort: string; //ステージコントローラのポート
    setStagePort: (port: string) => void; //ステージコントローラのポートを設定する関数
    isStageConnected: boolean; //ステージコントローラの接続状態
    setIsStageConnected: (connected: boolean) => void; //ステージコントローラの接続状態を設定する関数
    stagePollingInterval: number; //ステージ位置のポーリング間隔 (ms)
    setStagePollingInterval: (interval: number) => void; //ステージ位置ポーリング間隔を設定する関数

    //カメラ接続
    cameraId: string; //カメラのID
    setCameraId: (id: string) => void; //カメラのIDを設定
    availableCameras: Array<{ id: number; name: string; model: string; serial: string }>; //利用可能なカメラリスト
    setAvailableCameras: (cameras: Array<{ id: number; name: string; model: string; serial: string }>) => void; //リスト設定
    isCameraConnected: boolean; //カメラの接続状態
    setIsCameraConnected: (connected: boolean) => void; //カメラの接続状態を設定する関数

    isCameraHealing: boolean; // カメラ自動修復中フラグ
    cameraReconnectAttempt: number; // カメラ自動再接続試行回数
    isStageHealing: boolean; // ステージ自動修復中フラグ
    setIsCameraHealing: (healing: boolean) => void;
    setCameraReconnectAttempt: (attempt: number) => void;
    setIsStageHealing: (healing: boolean) => void;

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

    // 出力先フォルダおよびプロファイル設定
    outputDirectory: string; // 現在適用されている有効な出力先フォルダパス
    setOutputDirectory: (dir: string) => void; // 有効な出力先フォルダを設定する関数
    defaultOutputDirectory: string; // プロファイル未選択時の共通デフォルト保存先パス
    setDefaultOutputDirectory: (dir: string) => void; // 共通デフォルト保存先を設定する関数
    outputPresets: Array<{ id: string; name: string; path: string }>; // 登録されているプリセットリスト
    setOutputPresets: (presets: Array<{ id: string; name: string; path: string }>) => void; // プリセットリストを設定する関数
    activePresetId: string; // 現在選択中のプロファイルID
    setActivePresetId: (id: string) => void; // 選択プロファイルIDを設定しパスを同期する関数
    syncActivePresetIdFromPath: (path: string) => void; // パス値から対応するプロファイルIDを逆引き同期する関数

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
    fetchRois: () => Promise<void>; // バックエンドから最新のROIを取得してUIに同期

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
    currentMode: "devices", //初期画面
    setMode: (mode) => set({ currentMode: mode }), //画面を切り替える関数
    isSettingsDirty: false, // 設定画面の未保存フラグ
    setIsSettingsDirty: (isDirty) => set({ isSettingsDirty: isDirty }),
    pendingNavigationMode: null, // 未保存確認ダイアログ中に遷移しようとしている保留先モード
    setPendingNavigationMode: (mode) => set({ pendingNavigationMode: mode }),

    isBackendConnected: false, // 初期値
    setIsBackendConnected: (connected) => set({ isBackendConnected: connected }),

    stagePort: "", //初期値は空文字
    setStagePort: (port) => set({ stagePort: port }), //set関数でstagePortを書き換え

    isStageConnected: false, //初期値はfalse
    setIsStageConnected: (connected) => set({ isStageConnected: connected }), //set関数でisStageConnectedを書き換え
    stagePollingInterval: 1000, // 初期値は 1000ms (1秒間隔)
    setStagePollingInterval: (interval) => set({ stagePollingInterval: interval }),

    cameraId: "", //初期値
    setCameraId: (id) => set({ cameraId: id }), //set関数でcameraIdを書き換え
    availableCameras: [], //初期値
    setAvailableCameras: (cameras) => set({ availableCameras: cameras }), //set関数
    isCameraConnected: false, //初期値
    setIsCameraConnected: (connected) => set({ isCameraConnected: connected }), //set関数でisCameraConnectedを書き換え

    isCameraHealing: false,
    cameraReconnectAttempt: 0,
    isStageHealing: false,
    setIsCameraHealing: (healing) => set({ isCameraHealing: healing }),
    setCameraReconnectAttempt: (attempt) => set({ cameraReconnectAttempt: attempt }),
    setIsStageHealing: (healing) => set({ isStageHealing: healing }),

    cameraResolution: { width: 1280, height: 1024 }, //初期値
    setCameraResolution: (width, height) => set({ cameraResolution: { width, height } }), //set関数でcameraResolutionを書き換え

    isRecording: false, //初期値
    setIsRecording: (val) => set({ isRecording: val }), //set関数

    outputDirectory: "", // 現在測定データや画像を保存するフォルダの有効な絶対パス（初期値は空文字列）
    // 【有効パス設定アクション】
    // 画面上で選択された保存パスを Zustand のグローバル状態にセットし、コンポーネントの再描画をトリガーします。
    setOutputDirectory: (dir) => set({ outputDirectory: dir }),

    defaultOutputDirectory: "", // プロファイル（プリセット）を使用しない場合にフォールバックする、システムの大元の基準デフォルトパス
    // 【基準パス設定アクション】
    // アプリ起動時に決定されるシステム標準のフォルダパスを状態ストアに記憶させます。
    setDefaultOutputDirectory: (dir) => set({ defaultOutputDirectory: dir }),

    outputPresets: [], // ユーザーが設定画面で登録した保存先プロファイルのオブジェクト配列
    // 【プロファイルリスト設定アクション】
    // 設定ファイル config.json から読み込まれた、または設定画面で保存されたプロファイルリストをストアにロードします。
    setOutputPresets: (presets) => set({ outputPresets: presets }),

    activePresetId: "", // 現在接続画面でアクティブ（選択）になっているプロファイルの内部ID（空文字列は未選択）
    // 【アクティブプロファイルID選択アクション】
    // ドロップダウンでプロファイルが選ばれた際に呼び出され、選択されたID（または未選択・Custom）をセットすると同時に、
    // 選択されたプロファイルが持つパス（または基準パス）を現在の出力先絶対パス `outputDirectory` に同期させます。
    setActivePresetId: (id) => set((state) => {
        if (id === "") {
            // No Preset (デフォルト) が選ばれた場合は、アクティブIDを空文字列にし、
            // 現在の保存先パスを、起動時にロードされた基準デフォルトパス (defaultOutputDirectory) に安全に戻します。
            return {
                activePresetId: "",
                outputDirectory: state.defaultOutputDirectory
            };
        }
        
        // 登録されているプロファイルリストの中から、選択されたIDと一致するものを探索
        const preset = state.outputPresets.find((p) => p.id === id);
        if (preset) {
            // 一致するプロファイルが見つかった場合は、アクティブIDにそのIDをセットし、
            // そのプロファイルに紐付けられている絶対パスを有効パス `outputDirectory` に連動コピーします。
            return {
                activePresetId: id,
                outputDirectory: preset.path
            };
        }
        
        // Custom (手動設定) のダミーキー "__custom__" が選択された場合など、
        // 登録プロファイルに該当がない場合は、パスは書き換えずにアクティブIDのみを更新します。
        return { activePresetId: id };
    }),

    // 【パス値からのプロファイルID逆引き同期アクション】
    // 起動時や設定画面で「Save Settings」を押した際に、現在の出力先フォルダパス (path) を確認し、
    // 対応するドロップダウンの表示選択状態 (activePresetId) を自動で逆引き判定・同期します。
    syncActivePresetIdFromPath: (path) => set((state) => {
        if (!path) return { activePresetId: "" };
        
        // 1. 登録されているプロファイル配列の中に、指定された絶対パスと一致するものがあるか探索
        const matchedPreset = state.outputPresets.find((p) => p.path === path);
        if (matchedPreset) {
            // 完全一致するプロファイルがあれば、ドロップダウンをそのプロファイル選択状態にします
            return { activePresetId: matchedPreset.id };
        }
        
        // 2. システムの大元の基準デフォルトパス (defaultOutputDirectory) と完全に一致する場合
        // プロファイルに該当がなく、かつ基準デフォルト値と同じであれば、「未指定（No Preset）」に戻します
        if (path === state.defaultOutputDirectory) {
            return { activePresetId: "" };
        }
        
        // 3. 上記のいずれとも一致しない（ユーザーが設定画面等で独自に手動指定した別パスである）場合
        // プロファイル外のカスタムパスが適用されているため、ドロップダウンの表示を Custom に自動切り替えします
        return { activePresetId: "__custom__" };
    }),

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
    fetchRois: async () => {
        try {
            // バックエンドから最新のROIリスト（重心等に更新されたもの）を非同期で取得します
            const backendRois = await cameraApi.getRois();
            set((state) => {
                // UI表示に重要なUUID（id）や描画カラー（color）を壊さないよう、既存のROI情報を維持しながら座標とサイズだけをマッピング更新します
                const updatedRois = backendRois.map((b) => {
                    const existing = state.rois.find((r) => r.index === b.index);
                    
                    if (existing) {
                        return {
                            ...existing,
                            x: b.x,
                            y: b.y,
                            size: b.size
                        };
                    } else {
                        // 万が一バックエンドに新規ROIが存在した場合の、フロントエンド側の自動ID/カラー割当（フォールバック）
                        const id = (typeof crypto !== 'undefined' && (crypto as any).randomUUID) 
                            ? (crypto as any).randomUUID() 
                            : Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
                        
                        const color = ROI_COLORS[(b.index - 1) % ROI_COLORS.length];
                        return {
                            id,
                            index: b.index,
                            x: b.x,
                            y: b.y,
                            size: b.size,
                            color
                        };
                    }
                }).sort((a, b) => a.index - b.index); // ROIテーブルや描画の表示順序を一定にするためインデックスでソートします

                return { rois: updatedRois };
            });
        } catch (err) {
            console.error("Failed to fetch ROIs from backend:", err);
        }
    },

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
        stagePollingInterval: 1000,
        outputDirectory: "",
        defaultOutputDirectory: "",
        outputPresets: [],
        activePresetId: "",
        isCameraHealing: false,
        cameraReconnectAttempt: 0,
        isStageHealing: false,
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
