import { useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/useAppStore';
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError, FieldDescription } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { 
    Play, 
    Scan, 
    AlertCircle, 
    RefreshCcw, 
    ArrowLeft, 
    XCircle, 
    Minus, 
    Plus, 
    Joystick, 
    MoveRight, 
    House, 
    FolderOpen, 
    Square,
    AlertTriangle,
    SlidersHorizontal,
    Info
} from 'lucide-react';
import { autoApi } from '@/api/client';
import { toast } from 'sonner';
import { setupFormSchema, SetupFormValues } from '@/schemas/measurementSchema';
import { useStageActions } from '@/hooks/useStageActions';
import { Progress } from "@/components/ui/progress";
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { DEFAULT_ANGLE_PRESETS, AngleRangePreset } from '@/constants/constants';

/**
 * 測定管理 (Measurement Manager) コンポーネント
 * 
 * 自動測定ワークフローの最終フェーズを担当します。
 * パラメータの入力、事前スキャン（アライメント）、および本番測定の実行を管理します。
 * 
 * 【主な機能】
 * 1. 物理パラメータ（レーザーパワー、角度範囲）の入力・バリデーション。
 * 2. Pre-Scan (事前スキャン): 測定前にROIの最適な中心位置を自動算出。
 * 3. Step & Shoot 測定: 指定された角度リストに従って自動的に回転と撮影を繰り返す。
 * 4. Manual Remote: 測定準備のためのクイックなステージ手動操作。
 */
export function MeasurementManager() {
    // --- グローバル状態の取得 ---
    const {
        isMeasuring,        // 現在自動測定（本番）が走っているか
        setIsMeasuring,     // 測定状態を更新する関数
        setIsPrescan,       // Pre-Scan状態を更新する関数
        currentSession,     // 現在アクティブなセッション（サンプル）の情報
        setCurrentSession,  // セッション情報を更新する関数
        selectedCategory,   // 選択中の測定カテゴリ（Left-Frontなど）
        setAutoPhase,       // フェーズ切り替え用アクション
        currentAngle,       // ステージの現在角度（ポーリングで更新される）
        setPlotData,        // グラフデータを更新するアクション
        clearPlotData,      // グラフデータをクリアするアクション
        fetchRois           // 最新のROIリストをバックエンドから取得するアクション
    } = useAppStore(useShallow((state) => ({
        isMeasuring: state.isMeasuring,
        setIsMeasuring: state.setIsMeasuring,
        setIsPrescan: state.setIsPrescan,
        currentSession: state.currentSession,
        setCurrentSession: state.setCurrentSession,
        selectedCategory: state.selectedCategory,
        setAutoPhase: state.setAutoPhase,
        currentAngle: state.currentAngle,
        setPlotData: state.setPlotData,
        clearPlotData: state.clearPlotData,
        fetchRois: state.fetchRois
    })));

    // --- ステージ操作ロジックの取得 (Custom Hook) ---
    const {
        moveRelative,   // 相対移動
        moveAbsolute,   // 絶対移動
        homeStage,      // 原点復帰
        stopStage,      // 停止
        isSystemBusy    // ステージが動作中かどうか
    } = useStageActions();

    // --- ローカル状態の管理 ---

    // "idle": 未実施, "running": 実行中, "success": 成功（アライメント完了）, "saturated": 飽和警告あり完了, "failed": 失敗
    const [prescanStatus, setPrescanStatus] = useState<"idle" | "running" | "success" | "saturated" | "failed">("idle");
    
    // アライメント失敗時でも強制的に開始するためのフラグ
    const [forceStartUnlocked, setForceStartUnlocked] = useState(false);

    // Manual Remote (リモコン) パネル用の状態
    const [targetAngle, setTargetAngle] = useState<string>(""); // 絶対移動の入力値
    const [jogStep, setJogStep] = useState<number>(0.1);       // ジョグ操作の1クリックあたりの移動量

    // 測定進捗管理用の状態
    const [operationId, setOperationId] = useState<string | null>(null); // バックエンドでの非同期タスクID
    const [progressPercent, setProgressPercent] = useState<number>(0);   // 進捗率 (0-100)
    const [progressMessage, setProgressMessage] = useState<string>("");  // 現在の動作メッセージ
    const [hasWarning, setHasWarning] = useState<boolean>(false);        // 飽和などの警告状態
    const [warningMessage, setWarningMessage] = useState<string>("");    // 警告の具体的内容

    // 現在の測定（Pre-Scanから本番まで）で共通して使用するデータ保存先フォルダ
    const [currentBranchPath, setCurrentBranchPath] = useState<string | null>(null);

    // カテゴリが変更されたら保存先パスをリセットする
    useEffect(() => {
        setCurrentBranchPath(null);
    }, [selectedCategory]);

    // React Hook Form の初期化（Zodスキーマ連携）
    const form = useForm<SetupFormValues>({
        resolver: zodResolver(setupFormSchema) as any,
        defaultValues: {
            laserPower: "" as any,
            fiberX: "" as any,
            fiberY: "" as any,
            startAngle: 0,
            endAngle: 360,
            stepAngle: 5,
        },
    });

    // 戻るボタンの処理。測定やスキャンが走っている間は戻れないようにガードします。
    const handleBack = () => {
        if (isMeasuring || prescanStatus === "running") return;
        setAutoPhase('select_category');
    };

    // --- 角度範囲プリセットの連動ロジック ---
    // ホバー中のプリセットID（インライン説明バーでリアルタイム表示するため）
    const [hoveredPresetId, setHoveredPresetId] = useState<string | null>(null);

    // 現在の入力値をリアルタイムに監視し、いずれかの標準プリセットと一致しているかを判定します
    const watchedStartAngle = form.watch("startAngle");
    const watchedEndAngle = form.watch("endAngle");
    const watchedStepAngle = form.watch("stepAngle");

    // 入力値がプリセットと完全一致すればそのプリセットIDを返し、手動編集中であれば null (Custom) となります
    const activePresetId = DEFAULT_ANGLE_PRESETS.find(
        (p) =>
            Number(watchedStartAngle) === p.startAngle &&
            Number(watchedEndAngle) === p.endAngle &&
            Number(watchedStepAngle) === p.stepAngle
    )?.id ?? null;

    // インライン情報バーに表示するプリセット（ホバー中のものを最優先し、なければ現在選択中のプリセットを表示）
    const displayedPreset = DEFAULT_ANGLE_PRESETS.find(
        (p) => p.id === (hoveredPresetId ?? activePresetId)
    ) ?? null;

    /**
     * 角度範囲プリセットをフォームに適用する関数
     * 
     * 【技術的解説】
     * `form.setValue` を使用して、Start / End / Step の3つの値を一括で更新します。
     * `shouldValidate: true` を指定することで、値更新と同時にZodスキーマによるバリデーション（範囲チェック）を
     * 即座にトリガーし、エラー表示の更新やフォームの妥当性を最新状態に保ちます。
     * 
     * @param preset 適用する角度範囲プリセットオブジェクト
     */
    const applyPreset = (preset: AngleRangePreset) => {
        if (isMeasuring || prescanStatus === "running") return; // 測定中は操作をブロック
        form.setValue("startAngle", preset.startAngle, { shouldValidate: true, shouldDirty: true });
        form.setValue("endAngle", preset.endAngle, { shouldValidate: true, shouldDirty: true });
        form.setValue("stepAngle", preset.stepAngle, { shouldValidate: true, shouldDirty: true });
    };

    // ============================================================================
    // 進行状況の監視 (Progress Polling)
    // ============================================================================
    /**
     * バックエンドで実行されている非同期タスク（Pre-Scan または 本番測定）の進捗を監視します。
     * 
     * 【技術的解説】
     * 測定はバックグラウンドスレッドで実行されるため、フロントエンドは「今どこまで進んだか」を
     * 定期的に問い合わせる（ポーリング）必要があります。
     * この useEffect は operationId が発行された瞬間に起動し、0.5秒間隔で最新の進捗を取得します。
     * 完了・失敗・キャンセルなどの「最終状態」を検知した時点で、監視（setInterval）を停止し、
     * UI のロック解除やトースト通知を行います。
     */
    useEffect(() => {
        if (!operationId) return;

        const intervalId = setInterval(async () => {
            try {
                const res = await autoApi.getAutoMeasurementProgress(operationId);

                setProgressPercent(res.percent);
                setProgressMessage(res.message);
                
                // ============================================================================
                // 【非破壊的エラーハンドリング (Non-Destructive Error Handling)】
                // バックエンドから送られてくる `has_warning` フラグを監視します。
                // 飽和などを検知してもバックエンドは測定を止めず、このフラグだけを true にして送ってきます。
                // これを受け取ったフロントエンドは、プログレスバーをオレンジ色（Amber）に変化させ、
                // ユーザーに対して「止まってはいないが異常が起きている」ことを視覚的に警告します。
                // ============================================================================
                if (res.has_warning) {
                    setHasWarning(true);
                    setWarningMessage(res.warning_message || "Warning detected during measurement.");
                }

                // 完了・失敗・キャンセルのいずれかの「最終状態」に達したら監視を終了
                if (res.status === "succeeded" || res.status === "failed" || res.status === "cancelled") {
                    clearInterval(intervalId);
                    setOperationId(null);
                    setIsMeasuring(false); // 監視終了時にロックを解除
                    setIsPrescan(false);   // フェーズ情報をリセット

                    if (res.status === "succeeded") {
                        if (prescanStatus === "running") {
                            // ============================================================================
                            // 【Pre-Scan（アライメント）成功時の自動ROI同期と画面更新】
                            // Pre-Scan が正常に完了すると、バックエンド側で光の重心を元にした新しいROI座標が算出され、
                            // カメラコントローラ内のROIデータが自律的に更新されます。
                            //
                            // フロントエンド側の画面に表示されている枠線（SVG）や座標テーブルを、
                            // その新しく計算された重心に自動で追従（吸着）させるため、
                            // ここで `fetchRois()` 非同期アクションを呼び出してストア内のデータを更新します。
                            // 
                            // 呼び出し後に `rois` ステートが変更されると、Reactのリアクティブな仕組みにより
                            // `CameraPanel.tsx` コンポーネントが自動で検知して再描画を行い、
                            // 画面上の四角い枠線が新しい重心位置にスッと移動します。
                            // ============================================================================
                            await fetchRois();
                            if (res.has_warning) {
                                toast.warning("Pre-Scan completed with saturation warnings. Check exposure levels.");
                                setPrescanStatus("saturated");
                            } else {
                                toast.success("Pre-Scan completed successfully.");
                                setPrescanStatus("success");
                            }
                        } else {
                            toast.success("Measurement complete. Returning to category selection.");
                            // 測定完了後は、履歴をリフレッシュしてからカテゴリ選択画面へ戻る
                            if (currentSession?.folderPath) {
                                try {
                                    const settings = await autoApi.getSessionSettings(currentSession.folderPath);
                                    setCurrentSession({
                                        ...currentSession,
                                        settings: settings
                                    });
                                } catch (e) {
                                    console.error("Failed to refresh session history:", e);
                                }
                            }
                            setAutoPhase('select_category');
                        }
                    } else if (res.status === "cancelled") {
                        toast.info("Operation was cancelled.");
                        if (prescanStatus === "running") setPrescanStatus("idle");
                    } else {
                        toast.error(`Operation failed: ${res.message}`);
                        if (prescanStatus === "running") setPrescanStatus("failed");
                    }
                }
            } catch (error) {
                console.error("Progress poll failed", error);
            }
        }, 500); // 0.5秒ごとに確認

        return () => clearInterval(intervalId);
    }, [operationId, prescanStatus, fetchRois]);

    // ============================================================================
    // グラフデータの定期取得 (Plot Data Polling)
    // ============================================================================
    /**
     * 測定中にバックエンドのメモリバッファからグラフ用データを取得します。
     * 
     * 【技術的解説】
     * 「進捗（%）」の監視とは別に、グラフ描画用の生の数値データ（角度ごとの輝度等）を取得します。
     * 測定が走っている間（isMeasuring または prescanRunning）のみ動作し、
     * ストアの plotData を更新することで、隣接する GraphPanel コンポーネントがリアルタイムに再描画されます。
     */
    useEffect(() => {
        // 測定中（本番またはPre-Scan）のみポーリングを行う
        if (!isMeasuring && prescanStatus !== "running") return;

        const intervalId = setInterval(async () => {
            try {
                const data = await autoApi.getPlotData();
                setPlotData(data);
            } catch (error) {
                console.error("Failed to fetch plot data:", error);
            }
        }, 500);

        return () => clearInterval(intervalId);
    }, [isMeasuring, prescanStatus, setPlotData]);

    // ============================================================================
    // アクション・ハンドラ (実行ロジック)
    // ============================================================================

    /**
     * Pre-Scan (事前スキャン) の実行。
     * 
     * 【解説】
     * 本番測定の前に、荒い角度間隔（例: 15度）でスキャンを行い、光の強度が最も強い位置（ピーク）と
     * 最も弱い位置をサンプリングします。このデータを用いて、背景ノイズを除去した上で「重み付き平均」を計算し、
     * ROI（関心領域）の中心座標をサブピクセル精度で補正（オートセンタリング）します。
     * 
     * @param {SetupFormValues} values - ユーザーがフォームに入力した測定条件（レーザーパワー等）
     */
    const handlePreScan = async (values: SetupFormValues) => {
        if (!currentSession || !selectedCategory) return;

        setIsMeasuring(true); // ナビゲーションをロック
        setIsPrescan(true);   // Pre-Scan中であることを明示（グラフの自動切り替え用）
        setPrescanStatus("running");
        setForceStartUnlocked(false);
        setProgressPercent(0);
        setProgressMessage("Starting Pre-Scan...");
        setHasWarning(false);
        setWarningMessage("");

        try {
            // 前回のグラフデータをクリア
            await autoApi.resetPlotData();
            clearPlotData();

            // Pre-Scanですでにフォルダが作成されていればそれを使い、なければ新規作成する
            let targetPath = currentBranchPath;
            if (!targetPath) {
                const branchRes = await autoApi.generateBranch(currentSession.folderPath, selectedCategory);
                targetPath = branchRes.folder_path;
                setCurrentBranchPath(targetPath);
            }

            // バックエンドにPre-Scanタスクをリクエスト
            const runRes = await autoApi.runAutoMeasurement({
                start_angle: values.startAngle,
                end_angle: values.endAngle,
                step_angle: 15.0, // Pre-Scan は高速化のため15度固定で回す
                save_directory: targetPath,
                is_prescan: true,
                metadata: {
                    laser_power_mw: values.laserPower,
                    fiber_pos_x: values.fiberX ?? null,
                    fiber_pos_y: values.fiberY ?? null
                }
            });

            setOperationId(runRes.operation_id); // 監視を開始
            toast.success("Pre-Scan started.");
        } catch (error: any) {
            // ============================================================================
            // 【例外ハンドリングとUI状態のクリーンアップ】
            // バックエンドへのPre-Scan要求（HTTP POST）が通信エラーや例外で失敗した場合、
            // UIが「測定中」の状態のままロック（フリーズ）されるのを防止します。
            // 以下のフラグを即座に初期状態へ戻し、入力フォームやナビゲーションを再開放します。
            // ============================================================================
            console.error("Pre-Scan start failed", error);
            toast.error(error.message || "Failed to start Pre-Scan");
            setIsMeasuring(false); // UIのナビゲーションロックを解除（サイドバー等のディセーブル解除）
            setIsPrescan(false);   // Pre-Scanモードフラグをリセット
            setPrescanStatus("idle"); // 進捗ステータスを待機状態へ
        }
    };

    /**
     * 強制開始の有効化。
     * 
     * 【解説】
     * アライメント（Pre-Scan）が失敗した場合、通常は測定に進めません。
     * これは「光が弱すぎてノイズなのか粒子なのか分からない」といった安全装置ですが、
     * ユーザーが目視で「これで良い」と判断した場合に、この制限を強制解除するためのハンドラです。
     */
    const handleForceUnlock = () => {
        setForceStartUnlocked(true);
        toast.info("Force Start unlocked. Proceed with caution.");
    };

    /**
     * 本番測定 (START MEASUREMENT) の実行。
     * 
     * 【解説】
     * ユーザーが指定した開始角度から終了角度まで、細かいステップ角度でステージを回転させ、
     * 停止後に振動が収まるのを待ってから（0.3秒）、カメラの画像を撮影します。
     * 取得した画像からROIの輝度（Sum, Max）を計算し、逐次CSVに保存していきます。
     * 
     * @param {SetupFormValues} values - ユーザーがフォームに入力した測定条件
     */
    const handleStartMeasurement = async (values: SetupFormValues) => {
        if (!currentSession || !selectedCategory) return;

        setIsMeasuring(true); // ナビゲーションをロック（測定実行中はサイドバー等のページ移動を無効化します）
        setIsPrescan(false);  // 本番測定であることを明示（フロントエンドの表示やグラフ描画の自動切り替え判定に使用します）
        
        // ============================================================================
        // 【Pre-Scan 完了警告表示の動的クリア】
        // 本番測定を開始するにあたり、以前の Pre-Scan で検出されていた警告表示（アライメント
        // セクション内の Saturation Warning パネル）を画面上から綺麗に消去するために、
        // 完了状態（"saturated" または "success"）を一度未実施の "idle" にリセットします。
        // これを行わないと、本番測定中に発生した別の飽和警告（warningMessage の更新）が、
        // Pre-Scan用の古い警告文のエラー詳細エリアへ干渉してリアルタイム上書きされてしまうためです。
        // ============================================================================
        setPrescanStatus("idle"); 
        
        setProgressPercent(0);
        setProgressMessage("Starting Measurement...");
        setHasWarning(false);
        setWarningMessage("");

        try {
            // 前回のグラフデータをクリア
            await autoApi.resetPlotData();
            clearPlotData();

            // Pre-Scanですでにフォルダが作成されていればそれを使い、なければ新規作成する
            let targetPath = currentBranchPath;
            if (!targetPath) {
                const branchRes = await autoApi.generateBranch(currentSession.folderPath, selectedCategory);
                targetPath = branchRes.folder_path;
                setCurrentBranchPath(targetPath);
            }

            const runRes = await autoApi.runAutoMeasurement({
                start_angle: values.startAngle,
                end_angle: values.endAngle,
                step_angle: values.stepAngle,
                save_directory: targetPath,
                is_prescan: false,
                metadata: {
                    laser_power_mw: values.laserPower,
                    fiber_pos_x: values.fiberX ?? null,
                    fiber_pos_y: values.fiberY ?? null
                }
            });

            setOperationId(runRes.operation_id);
            toast.success("Measurement started.");
        } catch (error: any) {
            console.error("Measurement start failed", error);
            toast.error(error.message || "Failed to start measurement");
            setIsMeasuring(false);
        }
    };

    /**
     * 自動測定タスクの強制中断。
     * 
     * 【解説】
     * 実行中のPre-Scanまたは本番測定タスクを中断します。
     * バックエンドに対してキャンセルAPIを呼び出すと、物理ステージが安全に減速停止し、
     * 測定ループが中断されます。通常時は、ポーリング処理がバックエンドのキャンセル完了状態を
     * 検知してUIロックを解除しますが、API通信エラーや初期化失敗で監視タスク（operationId）が
     * 開始されなかった場合に備え、安全のための強制解除フォールバック処理を含んでいます。
     */
    const handleCancel = async () => {
        try {
            // バックエンドにキャンセル要求（HTTP POST）を送信します。
            // これにより、バックエンド側で物理ステージの停止処理（減速停止）が走り、
            // バックグラウンドで稼働している測定ループの状態が "cancelled" に移行します。
            await autoApi.cancelAutoMeasurement();
            setProgressMessage("Cancelling operation...");
            toast.info("Cancellation signal sent.");
        } catch (error: any) {
            // 通信障害等でキャンセルAPIの呼び出し自体が失敗した場合のエラーハンドリング。
            toast.error("Failed to cancel: " + (error.message || "Unknown error"));
        } finally {
            // ============================================================================
            // 【堅牢な状態管理とエラー復帰（クリーンアップ & 強制フォールバック）】
            // もし測定の開始時にAPIエラーが発生した等の理由で、進捗ポーリングのキーとなる
            // `operationId` が null（未割り当て）のままUIだけが「測定中」としてロックしてしまった場合、
            // ユーザーがCancelボタンを押すことで、フロントエンド側のロックを強制解除します。
            // これにより、通信トラブル時にもUIがフリーズしたままにならず、安全に入力画面へ戻れます。
            // ============================================================================
            if (!operationId) {
                setIsMeasuring(false); // フロントエンドの画面遷移ロックを解除
                setIsPrescan(false);   // Pre-Scanモードフラグをリセット
                if (prescanStatus === "running") {
                    setPrescanStatus("idle"); // Pre-Scanの実行ステータスを解除
                }
            }
        }
    };

    // --- 表示制御用の計算変数 ---
    // UIパーツの無効化条件: 測定中、またはPre-Scan実行中
    const isFormDisabled = isMeasuring || prescanStatus === "running";
    // 本番測定を開始できる条件: Pre-Scan成功（警告あり含む）、または強制解除済み
    const canStartMeasurement = prescanStatus === "success" || prescanStatus === "saturated" || forceStartUnlocked;

    return (
        <div className="flex flex-col h-full space-y-6">
            {/* ヘッダー領域: ナビゲーションと現在のコンテキスト表示 */}
            <div className="flex items-center justify-between border-b pb-4">
                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleBack}
                        disabled={isFormDisabled}
                        className="text-muted-foreground"
                    >
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Back
                    </Button>
                </div>
                
                <div className="text-right space-y-1">
                    {/* 現在アクティブなサンプル（セッション）名 */}
                    <div className="flex items-center gap-2 justify-end text-muted-foreground">
                        <FolderOpen className="size-3 text-amber-500/80" />
                        <span className="font-mono font-bold text-[10px] truncate max-w-[120px]">
                            {currentSession?.sampleName}
                        </span>
                    </div>
                    {/* 選択中の測定カテゴリ */}
                    <div className="text-[10px] font-bold px-2 py-0.5 bg-secondary rounded-full inline-block uppercase tracking-wider">
                        {selectedCategory?.replace('_', ' ')}
                    </div>
                </div>
            </div>

            {/* メインスクロールエリア: 設定フォーム */}
            <div className="flex-1 overflow-y-auto pr-6 space-y-8 pb-10">
                
                {/* 1. メタデータセクション */}
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                            1. Metadata
                        </h4>
                    </div>
                    <div className="space-y-4 p-4 border rounded-lg bg-card">
                        {/* レーザーパワー: 必須項目 */}
                        <Field>
                            <div className="flex items-center justify-between mb-1.5">
                                <FieldLabel className="mb-0">Laser Power (mW)</FieldLabel>
                                <Badge variant="default" className="text-[8px] h-4 px-1.5 uppercase font-bold leading-none">Required</Badge>
                            </div>
                            <Input
                                type="number"
                                step="0.1"
                                disabled={isFormDisabled}
                                {...form.register("laserPower")}
                            />
                            <FieldError errors={[form.formState.errors.laserPower as any]} />
                        </Field>

                        <Separator className="opacity-50" />

                        {/* ファイバー位置: 任意項目（備考として記録） */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-tight">
                                    Fiber Position
                                </span>
                                <Badge variant="outline" className="text-[7px] h-3.5 px-1 uppercase font-medium text-muted-foreground border-muted-foreground/30">Optional</Badge>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <Field>
                                    <FieldLabel className="text-[11px]">X-Axis</FieldLabel>
                                    <Input
                                        type="number"
                                        placeholder="0"
                                        className="h-8 text-xs"
                                        disabled={isFormDisabled}
                                        {...form.register("fiberX")}
                                    />
                                    <FieldError errors={[form.formState.errors.fiberX as any]} />
                                </Field>
                                <Field>
                                    <FieldLabel className="text-[11px]">Y-Axis</FieldLabel>
                                    <Input
                                        type="number"
                                        placeholder="0"
                                        className="h-8 text-xs"
                                        disabled={isFormDisabled}
                                        {...form.register("fiberY")}
                                    />
                                    <FieldError errors={[form.formState.errors.fiberY as any]} />
                                </Field>
                            </div>
                        </div>
                    </div>
                </div>

                {/* 2. 角度範囲セクション: 測定の開始角・終了角・ステップ角の設定 */}
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                            2. Angle Range
                        </h4>
                        <Badge variant="default" className="text-[8px] h-4 px-1.5 uppercase font-bold">Required</Badge>
                    </div>

                    <div className="space-y-4 p-4 border rounded-lg bg-card">
                        {/* 角度範囲プリセット選択エリア: よく使う測定条件を1クリックで一括入力 */}
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <Label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-tight flex items-center gap-1.5">
                                    <SlidersHorizontal className="w-3 h-3 text-primary" />
                                    Quick Presets
                                </Label>
                                {activePresetId ? (
                                    <Badge variant="secondary" className="text-[9px] h-4 px-1.5 font-mono font-normal">
                                        {DEFAULT_ANGLE_PRESETS.find(p => p.id === activePresetId)?.points} points
                                    </Badge>
                                ) : (
                                    <Badge variant="outline" className="text-[9px] h-4 px-1.5 font-mono font-normal text-muted-foreground">
                                        Custom
                                    </Badge>
                                )}
                            </div>

                            {/* プリセットボタングループ: ツールチップを廃止し、クリック＆ホバーで即時連動 */}
                            <div className="flex flex-wrap gap-1.5">
                                {DEFAULT_ANGLE_PRESETS.map((preset) => {
                                    const isActive = activePresetId === preset.id;
                                    {/* 
                                        レスポンシブ余白設定:
                                        - `px-3`: 左右に最低 12px (計 24px) の美しい余白を確保。
                                        - `min-w-fit`: パネル幅が狭くなった際、文字幅＋余白を下回って押し潰されるのを防止し、次の行へ自然に折り返します。
                                        - `flex-1`: 横幅に余裕があるときは等幅に美しく広がります。
                                    */}
                                    return (
                                        <Button
                                            key={preset.id}
                                            type="button"
                                            variant={isActive ? "default" : "outline"}
                                            size="sm"
                                            disabled={isFormDisabled}
                                            onClick={() => applyPreset(preset)}
                                            onMouseEnter={() => setHoveredPresetId(preset.id)}
                                            onMouseLeave={() => setHoveredPresetId(null)}
                                            className={`h-7 px-3 text-[11px] font-medium whitespace-nowrap transition-all flex-1 min-w-fit ${
                                                isActive 
                                                    ? "shadow-sm font-bold bg-primary text-primary-foreground" 
                                                    : "hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                                            }`}
                                        >
                                            {preset.name}
                                        </Button>
                                    );
                                })}
                            </div>

                            {/* インライン動的説明バー: プリセット時・カスタム時ともに完全同一の高さ（2行分説明）を保証 */}
                            {(() => {
                                const isCurrentActive = displayedPreset && activePresetId === displayedPreset.id;
                                const isPreviewingOther = hoveredPresetId !== null && hoveredPresetId !== activePresetId;

                                return (
                                    <div className={cn(
                                        "min-h-[72px] p-2.5 rounded-md border text-xs flex items-start gap-2.5 transition-colors",
                                        isPreviewingOther 
                                            ? "bg-primary/5 border-primary/40 shadow-xs" 
                                            : "bg-muted/40 border-border/50"
                                    )}>
                                        <Info className={cn(
                                            "w-4 h-4 shrink-0 mt-0.5 transition-colors", 
                                            isPreviewingOther ? "text-primary" : isCurrentActive ? "text-emerald-500" : "text-muted-foreground"
                                        )} />
                                        
                                        <div className="flex-1 space-y-1 min-w-0">
                                            {displayedPreset ? (
                                                <>
                                                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-foreground font-semibold text-xs">
                                                                {displayedPreset.name}
                                                            </span>
                                                            {/* ステータスバッジ: 選択中のものはホバーしてもActiveのまま維持 */}
                                                            {isCurrentActive ? (
                                                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 shrink-0">
                                                                    Active
                                                                </Badge>
                                                            ) : isPreviewingOther ? (
                                                                <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium text-primary border-primary/40 bg-primary/10 shrink-0">
                                                                    Preview
                                                                </Badge>
                                                            ) : null}
                                                        </div>

                                                        <span className="text-primary font-mono text-[11px] font-medium shrink-0">
                                                            {displayedPreset.startAngle}° → {displayedPreset.endAngle}° ({displayedPreset.points} pts)
                                                        </span>
                                                    </div>
                                                    <p className="text-muted-foreground text-[11px] leading-relaxed break-words min-h-[32px]">
                                                        {displayedPreset.description}
                                                    </p>
                                                </>
                                            ) : (
                                                <>
                                                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-foreground font-semibold text-xs">
                                                                Custom Range
                                                            </span>
                                                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium text-muted-foreground shrink-0">
                                                                Custom
                                                            </Badge>
                                                        </div>

                                                        <span className="text-muted-foreground font-mono text-[11px] font-medium shrink-0">
                                                            {watchedStartAngle}° → {watchedEndAngle}° (Step {watchedStepAngle}°)
                                                        </span>
                                                    </div>
                                                    <p className="text-muted-foreground text-[11px] leading-relaxed break-words min-h-[32px]">
                                                        手動入力されたカスタム設定です。開始・終了・ステップ角度を下の各フィールドで自由に微調整して測定できます。
                                                    </p>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })()}
                        </div>

                        <Separator className="opacity-50" />

                        {/* 手動入力フィールド: Start, End, Step */}
                        <div className="grid grid-cols-2 gap-4">
                            {/* 開始角度 */}
                            <Field>
                                <FieldLabel>Start (°)</FieldLabel>
                                <Input
                                    type="number"
                                    step="1"
                                    disabled={isFormDisabled}
                                    {...form.register("startAngle")}
                                />
                                <FieldError errors={[form.formState.errors.startAngle as any]} />
                            </Field>

                            {/* 終了角度 */}
                            <Field>
                                <FieldLabel>End (°)</FieldLabel>
                                <Input
                                    type="number"
                                    step="1"
                                    disabled={isFormDisabled}
                                    {...form.register("endAngle")}
                                />
                                <FieldError errors={[form.formState.errors.endAngle as any]} />
                            </Field>

                            {/* ステップ角度 */}
                            <Field className="col-span-2">
                                <FieldLabel>Step (°)</FieldLabel>
                                <Input
                                    type="number"
                                    step="0.1"
                                    disabled={isFormDisabled}
                                    {...form.register("stepAngle")}
                                />
                                <FieldDescription>Minimum resolution is 0.0025°</FieldDescription>
                                <FieldError errors={[form.formState.errors.stepAngle as any]} />
                            </Field>
                        </div>
                    </div>
                </div>

                {/* 3. アライメント（Pre-Scan）セクション */}
                <div className="space-y-4">
                    <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                        <span>3. Alignment</span>
                        {/* スキャン完了時のステータスバッジ */}
                        {prescanStatus === "success" && <span className="text-green-500 text-xs font-bold flex items-center"><Scan className="w-3 h-3 mr-1" /> Ready</span>}
                        {prescanStatus === "saturated" && <span className="text-amber-500 text-xs font-bold flex items-center"><AlertCircle className="w-3.5 h-3.5 mr-1 text-amber-500" /> Saturated</span>}
                        {prescanStatus === "failed" && <span className="text-destructive text-xs font-bold flex items-center"><AlertCircle className="w-3 h-3 mr-1" /> Failed</span>}
                    </h4>

                    <div className="p-4 border rounded-lg bg-card space-y-4">
                        <p className="text-xs text-muted-foreground leading-relaxed">
                            Roughly align the ROI(s) manually on the camera view, then run Pre-Scan to calculate the exact optical centroid.
                        </p>

                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="w-full"
                            disabled={isFormDisabled}
                            onClick={form.handleSubmit(handlePreScan)}
                        >
                            {prescanStatus === "running" ? (
                                <RefreshCcw className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                                <Scan className="w-4 h-4 mr-2" />
                            )}
                            {prescanStatus === "running" ? "Scanning..." : "Run Pre-Scan"}
                        </Button>

                        {/* 
                          * 【アライメント警告パネル (Saturation Warning Panel)】
                          * Pre-Scan実行中にカメラの飽和（白飛び）を検知した場合に、注意喚起を促すために表示します。
                          * スキャンが完了した後も本番測定が開始されるまで画面に残り続け、自動測定への自動移行を
                          * 抑止し、ユーザーに露光時間やゲインの再設定を促す「安全上のセーフガード」として機能します。
                          * 本番測定（START MEASUREMENT）が押された時点で、上の handleStartMeasurement() 内で
                          * ステータスが idle にリセットされ、このパネルは自動的に非表示になります。
                          */}
                        {prescanStatus === "saturated" && (
                            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-md flex flex-col gap-1.5 text-xs text-amber-600 font-medium leading-normal">
                                <div className="flex items-start">
                                    <AlertTriangle className="w-3.5 h-3.5 mr-1.5 mt-0.5 shrink-0 text-amber-500" />
                                    <span className="font-bold">Saturation Warning</span>
                                </div>
                                <p className="text-[10px] text-muted-foreground leading-snug">
                                    Pre-Scanの過程で光の飽和が検出されました。露光時間（Exposure）やゲイン（Gain）を下げて再調整することをお勧めします。このまま本番測定に進むことも可能ですが、正確な強度評価が行えない可能性があります。
                                </p>
                                {warningMessage && (
                                    <p className="text-[10px] font-mono break-all bg-amber-500/5 p-1.5 rounded border border-amber-500/10 text-amber-700">
                                        {warningMessage}
                                    </p>
                                )}
                            </div>
                        )}

                        {/* 失敗時のみ表示される救済措置（強制開始） */}
                        {prescanStatus === "failed" && !forceStartUnlocked && (
                            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md flex flex-col gap-3">
                                <p className="text-xs text-destructive font-medium leading-tight">
                                    Alignment failed. Check if the signal is saturated or too weak.
                                </p>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    size="sm"
                                    className="w-full text-xs h-auto py-1.5 whitespace-normal"
                                    onClick={handleForceUnlock}
                                >
                                    Force Proceed
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* 下部固定エリア: 本番実行ボタンとリモコン */}
            <div className="pt-4 border-t mt-auto bg-card">
                {!isMeasuring && prescanStatus !== "running" ? (
                    <div className="flex gap-2">
                        {/* 手動操作リモコン (Manual Remote) ポップオーバー */}
                        <Popover>
                            <TooltipProvider>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <PopoverTrigger asChild>
                                            <Button 
                                                variant="outline" 
                                                size="icon" 
                                                className="h-10 w-10 shrink-0 hover:border-primary/50"
                                                disabled={isSystemBusy}
                                            >
                                                <Joystick className="h-5 w-5 text-muted-foreground" />
                                            </Button>
                                        </PopoverTrigger>
                                    </TooltipTrigger>
                                    <TooltipContent className="font-semibold">
                                        Manual Remote
                                    </TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                            <PopoverContent side="top" align="start" className="w-64 p-4 mb-2 shadow-xl border-primary/20">
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <h5 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Manual Remote</h5>
                                        <Badge variant="secondary" className="font-mono text-[9px]">{currentAngle.toFixed(3)}°</Badge>
                                    </div>

                                    {/* 絶対移動セクション */}
                                    <div className="space-y-1.5">
                                        <Label className="text-[9px] uppercase text-muted-foreground">Absolute Move</Label>
                                        <div className="flex gap-1.5">
                                            <Input
                                                className="h-8 text-xs font-mono"
                                                placeholder="0.00"
                                                value={targetAngle}
                                                onChange={(e) => setTargetAngle(e.target.value)}
                                                onKeyDown={(e) => e.key === 'Enter' && moveAbsolute(parseFloat(targetAngle))}
                                            />
                                            <Button
                                                size="icon"
                                                className="h-8 w-8 shrink-0"
                                                disabled={isSystemBusy || !targetAngle}
                                                onClick={() => moveAbsolute(parseFloat(targetAngle))}
                                            >
                                                <MoveRight className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </div>

                                    <Separator />

                                    {/* ジョグ操作セクション */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <Label className="text-[9px] uppercase text-muted-foreground">Jog Step</Label>
                                            <Tabs value={String(jogStep)} onValueChange={(v) => setJogStep(parseFloat(v))} className="h-7">
                                                <TabsList className="h-7 p-0.5">
                                                {[0.1, 1, 5].map((s) => (
                                                     <TabsTrigger
                                                         key={s} value={String(s)}
                                                         className="text-[9px] h-6 px-2"
                                                    >
                                                        {s}°
                                                     </TabsTrigger>
                                                ))}
                                                </TabsList>
                                            </Tabs>
                                        </div>
                                        {/* ジョグボタン群: [マイナス] [Home] [プラス] */}
                                        <div className="flex gap-2">
                                            <Button variant="outline" size="sm" className="h-8 flex-1" onClick={() => moveRelative(-jogStep)} disabled={isSystemBusy}>
                                                <Minus className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button variant="outline" size="sm" className="h-8 flex-1" onClick={() => homeStage()} disabled={isSystemBusy}>
                                                <House className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button variant="outline" size="sm" className="h-8 flex-1" onClick={() => moveRelative(jogStep)} disabled={isSystemBusy}>
                                                <Plus className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </div>

                                    <Separator />

                                    {/* 非常用・クイック停止ボタン */}
                                    <Button 
                                        variant="destructive" 
                                        size="sm" 
                                        className="w-full h-8 font-bold shadow-inner" 
                                        onClick={() => stopStage(false)}
                                    >
                                        <Square className="h-3 w-3 fill-current mr-2" /> STOP STAGE
                                    </Button>
                                </div>
                            </PopoverContent>
                        </Popover>

                        {/* 本番測定開始ボタン */}
                        <Button
                            type="button"
                            className="flex-1 font-bold shadow-lg h-10"
                            disabled={!canStartMeasurement}
                            onClick={form.handleSubmit(handleStartMeasurement)}
                        >
                            <Play className="w-4 h-4 mr-2" />
                            START MEASUREMENT
                        </Button>
                    </div>
                ) : (
                    /* 動作中のプログレス表示と中止ボタン */
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <div className="flex justify-between text-xs font-medium mb-1">
                                <span className="text-muted-foreground truncate pr-4">{progressMessage}</span>
                                <span>{progressPercent}%</span>
                            </div>
                            
                            {/* 
                              * 飽和などの警告がある場合の表示領域 
                              * `whitespace-normal break-words` を指定することで、飽和した角度（15.0°, 30.0°...）が
                              * 多数リストアップされた場合でも、サイドバーの横幅を突き破らずに安全に改行されるようにしています。
                              */}
                            {hasWarning && (
                                <div className="text-xs text-amber-500 font-bold mb-2 flex items-start leading-tight">
                                    <AlertTriangle className="w-3 h-3 mr-1 mt-0.5 shrink-0" />
                                    <span className="whitespace-normal break-words">{warningMessage}</span>
                                </div>
                            )}
                            
                            <Progress value={progressPercent} className={`h-2 ${hasWarning ? "[&>div]:bg-amber-500" : ""}`} />
                        </div>
                        <Button
                            type="button"
                            variant="destructive"
                            className="w-full font-bold shadow-inner"
                            onClick={handleCancel}
                        >
                            <XCircle className="w-4 h-4 mr-2" />
                            CANCEL MEASUREMENT
                        </Button>
                    </div>
                )}
            </div>

        </div>
    );
}

