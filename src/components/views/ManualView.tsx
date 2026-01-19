import { useState, useRef, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store/useAppStore";
import { stageApi } from "@/api/client";
import { manualControlSchema, angleInputSchema } from "@/schemas/manualControlSchema";

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
    TriangleAlert,
} from "lucide-react";
import { CameraPanel } from "../shared/CameraPanel";

export function ManualView() {
    const {
        isStageConnected,
        currentAngle, setCurrentAngle,
        isSystemBusy,
        setIsSystemBusy,
        stageSettings,
    } = useAppStore(useShallow((state) => ({
        isStageConnected: state.isStageConnected,
        currentAngle: state.currentAngle,
        setCurrentAngle: state.setCurrentAngle,
        isSystemBusy: state.isSystemBusy,
        setIsSystemBusy: state.setIsSystemBusy,
        stageSettings: state.stageSettings,
    })));

    const stopSignal = useRef(false); //停止シグナル管理用Ref

    //Step Move用
    const [moveStep, setMoveStep] = useState("5.0"); //Step Moveのステップ量

    //Absolute Move用
    const [targetAngle, setTargetAngle] = useState(""); //任意角度入力用

    //Sweep用
    const [sweepStart, setSweepStart] = useState("0");
    const [sweepEnd, setSweepEnd] = useState("360");
    const [sweepSpeed, setSweepSpeed] = useState("10"); //[deg/s]
    const [isSweeping, setIsSweeping] = useState(false);

    // Zodによるバリデーション
    const stepVal = angleInputSchema.safeParse(moveStep);
    const targetVal = angleInputSchema.safeParse(targetAngle);
    const sweepStartVal = angleInputSchema.safeParse(sweepStart);
    const sweepEndVal = angleInputSchema.safeParse(sweepEnd);
    const sweepSpeedVal = manualControlSchema.shape.sweepSpeed.safeParse(sweepSpeed);

    //ステージが停止するまで待機（ポーリング）
    const waitForIdle = async () => {
        return new Promise<void>((resolve, reject) => {
            const checkInterval = setInterval(async () => {
                try {
                    const res = await stageApi.getPosition(); //バックエンドに今の状況を尋ねる
                    setCurrentAngle(res.current_angle);

                    //is_busyがfalseになったら完了（Mockの場合は即完了）
                    if (!res.is_busy) {
                        clearInterval(checkInterval); //タイマーを止めて待機完了にする
                        resolve(); //ここでwaitForIdleが完了する
                    }

                    //まだis_busyがtrueなら、何もせずに次の0.5秒を待つ
                } catch (e) {
                    clearInterval(checkInterval); //エラーが起きたら止める
                    reject(e);
                }
            }, 500) //500 ms = 0.5 sごとにチェック
        })
    }

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
                    toast.success("Operation Finished (Recovered")
                }
            } catch (e) {
                console.error("Status sync failed", e);
            }
        };
        syncStatus();
    }, [isStageConnected]) //接続状態が変わったときもチェック

    //移動処理のラッパー（全ての移動はこれを経由させることで、ロック漏れを防ぐ）
    const performMove = async (actionName: string, moveFn: () => Promise<void>) => {
        if (isSystemBusy) return; //二重防止
        setIsSystemBusy(true);
        stopSignal.current = false; //停止シグナルクリア

        try {
            await moveFn();
            await waitForIdle(); //移動命令完了後、アイドル状態になるまで待機

            if (stopSignal.current) {
                toast.warning(`${actionName} Stopped`);
            } else {
                toast.success(`${actionName} Complete`);
            }
        } catch (e) {
            console.error(e);
            toast.error(`${actionName} Failed`);
        } finally {
            setIsSystemBusy(false); //ロック解除
        }
    }

    //回転操作（Jog）
    const rotateStage = (direction: 1 | -1) => {
        performMove("Step Move", async () => {
            const target = Number(moveStep) * direction;

            const res = await stageApi.moveRelative(target);
            setCurrentAngle(res.current_angle);
        })
    }

    //原点復帰関数
    const goOrigin = () => {
        performMove("Homing", async () => {
            toast.info("Homing...");
            const res = await stageApi.home();
            setCurrentAngle(res.current_angle);
            //toast.success("Home position reached");
        })
    }

    //絶対移動
    const handleMoveTo = async () => {
        const val = parseFloat(targetAngle);
        if (isNaN(val)) return;

        performMove("Absolute Move", async () => {
            toast.info(`Moving to ${val}°...`);
            const res = await stageApi.moveAbsolute(val);
            setCurrentAngle(res.current_angle);
        })
    }

    //Sweep操作（Start -> Endへ移動）
    const handleSweep = async () => {
        const { pulsesPerDegree, minSpeedPPS, accelTimeMS, maxSpeedLimitPPS } = stageSettings;
        const start = parseFloat(sweepStart);
        const end = parseFloat(sweepEnd);
        const speedDeg = parseFloat(sweepSpeed);

        if (isNaN(start) || isNaN(end) || isNaN(speedDeg)) {
            toast.error("Invalid input values");
            return;
        }

        if (isSystemBusy) return;

        setIsSystemBusy(true);
        setIsSweeping(true);
        stopSignal.current = false;

        try {
            //速度計算（deg/s -> PPS）
            const pps = Math.floor(speedDeg * pulsesPerDegree);

            //安全リミット
            const safePPS = Math.max(minSpeedPPS, Math.min(maxSpeedLimitPPS, pps))

            //速度設定
            toast.info(`Setting speed to ${speedDeg} deg/s (${safePPS} PPS)`);
            await stageApi.setSpeed(minSpeedPPS, safePPS, accelTimeMS);

            toast.info(`Moving to Start (${start}°)...`);
            await stageApi.moveAbsolute(start);

            await waitForIdle(); //到着待ち

            //ストップボタンが押されていたら、ここで終了
            if (stopSignal.current) {
                toast.warning("Sweep Cancelled by User");
                return;
            }

            toast.info(`Moving to End (${end}°)...`);
            //ここで速度を指定する予定
            await stageApi.moveAbsolute(end);

            await waitForIdle(); //到着待ち

            if (stopSignal.current) {
                toast.warning("Sweep Stopped mid-way");
            } else {
                toast.success("Sweep All Finished");
            }
        } catch (e) {
            console.error(e);
            toast.error("Sweep interrupted or failed");
        } finally {
            setIsSweeping(false);
            setIsSystemBusy(false);
        }
    }

    //減速停止
    const handleStop = async () => {
        try {
            stopSignal.current = true; //停止ボタンが押されたことを記録
            const res = await stageApi.stop(false); //immediate = false
            setCurrentAngle(res.current_angle);
            toast.info("Stopping...");
        } catch (e) {
            console.error(e);
            toast.error("Stop Command Failed");
        }
    }

    //即停止
    const handleEmergencyStop = async () => {
        try {
            stopSignal.current = true; //停止ボタンが押されたことを記録
            const res = await stageApi.stop(true); //immediate = true
            setCurrentAngle(res.current_angle);
            toast.info("EMERGENCY STOP EXECUTED");
            setTimeout(() => toast.warning("Please re-home the stage."), 1000) //原点復帰を促すtoastを1000 ms後に
        } catch (e) {
            console.error(e);
        }
    }

    // 内部コンポーネント定義を削除（関数の外へ移動するか、直接記述）

    return (
        <div className="flex h-full w-full flex-col md:flex-row overflow-hidden">
            <TooltipProvider>
                {/* 左側: コントローラー */}
                <div className="w-full md:w-80 border-r bg-card flex flex-col h-full z-10 shadow-sm">
                    {/* スクロール可能エリア */}
                    <div className="flex-1 overflow-y-auto p-8">
                        <div className="">
                            <h2 className="text-2xl font-bold tracking-tight">Manual Control</h2>
                            <p className="text-xs text-muted-foreground mt-1">Direct control of polarizer & camera.</p>
                        </div>

                        <div className="pb-5 space-y-4 mt-6">
                            {/* 現在の角度表示 */}
                            <div className="flex-1 flex justify-between items-center">
                                <Label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                                    Current Angle
                                </Label>
                                <div className="text-2xl font-mono font-bold tracking-tight text-primary">
                                    {isStageConnected ? currentAngle.toFixed(4) + "°" : "--"}
                                </div>
                            </div>

                            <Separator />

                            {/* Step Move */}
                            <div className="space-y-3">
                                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex justify-between">
                                    Step Move
                                </Label>

                                {/* メイン操作部 */}
                                <div className="bg-secondary/30 p-2 rounded-xl border flex flex-col gap-4">
                                    {/* 操作ボタン */}
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

                                    {/* Move Step Input */}
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

                            {/* Absolute Move */}
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

                            {/* Sweep */}
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
                                    <div className="flex gap-2 items-end">
                                        <div className="space-y-1 flex-1">
                                            <span className="text-[10px] text-muted-foreground">Speed [deg./s]</span>
                                            <Input
                                                type="number"
                                                value={sweepSpeed}
                                                onChange={(e) => setSweepSpeed(e.target.value)}
                                                className={`h-8 font-mono text-right ${!sweepSpeedVal.success ? "border-destructive text-destructive" : ""}`}
                                            />
                                        </div>

                                        <Button
                                            size="sm"
                                            onClick={handleSweep}
                                            className="h-8 bg-amber-600 hover:bg-amber-600/90 text-white"
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
                    {/* 固定フッターエリア (STOPボタン) */}
                    <div className="p-4 border-t bg-card">
                        <div className="grid grid-cols-4 gap-2">
                            {/* 減速停止 */}
                            <Button
                                variant="destructive"
                                className="col-span-3 h-12 text-lg font-bold shadow-md active:scale-95 transition-all"
                                onClick={handleStop}
                                disabled={!isStageConnected}
                            >
                                <Square className="fill-current mr-2" /> STOP
                            </Button>

                            {/* 非常停止 */}
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

            {/* 右側: カメラプレビュー */}
            <CameraPanel showAngle={false} />
        </div>
    )
}

// コンポーネント定義を関数の外に移動
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