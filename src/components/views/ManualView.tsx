import { useState, useRef, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store/useAppStore";
import { stageApi, systemApi } from "@/api/client";
import { manualControlSchema, angleInputSchema } from "@/schemas/manualControlSchema";
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
        setIsRecording,
        stageSettings,
    } = useAppStore(useShallow((state) => ({
        isStageConnected: state.isStageConnected,
        currentAngle: state.currentAngle,
        setCurrentAngle: state.setCurrentAngle,
        isSystemBusy: state.isSystemBusy,
        setIsSystemBusy: state.setIsSystemBusy,
        isRecording: state.isRecording,
        setIsRecording: state.setIsRecording,
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

    // タイマー管理用Ref (中断時にクリアするため)
    const recordStartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const recordStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Zodによるバリデーション
    const stepVal = angleInputSchema.safeParse(moveStep);
    const targetVal = angleInputSchema.safeParse(targetAngle);
    const sweepStartVal = angleInputSchema.safeParse(sweepStart);
    const sweepEndVal = angleInputSchema.safeParse(sweepEnd);
    const sweepSpeedVal = manualControlSchema.shape.sweepSpeed.safeParse(sweepSpeed);

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

                    // 正常に取得できたら、エラーカウントをリセットします
                    errorCount = 0;

                    setCurrentAngle(res.current_angle);

                    // is_busyがfalseになったら移動完了とみなす
                    if (!res.is_busy) {
                        clearInterval(checkInterval); //タイマーを止めて待機完了にする
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
        setIsSystemBusy(true); // UI全体をロック（ボタンを押せなくする）
        stopSignal.current = false; // 停止シグナルをリセット

        try {
            await moveFn(); // 実際の移動コマンドを実行
            await waitForIdle(); // 移動が終わるまでここで待機（ポーリング開始）

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

            const res = await stageApi.moveRelative(target);
            setCurrentAngle(res.current_angle);
        })
    }

    /**
     * 原点復帰（Homing）: 機械的な0点（センサー位置）を探しに行きます。
     */
    const goOrigin = () => {
        performMove("Homing", async () => {
            toast.info("Homing...");
            const res = await stageApi.home();
            setCurrentAngle(res.current_angle);
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
            const res = await stageApi.moveAbsolute(val);
            setCurrentAngle(res.current_angle);
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
        const { pulsesPerDegree, minSpeedPPS, accelTimeMS, maxSpeedLimitPPS } = stageSettings;

        // 【修正】Zodによる動的バリデーションと変換
        // コンポーネント内の動的な値(stageSettings)を参照するため、ここでスキーマを定義します。
        // transformを使って「100PPS単位への丸め」を行い、補正後の値とフラグを返します。
        const speedSchema = z.coerce.number()
            .positive()
            .transform((val) => {
                const pps = Math.floor(val * pulsesPerDegree);
                // 100PPS単位への丸め処理
                if (pps % 100 !== 0) {
                    const roundedPPS = Math.round(pps / 100) * 100;
                    const safePPS = Math.max(100, roundedPPS); // 0にならないよう最低値を確保
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

        // スキーマ定義(z.coerce.number等)に従い数値として取得
        const start = Number(sweepStartVal.data);
        const end = Number(sweepEndVal.data);
        const { pps: rawPPS, isAdjusted } = speedResult.data;

        if (isSystemBusy) return;

        setIsSystemBusy(true);
        setIsSweeping(true);
        stopSignal.current = false;

        // 【Note】このログはブラウザの開発者ツール(F12)にのみ表示され、アプリ内のLogPanelには表示されません。
        console.log("--- Sweep Sequence Started ---");

        try {
            // Zodで補正された場合は通知
            if (isAdjusted) {
                toast.warning(`Speed adjusted to ${rawPPS} PPS to match 100PPS unit.`);
                systemApi.postLogs("WARNING", `Sweep speed adjusted to ${rawPPS} PPS to match 100PPS unit.`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
            }

            // 安全リミット (Zodで計算済みのPPSを使用し、上限チェックのみ行う)
            const safePPS = Math.max(minSpeedPPS, Math.min(maxSpeedLimitPPS, rawPPS));
            // 実際に適用される速度(deg/s)を再計算（ログ表示用）
            const actualSpeedDeg = safePPS / pulsesPerDegree;
            //速度設定
            toast.info(`Setting speed to ${actualSpeedDeg.toFixed(2)} deg/s (${safePPS} PPS)`);
            systemApi.postLogs("INFO", `Setting speed to ${actualSpeedDeg.toFixed(2)} deg/s (${safePPS} PPS)`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
            await stageApi.setSpeed(minSpeedPPS, safePPS, accelTimeMS);

            // 【物理計算】助走距離（Approach Margin）の算出
            // モーターは台形駆動で加速するため、Start位置で確実に等速になっているよう、手前から助走します。
            // 加速距離 d = (v_start + v_end) / 2 * t
            const startSpeedDeg = minSpeedPPS / pulsesPerDegree;
            const accelTimeSec = accelTimeMS / 1000;
            const accelDist = ((startSpeedDeg + actualSpeedDeg) / 2) * accelTimeSec; //加速距離

            // 安全係数(1.2)を掛け、最低1度は確保
            const margin = Math.max(1.0, accelDist * 1.2);

            // 【修正】スイープ方向の判定と助走位置の計算
            // Start > End の場合（逆方向）は、marginを引くのではなく足す必要があります。
            const direction = end >= start ? 1 : -1;
            const actualStartRaw = start - (margin * direction);
            const actualEndRaw = end + (margin * direction);

            // 【修正】ステップ分解能に合わせて丸める
            // 計算上の小数が細かすぎるとログが見づらく、実機でも意味がないため、ステップ単位に揃えます。
            const alignToStep = (deg: number) => {
                const steps = Math.round(deg * pulsesPerDegree);
                return steps / pulsesPerDegree;
            };

            const actualStart = alignToStep(actualStartRaw);
            const actualEnd = alignToStep(actualEndRaw);

            // タイムアウト時間の計算関数
            // 距離(deg) / 速度(deg/s) = 所要時間(s)。これに安全係数(1.5倍)と固定バッファ(10秒)を加える。
            // これにより、非常に遅いSweep動作でもタイムアウトせず待機できます。
            const calcTimeout = (deg: number) => (deg / actualSpeedDeg * 1.5 * 1000) + 10000;

            // 1. スタート位置へ移動
            // 助走開始位置（actualStart）へ移動します。
            const distToStart = Math.abs(actualStart - currentAngle); //タイムアウトの計算のために、移動距離（角度）を計算
            toast.info(`Moving to Approach Position (${actualStart.toFixed(4)}°)...`);
            systemApi.postLogs("INFO", `Sweep: Moving to Approach Position (${actualStart.toFixed(4)}°)`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
            await stageApi.moveAbsolute(actualStart);
            await waitForIdle(calcTimeout(distToStart)); // 計算したタイムアウト値を使用

            // 途中でストップボタンが押されていたら、ここで中断
            if (stopSignal.current) {
                toast.warning("Sweep Cancelled by User");
                systemApi.postLogs("WARNING", "Sweep Cancelled by User during approach").catch((e) => console.debug("※ログ送信も失敗しました:", e));
                return;
            }

            // --- 時間制御による自動録画ロジック ---
            if (autoRecord) {
                // 1. 録画開始までの遅延時間 (加速時間 + 等速アプローチ時間)
                // Margin区間のうち、加速が終わった後の残りの距離を等速で進む時間を足す
                const distConstant = margin - accelDist; //等速距離
                const timeConstant = distConstant / actualSpeedDeg; //等速時間
                const delayToStartMS = (accelTimeSec + timeConstant) * 1000;

                // 2. 録画時間 (StartからEndまでの移動時間)
                const sweepDist = Math.abs(end - start); //移動距離
                const sweepDurationMS = (sweepDist / actualSpeedDeg) * 1000; //録画継続時間

                toast.info(`Auto Rec: Starts in ${(delayToStartMS / 1000).toFixed(2)}s`);
                systemApi.postLogs("INFO", `Sweep Auto Rec scheduled: Starts in ${(delayToStartMS / 1000).toFixed(2)}s`).catch((e) => console.debug("※ログ送信も失敗しました:", e));

                recordStartTimer.current = setTimeout(() => {
                    if (!stopSignal.current) setIsRecording(true);
                }, delayToStartMS);

                recordStopTimer.current = setTimeout(() => {
                    if (!stopSignal.current) setIsRecording(false);
                }, delayToStartMS + sweepDurationMS);
            }

            toast.info(`Sweeping from ${start}° to ${end}° (Speed: ${actualSpeedDeg.toFixed(2)} deg/s)...`);
            systemApi.postLogs("INFO", `Sweeping from ${start}° to ${end}° (Speed: ${actualSpeedDeg.toFixed(2)} deg/s)`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
            // 2. エンド位置へ移動 (Sweep本番)
            // 助走終了位置まで一気に移動することで、Start~End間は等速で通過します。
            const distSweep = Math.abs(actualEnd - actualStart); //タイムアウト計算に使用する移動距離（角度）
            await stageApi.moveAbsolute(actualEnd); // 助走終了位置まで移動
            await waitForIdle(calcTimeout(distSweep)); // 計算したタイムアウト値を使用

            if (stopSignal.current) {
                toast.warning("Sweep Stopped mid-way");
                systemApi.postLogs("WARNING", "Sweep Stopped mid-way by user").catch((e) => console.debug("※ログ送信も失敗しました:", e));
            } else {
                toast.success("Sweep All Finished");
                systemApi.postLogs("INFO", "Sweep All Finished successfully").catch((e) => console.debug("※ログ送信も失敗しました:", e));
            }
        } catch (e) {
            console.error(e);
            toast.error("Sweep interrupted or failed");
            systemApi.postLogs("ERROR", `Sweep interrupted or failed: ${e}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } finally {
            setIsSweeping(false);
            setIsSystemBusy(false);
            // タイマーのクリア（念のため）
            if (recordStartTimer.current) clearTimeout(recordStartTimer.current);
            if (recordStopTimer.current) clearTimeout(recordStopTimer.current);
            if (autoRecord && !stopSignal.current) setIsRecording(false);

            // 【追加】速度設定をデフォルト（高速）に戻す
            // スイープで低速に設定されたままだと、その後の手動操作（Jog/Absolute）も遅くなってしまうため、
            // 処理終了後（成功・中断・エラー問わず）に必ず元の設定に戻します。
            try {
                await stageApi.setSpeed(minSpeedPPS, maxSpeedLimitPPS, accelTimeMS);
                console.log("Speed reset to default.");
            } catch (e) {
                console.warn("Failed to reset speed:", e);
            }
        }
    }

    /**
     * 減速停止（Stop）
     * モーターのパルス出力を徐々に落とし、安全に停止させます。実行中のシーケンスや録画予約もキャンセルします。
     */
    const handleStop = async () => {
        try {
            stopSignal.current = true; // 停止ボタンが押されたことを記録（waitForIdle後の処理をキャンセルするため）

            // 録画予約タイマーを即座にキャンセル
            if (recordStartTimer.current) clearTimeout(recordStartTimer.current);
            if (recordStopTimer.current) clearTimeout(recordStopTimer.current);
            setIsRecording(false);

            const res = await stageApi.stop(false); // immediate = false (減速停止)
            setCurrentAngle(res.current_angle);
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
            const res = await stageApi.stop(true); // immediate = true (即停止)
            setCurrentAngle(res.current_angle);
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
                                                !sweepStartVal.success || !sweepEndVal.success || !sweepSpeedVal.success
                                            }
                                        >
                                            {isSweeping ? <RefreshCw className="size-3 mr-1 animate-spin" /> : <Play className="size-3 mr-1" />}
                                            {isSweeping ? "Running..." : "Run"}
                                        </Button>
                                    </div>
                                    {!sweepSpeedVal.success && (
                                        <p className="text-[10px] text-destructive leading-tight text-right">
                                            {sweepSpeedVal.error.issues[0].message}
                                        </p>
                                    )}
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