import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store/useAppStore";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";

import {
    Plus, Minus, House,
    MoveRight, Play,
} from "lucide-react";
import { CameraPanel } from "../shared/CameraPanel";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "../ui/tooltip";

export function ManualView() {
    const {
        currentAngle, setCurrentAngle,
    } = useAppStore(useShallow((state) => ({
        currentAngle: state.currentAngle,
        setCurrentAngle: state.setCurrentAngle,
    })));

    //Jog Rotation用
    const [jogStep, setJogStep] = useState(5.0); //ジョグ移動のステップ量

    //Absolute Move用
    const [taegetAngle, setTargetAngle] = useState(""); //任意角度入力用

    //Sweep用
    const [sweepStart, setSweepStart] = useState("0");
    const [sweepEnd, setSweepEnd] = useState("360");
    const [sweepSpeed, setSweepSpeed] = useState("10"); //[deg/s]

    //擬似的な回転操作関数
    const rotateStage = (direction: 1 | -1) => {
        //GSC-01への送信イメージ
        const newAngle = currentAngle + jogStep * direction;
        //0~360度の範囲に正規化する場合（必要なら）
        //const normalized newAngle % 360;
        setCurrentAngle(newAngle);
        console.log(`Rotate: ${direction * jogStep} deg.`);
    }

    //擬似的な原点復帰関数
    const goOrigin = () => {
        //GSC-01の機械原点復帰コマンド(H:1)などを想定
        setCurrentAngle(0);
        console.log("Homing...");
    }

    //擬似的な絶対移動
    const handleMoveTo = () => {
        const val = parseFloat(taegetAngle);
        if (!isNaN(val)) {
            setCurrentAngle(val);
            console.log(`Move to ${val} deg.`);
        }
    }

    //擬似的なSweep操作
    const handleSweep = () => {
        console.log(`Sweep from ${sweepStart} to ${sweepEnd} at ${sweepSpeed} deg/s.`);
        //ここにバックエンドへのSweepコマンドが入る
        //仮にEnd位置へ移動
        const end = parseFloat(sweepEnd);
        if (!isNaN(end)) {
            setCurrentAngle(end);
        }
    }

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

    return (
        <div className="flex h-full w-full flex-col md:flex-row overflow-hidden">
            <TooltipProvider>
                {/* 左側: コントローラー */}
                <div className="p-8 w-full md:w-80 border-l bg-card flex flex-col h-full overflow-y-auto z-10 shadow-sm">
                    <div className="">
                        <h2 className="text-2xl font-bold tracking-tight">Manual Control</h2>
                        <p className="text-xs text-muted-foreground mt-1">Direct control of polarizer & camera.</p>
                    </div>

                    <div className="flex-1 pb-5 space-y-4">
                        {/* 現在の角度表示 */}
                        <div className="flex-1 flex justify-between items-center">
                            <Label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                                Current Angle
                            </Label>
                            <div className="text-2xl font-mono font-bold tracking-tight text-primary">
                                {currentAngle.toFixed(2)}°
                            </div>
                        </div>

                        <Separator />

                        {/* Jog Rotation */}
                        <div className="space-y-3">
                            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex justify-between">
                                Jog Rotation
                            </Label>

                            {/* メイン操作部 */}
                            <div className="bg-secondary/30 p-2 rounded-xl border flex flex-col gap-4">
                                {/* 操作ボタン */}
                                <div className="flex items-center justify-between gap-2">
                                    <TooltipButton label={`Rotate -${jogStep}°`}>
                                        <Button
                                            variant="outline"
                                            size="icon"
                                            className="size-12 rounded-full"
                                            onClick={() => rotateStage(-1)}
                                            disabled={!jogStep}
                                            aria-label={`Rotate -${jogStep}°`}
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
                                            aria-label="Return to Origin (Mechanical Origin)"
                                        >
                                            <House className="size-5" />
                                            <span className="text-xs text-muted-foreground font-medium">Origin</span>
                                        </Button>
                                    </TooltipButton>

                                    <TooltipButton label={`Rotate +${jogStep}°`}>
                                        <Button
                                            variant="outline"
                                            size="icon-lg"
                                            className="size-12 rounded-full"
                                            onClick={() => rotateStage(1)}
                                            disabled={!jogStep}
                                            aria-label={`Rotate +${jogStep}°`}
                                        >
                                            <Plus className="size-6" />
                                        </Button>
                                    </TooltipButton>
                                </div>

                                {/* Jog Step Input */}
                                <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                                    <Label className="text-xs text-muted-foreground whitespace-nowrap">
                                        Step [deg.]:
                                    </Label>
                                    <Input
                                        type="number"
                                        className="h-8 font-mono text-right"
                                        value={jogStep}
                                        onChange={(e) => setJogStep(parseFloat(e.target.value))}
                                    />
                                </div>
                            </div>
                        </div>

                        <Separator />

                        {/* Absolute Move */}
                        <div className="space-y-3">
                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                                Absolute Move
                            </Label>

                            <div className="flex gap-2">
                                <div className="relative flex-1 flex gap-1">
                                    <Label className="text-xs text-muted-foreground whitespace-nowrap">
                                        Target [deg.]:
                                    </Label>
                                    <Input
                                        type="number"
                                        value={taegetAngle}
                                        onChange={(e) => setTargetAngle(e.target.value)}
                                        className="font-mono text-right"
                                    />
                                </div>

                                <Button onClick={handleMoveTo} disabled={!taegetAngle} className="min-w-16">
                                    Go
                                    <MoveRight className="ml-1 size-3" />
                                </Button>
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
                                        value={sweepStart}
                                        onChange={(e) => setSweepStart(e.target.value)}
                                        className="h-8 font-mono text-right"
                                    />
                                </div>

                                <div className="space-y-1">
                                    <span className="text-[10px] text-muted-foreground">End [deg.]</span>
                                    <Input
                                        type="number"
                                        value={sweepEnd}
                                        onChange={(e) => setSweepEnd(e.target.value)}
                                        className="h-8 font-mono text-right"
                                    />
                                </div>
                            </div>

                            <div className="flex gap-2 items-end">
                                <div className="space-y-1 flex-1">
                                    <span className="text-[10px] text-muted-foreground">Speed [deg./s]</span>
                                    <Input
                                        type="number"
                                        value={sweepSpeed}
                                        onChange={(e) => setSweepSpeed(e.target.value)}
                                        className="h-8 font-mono text-right"
                                    />
                                </div>

                                <Button
                                    size="sm"
                                    onClick={handleSweep}
                                    className="h-8 bg-amber-600 hover:bg-amber-700 text-white"
                                    disabled={!sweepStart || !sweepEnd || !sweepSpeed}
                                >
                                    <Play className="size-3 mr-1" />Run
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </TooltipProvider>

            {/* 右側: カメラプレビュー */}
            <CameraPanel showAngle={false} />
        </div >
    )
}