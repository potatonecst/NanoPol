import { useState, useRef, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store/useAppStore";
import { stageApi, systemApi } from "@/api/client";
import { manualControlSchema, angleInputSchema, sweepParamsSchema } from "@/schemas/manualControlSchema";
import { z } from "zod";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { toast } from "sonner"

import {
    Plus, Minus, House,
    MoveRight, Play,
    Square,
    RefreshCw,
    TriangleAlert, Video,
} from "lucide-react";
import { CameraPanel } from "../shared/CameraPanel";

/**
 * マニュアル操作画面 (Manual View) コンポーネント
 *
 * ユーザーがステージの直接操作（ステップ移動、絶対・相対移動、原点復帰）や、
 * 単純なスイープ測定（指定範囲の連続駆動と自動録画）を行うための画面です。
 *
 * 【主な機能】
 * - Step / Absolute: 任意の角度への移動。
 * - Sweep: StartからEndへの等速移動。助走区間の自動計算や動画の自動録画タイマー機能を含む。
 * - Polling: ステージの動作中はバックエンドを監視し、UIをロックして二重操作を防ぐ。
 */
export function ManualView() {
    const {
        isStageConnected,
        currentAngle, setCurrentAngle,
        isSystemBusy,
        setIsSystemBusy,
        isRecording,
        stageSettings,
    } = useAppStore(useShallow((state) => ({
        isStageConnected: state.isStageConnected,
        currentAngle: state.currentAngle,
        setCurrentAngle: state.setCurrentAngle,
        isSystemBusy: state.isSystemBusy,
        setIsSystemBusy: state.setIsSystemBusy,
        isRecording: state.isRecording,
        stageSettings: state.stageSettings,
    })));

    /**
     * 停止シグナル管理用フラグ (Ref)
     * 
     * 【useStateではなくuseRefを使う理由】
     * 非同期処理（ポーリングのループ中など）から参照する際、useStateだと古い値（クロージャ）を参照してしまうことがありますが、
     * `useRef.current` はメモリ上の同じ場所を直接見に行くため、常に最新の値を参照でき、割り込み停止フラグに最適です。
     */
    const stopSignal = useRef(false);

    //Step Move用
    const [moveStep, setMoveStep] = useState("5.0"); //Step Moveのステップ量

    //Absolute Move用
    const [targetAngle, setTargetAngle] = useState(""); //任意角度入力用

    //Sweep用
    const [sweepStart, setSweepStart] = useState("0");
    const [sweepEnd, setSweepEnd] = useState("360");
    const [sweepSpeed, setSweepSpeed] = useState("10"); //[deg/s]
    const [isSweeping, setIsSweeping] = useState(false);
    const [autoRecord, setAutoRecord] = useState(false); // 自動録画のON/OFF
    // Sweep の progress API から受け取った状態を、そのまま UI に表示するためのキャッシュ。
    // operationId / phase / percent / message / remainingMs をまとめて持たせておくことで、
    // 進捗バー、残り時間、状態文言を同じ source of truth から描画できます。
    const [sweepProgress, setSweepProgress] = useState<{
        operationId: string | null;
        phase: string;
        percent: number;
        message: string;
        remainingMs: number;
    } | null>(null);

    // 予約タイマーや progress polling の interval は、停止・終了・破棄時に必ず止める必要があります。
    // そのため React state ではなく ref に保持して、どのタイミングでも即座に clear できるようにしています。
    const sweepProgressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const sweepOperationId = useRef<string | null>(null);

    // Zodによるバリデーション
    const stepVal = angleInputSchema.safeParse(moveStep);
    const targetVal = angleInputSchema.safeParse(targetAngle);
    const sweepStartVal = angleInputSchema.safeParse(sweepStart);
    const sweepEndVal = angleInputSchema.safeParse(sweepEnd);
    const sweepSpeedVal = manualControlSchema.shape.sweepSpeed.safeParse(sweepSpeed);

    // スイープ全体の相関バリデーション（0.2秒制限など）を実行
    // スイープに関係ない項目（targetAngleなど）を除いた専用スキーマでチェック
    const sweepFullVal = sweepParamsSchema.safeParse({
        sweepStart,
        sweepEnd,
        sweepSpeed,
    });

    // Note: Detailed trace logs were removed to avoid flooding the log store.
    // Keep high-level `systemApi.postLogs` for important events only.

    /**
     * ステージの動作完了を監視（ポーリング）する非同期関数。
     *
     * バックエンドの `/stage/position` APIを定期的に呼び出し、`is_busy` フラグが false になるまで待機します。
     * JavaScriptのシングルスレッド環境でUIをフリーズさせないために `Promise` と `setInterval` を使用しています。
     * 
     * （JavaScriptはシングルスレッドなので、while(true)でループすると画面がフリーズしてしまいます。そのため、setIntervalを使って「0.5秒ごとにバックエンドに問い合わせる」処理をPromiseで包みます。）
     * 
     * タイムアウト処理: 装置トラブル等で永遠にBusyの場合に備え、最大待機時間を設けます。
     * 
     * エラーリトライ: 一瞬の通信エラーで即座に失敗扱いにならないよう、連続エラーを数回許容します。
     * 
     * @param timeoutMs - タイムアウトまでの最大待機時間（ミリ秒）。Sweep測定などの長時間の動作も考慮し、デフォルトは300秒(5分)。
     * @returns 動作完了時（is_busyがfalse）に resolve される Promise。通信エラーの連続やタイムアウト時は reject されます。
     */
    const waitForIdle = async (timeoutMs = 300000) => { // デフォルト5分(300000ms)
        const startTime = Date.now();
        let errorCount = 0;
        const MAX_ERRORS = 5; // 連続5回（約2.5秒）のエラーまでは許容する

        // start waiting for idle

        return new Promise<void>((resolve, reject) => {
            const checkInterval = setInterval(async () => {
                // 1. タイムアウトチェック
                // 指定時間（timeoutMs）を経過しても終わらない場合は、強制的にエラーとして終了させます。
                if (Date.now() - startTime > timeoutMs) {
                    clearInterval(checkInterval);
                    reject(new Error("Timeout: Stage operation took too long."));
                    return;
                }

                try {
                    // バックエンドに今の状況（角度とBusy状態）を尋ねる
                    const res = await stageApi.getPosition();

                    // polling; update handled below

                    // 正常に取得できたら、エラーカウントをリセットします
                    errorCount = 0;

                    setCurrentAngle(res.current_angle);

                    // is_busyがfalseになったら移動完了とみなす
                    if (!res.is_busy) {
                        clearInterval(checkInterval); //タイマーを止めて待機完了にする
                        // resolved
                        resolve(); // Promiseを解決（await waitForIdle() がここで終わる）
                    }
                } catch (e) {
                    // 通信エラー等が発生した場合
                    errorCount++;
                    console.warn(`Polling error (${errorCount}/${MAX_ERRORS}):`, e);

                    // 許容回数を超えて連続でエラーが出た場合のみ、本当のエラーとして処理します。
                    // これにより、一時的なネットワークの瞬断などで処理が止まるのを防ぎます。
                    if (errorCount >= MAX_ERRORS) {
                        clearInterval(checkInterval); //エラーが起きたら止める
                        reject(new Error("Connection lost with stage controller."));
                    }
                }
            }, 500) // 500ms = 0.5秒ごとに実行
        })
    }

    // backend の sweep/progress ポーリングを止める共通関数。
    // 不要な interval が残ると、画面遷移後も API を叩き続けてしまうため、
    // sweep の終了処理・失敗処理・アンマウント処理で必ず通します。
    const clearSweepProgressPolling = () => {
        if (sweepProgressTimer.current) {
            clearInterval(sweepProgressTimer.current);
            sweepProgressTimer.current = null;
        }
    };

    // sweep の正常終了・キャンセル・失敗で共通に通る後始末。
    // ここで UI 状態、録画、タイマー、進捗表示をまとめて片付けることで、
    // 個別の分岐で同じ片付け処理を重複させないようにしています。
    const finishSweepSession = async (message: string, level: "success" | "warning" | "error" = "success") => {
        clearSweepProgressPolling();
        sweepOperationId.current = null;
        setIsSweeping(false);
        setIsSystemBusy(false);
        setSweepProgress(null);

        if (level === "success") {
            toast.success(message);
            systemApi.postLogs("INFO", message).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } else if (level === "warning") {
            toast.warning(message);
            systemApi.postLogs("WARNING", message).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } else {
            toast.error(message);
            systemApi.postLogs("ERROR", message).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        }
    };

    useEffect(() => {
        // コンポーネントが破棄される瞬間に、残っている interval / timeout を止める。
        // これをしないと、unmount 後も state 更新が走って React 警告の原因になります。
        return () => {
            clearSweepProgressPolling();
        };
    }, []);

    // 接続状態の同期
    // ステージが接続された時、または再接続された時に、現在の角度を取得しに行きます。
    // もしバックエンドがまだ動いていたら（Busy）、終わるまでロックします。
    useEffect(() => {
        const syncStatus = async () => {
            if (!isStageConnected) return;

            try {
                const res = await stageApi.getPosition();
                setCurrentAngle(res.current_angle);

                //もしバックエンドがbusyなら、UIをロック
                if (res.is_busy) {
                    setIsSystemBusy(true);

                    //アイドルになるまで監視（復帰処理）
                    await waitForIdle();

                    setIsSystemBusy(false);
                    toast.success("Operation Finished (Recovered)");
                    systemApi.postLogs("INFO", "Operation Finished (Recovered)").catch((e) => console.debug("※ログ送信も失敗しました:", e));
                }
            } catch (e) {
                console.error("Status sync failed", e);
            }
        };
        syncStatus();
    }, [isStageConnected]) //接続状態が変わったときもチェック

    /**
     * 各種移動操作の共通ラッパー関数。
     *
     * 移動コマンドの実行、UIのロック（Busy状態）、動作完了の待機(waitForIdle)、
     * および成功・失敗・中断時のユーザー通知（トースト）処理を一元管理します。
     *
     * @param actionName - ログやトーストに表示するアクション名（例: "Step Move", "Homing"）
     * @param moveFn - 実際にバックエンドのAPIを呼び出して移動を開始させる非同期関数
     */
    const performMove = async (actionName: string, moveFn: () => Promise<void>) => {
        if (isSystemBusy) return; // 既に動いている場合は二重実行防止
        // perform move start
        setIsSystemBusy(true); // UI全体をロック（ボタンを押せなくする）
        stopSignal.current = false; // 停止シグナルをリセット

        try {
            // executing moveFn
            await moveFn(); // 実際の移動コマンドを実行
            // waiting for idle
            await waitForIdle(); // 移動が終わるまでここで待機（ポーリング開始）

            // idle confirmed

            if (stopSignal.current) {
                toast.warning(`${actionName} Stopped`);
                systemApi.postLogs("WARNING", `${actionName} Stopped by user`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
            } else {
                toast.success(`${actionName} Complete`);
                systemApi.postLogs("INFO", `${actionName} Complete`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
            }
        } catch (e) {
            console.error(e);
            toast.error(`${actionName} Failed`);
            systemApi.postLogs("ERROR", `${actionName} Failed: ${e}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } finally {
                // finally unlock
            setIsSystemBusy(false); // 処理が終わったら（成功でも失敗でも）ロック解除
        }
    }

    /**
     * 相対移動（Jog操作）
     * @param direction - +1 ならプラス方向、-1 ならマイナス方向に移動します。
     */
    const rotateStage = (direction: 1 | -1) => {
        performMove("Step Move", async () => {
            const target = Number(moveStep) * direction;

            // rotateStage request

            await stageApi.moveRelative(target);
            // rotateStage response
        })
    }

    /**
     * 原点復帰（Homing）: 機械的な0点（センサー位置）を探しに行きます。
     */
    const goOrigin = () => {
        performMove("Homing", async () => {
            toast.info("Homing...");
            // homing request
            await stageApi.home();
            // homing response
            //toast.success("Home position reached");
        })
    }

    /**
     * 絶対移動: 入力された特定の角度（Target）へ直接移動します。
     */
    const handleMoveTo = async () => {
        const val = parseFloat(targetAngle);
        if (isNaN(val)) return;

        performMove("Absolute Move", async () => {
            toast.info(`Moving to ${val}°...`);
            // absolute move request
            await stageApi.moveAbsolute(val);
            // absolute move response
        })
    }

    /**
     * スイープ動作（連続移動）の実行シーケンス。
     *
     * 指定された開始角度(Start)から終了角度(End)まで、指定された速度(Speed)で等速移動します。
     *
     * 【内部シーケンス】
     * 1. 速度と入力値のバリデーション（ハードウェアのPPS制約に合わせて丸め込み）。
     * 2. 等速移動を担保するための「助走位置（Approach Margin）」の物理計算。
     * 3. 助走位置への移動と待機。
     * 4. （自動録画ONの場合）等速移動区間に合わせたカメラの録画開始・停止タイマーのセット。
     * 5. 終了位置への移動（スイープ本番）と待機。
     * 6. 完了後、速度設定をデフォルトに復帰させる。
     */
    const handleSweep = async () => {
        const { pulsesPerDegree } = stageSettings;

        // sweepSpeed は UI 入力の文字列から、バックエンドへ送る速度値に変換されます。
        // ここではステップ分解能に合わせて PPS 単位に丸め、機械が受け入れやすい値にしています。
        const speedSchema = z.coerce.number()
            .positive()
            .transform((val) => {
                const pps = Math.floor(val * pulsesPerDegree);
                if (pps % 100 !== 0) {
                    const roundedPPS = Math.round(pps / 100) * 100;
                    const safePPS = Math.max(100, roundedPPS);
                    const adjustedSpeed = safePPS / pulsesPerDegree;
                    return { speed: adjustedSpeed, pps: safePPS, isAdjusted: true };
                }
                return { speed: val, pps, isAdjusted: false };
            });

        const speedResult = speedSchema.safeParse(sweepSpeed);

        if (!sweepStartVal.success || !sweepEndVal.success || !speedResult.success) {
            toast.error("Invalid input values");
            systemApi.postLogs("ERROR", "Sweep validation failed: Invalid input values").catch((e) => console.debug("※ログ送信も失敗しました:", e));
            return;
        }

        const start = Number(sweepStartVal.data);
        const end = Number(sweepEndVal.data);
        const { speed: requestedSpeedDeg, pps: rawPPS, isAdjusted } = speedResult.data;

        if (isSystemBusy) return;

        // 手動録画（ヘッダーからの操作など）が既に進行中の場合は、
        // スイープに伴う自動録画やファイル書き込みの競合を防ぐため、スイープ開始をブロックします。
        if (isRecording) {
            toast.error("Please stop manual recording before starting a sweep.");
            systemApi.postLogs("WARNING", "Sweep rejected: Manual recording is already in progress.").catch((e) => console.debug("※ログ送信も失敗しました:", e));
            return;
        }

        setIsSystemBusy(true);
        setIsSweeping(true);
        setSweepProgress(null);
        stopSignal.current = false;
        clearSweepProgressPolling();

        try {
            // 速度が丸められた場合は、実際に使われる速度をユーザーへ明示する。
            if (isAdjusted) {
                toast.warning(`Speed adjusted to ${rawPPS} PPS to match 100PPS unit.`);
                systemApi.postLogs("WARNING", `Sweep speed adjusted to ${rawPPS} PPS to match 100PPS unit.`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
            }

            // フロントはもはや sweep を自前で走らせず、バックエンドへ計画(start/end/speed/autoRecord)を渡して委譲する。
            // ここで返る operation_id が、その後の progress ポーリングのキーになる。
            toast.info(`Starting sweep from ${start}° to ${end}°...`);
            systemApi.postLogs("INFO", `Sweep requested from ${start}° to ${end}°`).catch((e) => console.debug("※ログ送信も失敗しました:", e));

            const response = await stageApi.sweepRun(start, end, requestedSpeedDeg, autoRecord);
            sweepOperationId.current = response.operation_id;
            // 進捗バーは backend の plan を初期表示として使う。
            // ここではまだ実機の動作は始まっていないので、prepare 相当の状態を描画するだけに留める。
            setSweepProgress({
                operationId: response.operation_id,
                phase: "prepare",
                percent: 0,
                message: "Preparing sweep",
                remainingMs: response.plan.estimated_approach_ms,
            });

            // progress API を 0.5 秒ごとに問い合わせ、percent / remaining / phase を UI に反映する。
            // polling は backend の sweepOperationId に紐づくので、複数 sweep の取り違えを防げる。
            let pollErrorCount = 0;
            sweepProgressTimer.current = setInterval(async () => {
                const operationId = sweepOperationId.current;
                if (!operationId) return;

                try {
                    // backend の progress は、今の phase・進捗率・残り時間・表示メッセージを返す。
                    // ここではそれをそのまま UI state に落として描画するだけにしている。
                    const progress = await stageApi.sweepProgress(operationId);
                    pollErrorCount = 0;

                    setCurrentAngle(progress.current_deg);
                    setSweepProgress({
                        operationId: progress.operation_id,
                        phase: progress.phase,
                        percent: progress.percent,
                        message: progress.message,
                        remainingMs: progress.estimated_remaining_ms,
                    });

                    if (progress.status !== "running") {
                        // backend が running 以外を返したら、その時点で sweep セッションの片付けへ進む。
                        // ここで finishSweepSession を通すと、タイマー・録画・UI ロックが一括で戻る。
                        if (progress.status === "succeeded") {
                            void finishSweepSession("Sweep All Finished", "success");
                        } else if (progress.status === "cancelled") {
                            void finishSweepSession("Sweep Cancelled", "warning");
                        } else {
                            void finishSweepSession(progress.message || "Sweep interrupted or failed", "error");
                        }
                    }
                } catch (e) {
                    // progress ポーリング失敗は一時的な通信断でも起こり得るため、数回までは継続する。
                    pollErrorCount += 1;
                    console.warn(`Sweep progress poll error (${pollErrorCount}/5):`, e);
                    if (pollErrorCount >= 5) {
                        // 連続で失敗したら、UI 側だけでも安全に解放する。
                        // backend 側はすでに動いている可能性があるため、ここでは進捗追跡を諦めてロック解除する。
                        clearSweepProgressPolling();
                        sweepOperationId.current = null;
                        setIsSweeping(false);
                        setIsSystemBusy(false);
                        toast.error("Lost progress updates from backend.");
                        systemApi.postLogs("ERROR", "Sweep progress polling failed repeatedly").catch((logErr) => console.debug("※ログ送信も失敗しました:", logErr));
                    }
                }
            }, 500);
        } catch (e) {
            console.error(e);
            // sweep の開始自体が失敗した場合も、UI と録画状態を確実に元へ戻す。
            clearSweepProgressPolling();
            sweepOperationId.current = null;
            setSweepProgress(null);
            setIsSweeping(false);
            setIsSystemBusy(false);
            toast.error("Sweep interrupted or failed");
            systemApi.postLogs("ERROR", `Sweep interrupted or failed: ${e}`).catch((logErr) => console.debug("※ログ送信も失敗しました:", logErr));
        }
    }

    /**
     * 減速停止（Stop）
     * モーターのパルス出力を徐々に落とし、安全に停止させます。実行中のシーケンスや録画予約もキャンセルします。
     */
    const handleStop = async () => {
        try {
            stopSignal.current = true; // 停止ボタンが押されたことを記録（waitForIdle後の処理をキャンセルするため）

            await stageApi.stop(false); // immediate = false (減速停止)
            toast.info("Stopping...");
            systemApi.postLogs("INFO", "Manual deceleration stop executed").catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } catch (e) {
            console.error(e);
            toast.error("Stop Command Failed");
            systemApi.postLogs("ERROR", `Stop Command Failed: ${e}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        }
    }

    /**
     * 非常停止（Emergency Stop）
     * ハードウェアレベルで即座にモーターの動作をカットします。急停止によりパルスがズレるため、再Homingが必要です。
     */
    const handleEmergencyStop = async () => {
        try {
            stopSignal.current = true;
            await stageApi.stop(true); // immediate = true (即停止)
            toast.info("EMERGENCY STOP EXECUTED");
            systemApi.postLogs("WARNING", "EMERGENCY STOP EXECUTED").catch((e) => console.debug("※ログ送信も失敗しました:", e));
            setTimeout(() => {
                toast.warning("Please re-home the stage.");
                systemApi.postLogs("INFO", "Prompted user to re-home after emergency stop").catch((e) => console.debug("※ログ送信も失敗しました:", e));
            }, 1000) //原点復帰を促すtoastを1000 ms後に
        } catch (e) {
            console.error(e);
            systemApi.postLogs("ERROR", `Emergency Stop Command Failed: ${e}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        }
    }

    return (
        // 全体レイアウト: 画面いっぱいに広がり、モバイルでは縦並び、デスクトップでは横並びになるフレックスコンテナ
        <div className="flex h-full w-full flex-col md:flex-row overflow-hidden">
            <TooltipProvider>
                {/* 
                    左側: コントローラーパネル 
                    ステージの操作（Step, Absolute, Sweep）を行うためのサイドバー領域。
                    幅は固定(md:w-80)で、縦方向にスクロール可能。
                */}
                <div className="w-full md:w-80 border-r bg-card flex flex-col h-full z-10 shadow-sm">
                    {/* スクロール可能エリア: コンテンツが溢れた場合にスクロールする */}
                    <div className="flex-1 overflow-y-auto p-8">
                        <div className="">
                            <h2 className="text-2xl font-bold tracking-tight">Manual Control</h2>
                            <p className="text-xs text-muted-foreground mt-1">Direct control of polarizer & camera.</p>
                        </div>

                        <div className="pb-5 space-y-4 mt-6">
                            {/* 
                                現在の角度表示セクション
                                ステージから取得した現在の角度を大きく表示します。
                            */}
                            <div className="flex-1 flex justify-between items-center">
                                <Label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                                    Current Angle
                                </Label>
                                <div className="text-2xl font-mono font-bold tracking-tight text-primary">
                                    {isStageConnected ? currentAngle.toFixed(4) + "°" : "--"}
                                </div>
                            </div>

                            <Separator />

                            {/* 
                                Step Move (相対移動) セクション
                                指定したステップ量だけプラス・マイナス方向に移動します。
                            */}
                            <div className="space-y-3">
                                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex justify-between">
                                    Step Move
                                </Label>

                                {/* メイン操作部: ボタンと入力フィールドを囲むコンテナ */}
                                <div className="bg-secondary/30 p-2 rounded-xl border flex flex-col gap-4">
                                    {/* 操作ボタン群: [-] [Origin] [+] */}
                                    <div className="flex items-center justify-between gap-2">
                                        <TooltipButton label={`Rotate -${moveStep}°`}>
                                            <Button
                                                variant="outline"
                                                size="icon"
                                                className="size-12 rounded-full"
                                                onClick={() => rotateStage(-1)}
                                                disabled={!moveStep || !isStageConnected || isSystemBusy || !stepVal.success}
                                                aria-label={`Rotate -${moveStep}°`}
                                            >
                                                <Minus className="size-6" />
                                            </Button>
                                        </TooltipButton>

                                        <TooltipButton label="Return to Origin">
                                            <Button
                                                variant="outline"
                                                size="icon-lg"
                                                className="size-12 rounded-full font-semibold flex-col gap-0"
                                                onClick={goOrigin}
                                                disabled={!isStageConnected || isSystemBusy}
                                                aria-label="Return to Origin (Mechanical Origin)"
                                            >
                                                <House className="size-5" />
                                                <span className="text-xs text-muted-foreground font-medium">Origin</span>
                                            </Button>
                                        </TooltipButton>

                                        <TooltipButton label={`Rotate +${moveStep}°`}>
                                            <Button
                                                variant="outline"
                                                size="icon-lg"
                                                className="size-12 rounded-full"
                                                onClick={() => rotateStage(1)}
                                                disabled={!moveStep || !isStageConnected || isSystemBusy || !stepVal.success}
                                                aria-label={`Rotate +${moveStep}°`}
                                            >
                                                <Plus className="size-6" />
                                            </Button>
                                        </TooltipButton>
                                    </div>

                                    {/* Move Step Input: ステップ量の入力フィールド */}
                                    <div className="flex flex-col gap-1 pt-2 border-t border-border/50">
                                        <div className="flex items-center gap-2">
                                            <Label className="text-xs text-muted-foreground whitespace-nowrap">
                                                Step [deg.]:
                                            </Label>
                                            <Input
                                                type="number"
                                                step="0.0025"
                                                className={`h-8 font-mono text-right ${!stepVal.success ? "border-destructive text-destructive" : ""}`}
                                                value={moveStep}
                                                onChange={(e) => setMoveStep(e.target.value)}
                                            />
                                        </div>
                                        {!stepVal.success && (
                                            <span className="text-[10px] text-destructive font-medium text-right">
                                                {stepVal.error.issues[0].message}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <Separator />

                            {/* 
                                Absolute Move (絶対移動) セクション
                                指定した角度へ直接移動します。
                            */}
                            <div className="space-y-3">
                                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                    Absolute Move
                                </Label>

                                <div className="flex flex-col gap-1">
                                    <div className="flex gap-2">
                                        <div className="relative flex-1 flex gap-1 items-center">
                                            <Label className="text-xs text-muted-foreground whitespace-nowrap">
                                                Target [deg.]:
                                            </Label>
                                            <Input
                                                type="number"
                                                step="0.0025"
                                                value={targetAngle}
                                                onChange={(e) => setTargetAngle(e.target.value)}
                                                className={`font-mono text-right ${!targetVal.success && targetAngle !== "" ? "border-destructive text-destructive" : ""}`}
                                            />
                                        </div>

                                        <Button
                                            onClick={handleMoveTo}
                                            disabled={!targetAngle || !isStageConnected || isSystemBusy || !targetVal.success}
                                            className="min-w-16 bg-amber-600 hover:bg-amber-600/90 text-white"
                                        >
                                            Go<MoveRight className="ml-1 size-3" />
                                        </Button>
                                    </div>
                                    {!targetVal.success && targetAngle !== "" && (
                                        <span className="text-[10px] text-destructive font-medium text-right">
                                            {targetVal.error.issues[0].message}
                                        </span>
                                    )}
                                </div>
                            </div>

                            <Separator />

                            {/* 
                                Sweep (連続移動) セクション
                                開始角度から終了角度まで、指定した速度で連続的に移動します。
                            */}
                            <div className="space-y-3">
                                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                    Sweep
                                </Label>

                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                        <span className="text-[10px] text-muted-foreground">Start [deg.]</span>
                                        <Input
                                            type="number"
                                            step="0.0025"
                                            value={sweepStart}
                                            onChange={(e) => setSweepStart(e.target.value)}
                                            className={`h-8 font-mono text-right ${!sweepStartVal.success ? "border-destructive text-destructive" : ""}`}
                                        />
                                        {!sweepStartVal.success && (
                                            <p className="text-[10px] text-destructive leading-tight text-right">
                                                {sweepStartVal.error.issues[0].message}
                                            </p>
                                        )}
                                    </div>

                                    <div className="space-y-1">
                                        <span className="text-[10px] text-muted-foreground">End [deg.]</span>
                                        <Input
                                            type="number"
                                            step="0.0025"
                                            value={sweepEnd}
                                            onChange={(e) => setSweepEnd(e.target.value)}
                                            className={`h-8 font-mono text-right ${!sweepEndVal.success ? "border-destructive text-destructive" : ""}`}
                                        />
                                        {!sweepEndVal.success && (
                                            <p className="text-[10px] text-destructive leading-tight text-right">
                                                {sweepEndVal.error.issues[0].message}
                                            </p>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-1">
                                    <div className="flex gap-2 items-end justify-between">
                                        <div className="space-y-1 flex-1">
                                            <span className="text-[10px] text-muted-foreground">Speed [deg./s]</span>
                                            <Input
                                                type="number"
                                                value={sweepSpeed}
                                                onChange={(e) => setSweepSpeed(e.target.value)}
                                                className={`h-8 font-mono text-right ${!sweepSpeedVal.success ? "border-destructive text-destructive" : ""}`}
                                            />
                                        </div>

                                        {/* 
                                            Auto Rec Toggle Button 
                                            - OFF: Outline (無効)
                                            - ON (Standby): Red Outline/Text (待機中・明確にONだとわかるように赤系にする)
                                            - ON (Recording): Destructive + Pulse (実際に録画中)
                                        */}
                                        <TooltipButton label={autoRecord ? "Auto Record: ON" : "Auto Record: OFF"}>
                                            <Button
                                                variant={
                                                    isSweeping && isRecording && autoRecord ? "destructive" : "outline"
                                                }
                                                size="icon"
                                                className={`h-8 w-8 transition-colors ${autoRecord
                                                    ? (isSweeping && isRecording
                                                        ? "animate-pulse"
                                                        : "border-red-500 text-red-600 bg-red-50 hover:bg-red-100 dark:text-red-400 dark:bg-red-950/30 dark:hover:bg-red-900/50")
                                                    : "text-muted-foreground"
                                                    }`}
                                                onClick={() => setAutoRecord(!autoRecord)}
                                            >
                                                <Video className="size-4" />
                                            </Button>
                                        </TooltipButton>

                                        <Button
                                            size="sm"
                                            onClick={handleSweep}
                                            className="h-8 w-28 bg-amber-600 hover:bg-amber-600/90 text-white shrink-0"
                                            disabled={
                                                !sweepStart || !sweepEnd || !sweepSpeed || !isStageConnected || isSystemBusy ||
                                                !sweepFullVal.success
                                            }
                                        >
                                            {isSweeping ? <RefreshCw className="size-3 mr-1 animate-spin" /> : <Play className="size-3 mr-1" />}
                                            {isSweeping ? "Running..." : "Run"}
                                        </Button>
                                    </div>
                                    {sweepProgress && (
                                        // backend から受け取った progress を、そのまま視覚化する表示ブロック。
                                        // phase / percent / message / remainingMs を1か所に集約して出すことで、
                                        // フロントとバックエンドの状態がずれていないことをユーザーが確認できる。
                                        <div className="space-y-1 rounded-lg border border-border/60 bg-secondary/20 p-2">
                                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                                <span className="font-medium uppercase tracking-wider">{sweepProgress.phase}</span>
                                                <span>{sweepProgress.percent}%</span>
                                            </div>
                                            <div className="h-2 overflow-hidden rounded-full bg-muted">
                                                <div
                                                    className="h-full rounded-full bg-amber-600 transition-all duration-300"
                                                    style={{ width: `${Math.max(0, Math.min(100, sweepProgress.percent))}%` }}
                                                />
                                            </div>
                                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                                <span className="truncate pr-2">{sweepProgress.message}</span>
                                                <span>{Math.max(0, Math.ceil(sweepProgress.remainingMs / 1000))}s left</span>
                                            </div>
                                        </div>
                                    )}

                                    {/* エラー表示: 
                                        1. まず速度自体の形式エラー（正の数か、など）を優先表示
                                        2. 形式が正しければ、全体の時間制限エラー（0.2秒制限）を表示
                                    */}
                                    {!sweepSpeedVal.success ? (
                                        <p className="text-[10px] text-destructive leading-tight text-left">
                                            {sweepSpeedVal.error.issues[0].message}
                                        </p>
                                    ) : !sweepFullVal.success ? (
                                        <p className="text-[10px] text-destructive leading-relaxed text-left">
                                            {sweepFullVal.error.issues[0].message}
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    </div>
                    {/* 
                        固定フッターエリア
                        スクロールしても常に最下部に表示される停止ボタン群。
                    */}
                    <div className="p-4 border-t bg-card">
                        <div className="grid grid-cols-4 gap-2">
                            {/* 減速停止ボタン: 通常の停止操作 */}
                            <Button
                                variant="destructive"
                                className="col-span-3 h-12 text-lg font-bold shadow-md active:scale-95 transition-all"
                                onClick={handleStop}
                                disabled={!isStageConnected}
                            >
                                <Square className="fill-current mr-2" /> STOP
                            </Button>

                            {/* 非常停止ボタン: 即時停止（モーター電源OFFなど） */}
                            <TooltipButton label="Emergency Stop (Immediate)">
                                <Button
                                    variant="outline"
                                    className="col-span-1 h-12 border-amber-300 bg-amber-300 text-red-600 hover:border-destructive hover:bg-destructive hover:text-white font-bold"
                                    onClick={handleEmergencyStop}
                                    disabled={!isStageConnected}
                                >
                                    <TriangleAlert className="size-6" />
                                </Button>
                            </TooltipButton>
                        </div>
                    </div>
                </div>
            </TooltipProvider>

            {/* 
                右側: カメラプレビューパネル
                残りの領域を全て使用してカメラ映像を表示します。
            */}
            <CameraPanel showAngle={false} />
        </div>
    )
}

/**
 * ローカルの補助コンポーネント: ツールチップ付きボタンのラッパー
 * マウスホバー時に説明文(label)をポップアップ表示します。
 */
const TooltipButton = ({ label, children }: { label: string, children: React.ReactNode }) => (
    <Tooltip>
        <TooltipTrigger asChild>
            {children}
        </TooltipTrigger>
        <TooltipContent className="font-semibold">
            {label}
        </TooltipContent>
    </Tooltip>
)