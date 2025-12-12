import { useRef, useState, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store/useAppStore";

import { Button } from "../ui/button";
import { Slider } from "../ui/slider";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

import { CameraOff, House, ZoomIn, ZoomOut } from "lucide-react";
import { Badge } from "../ui/badge";

interface CameraPanelProps {
    showAngle?: boolean, //currentAngleを表示するかどうかのフラグ
}

export function CameraPanel({ showAngle = false }: CameraPanelProps) {
    const {
        cameraResolution,
        currentAngle,
        exposureTime, setExposureTime,
        gain, setGain,
        zoomLevel, setZoomLevel,
        panOffset, setPanOffset,
    } = useAppStore(useShallow((state) => ({
        cameraResolution: state.cameraResolution,
        currentAngle: state.currentAngle,
        exposureTime: state.exposureTime,
        setExposureTime: state.setExposureTime,
        gain: state.gain,
        setGain: state.setGain,
        zoomLevel: state.zoomLevel,
        setZoomLevel: state.setZoomLevel,
        panOffset: state.panOffset,
        setPanOffset: state.setPanOffset,
    })));

    //Camera Interaction ref
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
    const isDragging = useRef(false);
    const lastMousePos = useRef({ x: 0, y: 0 });

    //ZoomとPanのロジック
    const handleWheel = (e: React.WheelEvent) => {
        const scaleAmount = -e.deltaY * 0.001;
        const newZoom = Math.min(Math.max(zoomLevel + scaleAmount, 0.5), 10); //0.5x ~ 10x
        setZoomLevel(newZoom);
    }

    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button === 0) { //left click only
            isDragging.current = true;
            lastMousePos.current = { x: e.clientX, y: e.clientY };
        }
    }

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging.current) return;
        const deltaX = e.clientX - lastMousePos.current.x;
        const deltaY = e.clientY - lastMousePos.current.y;
        lastMousePos.current = { x: e.clientX, y: e.clientY };

        setPanOffset({
            x: panOffset.x + deltaX,
            y: panOffset.y + deltaY,
        });
    }

    const handleMouseUp = () => {
        isDragging.current = false;
    }

    //Reset view
    const handleResetView = () => {
        setZoomLevel(1);
        setPanOffset({ x: 0, y: 0 });
    }

    const setZoomPreset = (zoom: number) => {
        setZoomLevel(zoom);
        setPanOffset({ x: 0, y: 0 });
    }

    //Input Helper for Exposure / Gain
    const handleNumberInput = (setter: (val: number) => void, val: string, min: number, max: number) => {
        let num = parseFloat(val);
        if (isNaN(num)) return;
        //Clamp
        num = Math.max(min, Math.min(num, max));
        setter(num);
    }

    //コンテナのサイズをウォッチ
    useEffect(() => {
        if (!containerRef.current) return;
        const obs = new ResizeObserver(entries => {
            const r = entries[0].contentRect;
            setContainerSize({ width: r.width, height: r.height });
        });
        obs.observe(containerRef.current);
        return () => obs.disconnect();
    }, [])

    //コンテナサイズにアスペクト比を守らせる
    const fitSize = useMemo(() => {
        if (!cameraResolution.width || !cameraResolution.height) return null;

        const aspect = cameraResolution.width / cameraResolution.height;
        let w = containerSize.width * 0.9;
        let h = w / aspect

        if (h > containerSize.height * 0.9) {
            h = containerSize.height * 0.9;
            w = h * aspect;
        }
        return { width: w, height: h };
    }, [containerSize, cameraResolution])

    const ZoomLevelBadge = ({ label }: { label: string }) => (
        <Tooltip>
            <TooltipTrigger asChild>
                <Badge variant="outline" className="bg-black/50 text-white border-zinc-700 font-mono">
                    {(zoomLevel * 100).toFixed(2)}%
                </Badge>
            </TooltipTrigger>
            <TooltipContent>
                {label}
            </TooltipContent>
        </Tooltip>
    )

    const ZoomButton = ({
        label,
        children,
        align = "center"
    }: {
        label: string,
        children: React.ReactNode,
        align?: "center" | "start" | "end"
    }) => (
        <Tooltip>
            <TooltipTrigger asChild>
                {children}
            </TooltipTrigger>
            <TooltipContent align={align} className="font-semibold">
                {label}
            </TooltipContent>
        </Tooltip>
    )

    return (
        <div className="flex-1 hidden md:flex flex-col min-w-0 bg-zinc-950">
            <TooltipProvider>
                {/* ツールバー */}
                <div className="shrink-0 border-b bg-card backdrop-blur py-3.5 flex items-center justify-between gap-2 lg:gap-6 xl:gap-10 px-2 lg:px-6 xl:px-10 shadow-sm">
                    {/* 現在地情報 */}
                    {showAngle && (
                        <>
                            <div className="flex flex-col items-center">
                                <div className="text-xs lg:text-sm xl:text-base text-muted-foreground font-bold tracking-wider">
                                    Current Angle
                                </div>
                                <div className="text-xs lg:text-sm xl:text-base font-mono font-bold leading-none tracking-tight">
                                    {currentAngle.toFixed(2)}°
                                </div>
                            </div>

                            <Separator orientation="vertical" className="h-auto bg-border w-0" />
                        </>
                    )}

                    {/* 設定スライダー群 */}
                    <div className="grid grid-cols-5 items-center gap-2 lg:gap-6 xl:gap-10 flex-1">
                        {/* Exposure */}
                        <div className="space-y-1.5 col-span-3 flex-1">
                            <div className="flex justify-between text-xs">
                                <Label className="flex items-center gap-1 font-medium text-muted-foreground">
                                    Exposure [ms]
                                </Label>

                                <Input
                                    type="number"
                                    value={exposureTime}
                                    onChange={(e) => handleNumberInput(setExposureTime, e.target.value, 1, 500)}
                                    className="h-7 w-14 text-xs font-mono text-center p-0"
                                />
                            </div>

                            <Slider
                                value={[exposureTime]}
                                onValueChange={(val) => setExposureTime(val[0])}
                                min={1} max={500} step={1}
                                className="w-full"
                            />
                        </div>

                        {/* Gain */}
                        <div className="space-y-1.5 col-span-2 flex-1">
                            <div className="flex justify-between text-xs">
                                <Label className="flex items-center gap-1 font-medium text-muted-foreground">
                                    Gain
                                </Label>
                                <Input
                                    type="number"
                                    value={gain}
                                    onChange={(e) => handleNumberInput(setGain, e.target.value, 0, 100)}
                                    className="h-7 w-14 text-xs font-mono text-center p-0"
                                />
                            </div>

                            <Slider
                                value={[gain]}
                                onValueChange={(val) => setGain(val[0])}
                                min={0} max={100} step={1}
                                className="w-full"
                            />
                        </div>
                    </div>
                </div>

                {/* プレビュー表示エリア */}
                <div className="flex-1 min-h-0 w-full overflow-hidden relative flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 cursor-move select-none"
                    onWheel={handleWheel}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    ref={containerRef}
                >
                    {/* Grid Background */}
                    <div className="absolute inset-0 opacity-[0.05]"
                        style={{
                            backgroundImage: "radial-gradient(#fff 1px, transparent 1px",
                            backgroundSize: "20px 20px",
                        }}
                    />

                    {/* カメラ画像のコンテナ */}
                    <div
                        className="relative bg-black shadow-2xl border border-zinc-700 transition-transform duration-75 ease-out"
                        style={{
                            width: fitSize?.width,
                            height: fitSize?.height,
                            transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
                        }}
                    >
                        {/* ここにcanvasやimg */}

                        {/* プレースホルダー */}
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-700">
                            <CameraOff className="size-16 mb-4" />
                            <p className="text-lg font-medium">No Signal</p>
                            <p className="text-sm">Check connection</p>
                        </div>

                        {/* ROI選択などの操作は、このdivに対してonClickイベントを設定すれば、文字などに邪魔せれずに座標を取得できる。 */}
                    </div>

                    {/* Overlay Info (Floating on Viewport) */}
                    <div className="absolute bottom-4 left-4 flex flex-col gap-2 pointer-events-auto">
                        <ZoomLevelBadge label="Zoom Level" />

                        <div className="flex itemd-center gap-2">
                            <div className="flex bg-black/50 border border-zinc-700 rounded-md overflow-hidden">
                                <ZoomButton align="start" label="Zoom Out">
                                    <Button variant="ghost" size="icon" className="size-8 text-white hover:text-white hover:bg-zinc-800 rounded-none"
                                        onClick={() => setZoomLevel(Math.max(0.1, zoomLevel - 0.1))}
                                    >
                                        <ZoomOut className="size-4" />
                                    </Button>
                                </ZoomButton>

                                <ZoomButton label="Reset View">
                                    <Button variant="ghost" size="icon" className="size-8 text-white hover:text-white hover:bg-zinc-800 rounded-none"
                                        onClick={handleResetView}
                                    >
                                        <House className="size-4" />
                                    </Button>
                                </ZoomButton>

                                <ZoomButton align="end" label="Zoom In">
                                    <Button variant="ghost" size="icon" className="size-8 text-white hover:text-white hover:bg-zinc-800 rounded-none"
                                        onClick={() => setZoomLevel(Math.min(10, zoomLevel + 0.1))}
                                    >
                                        <ZoomIn className="size-4" />
                                    </Button>
                                </ZoomButton>
                            </div>

                            <div className="flex gap-1 bg-black/50 p-1 rounded-md border border-zinc-700">
                                {[0.5, 1, 2, 4, 6, 10].map((z) => (
                                    <Button key={z} variant="ghost" className="h-6 w-8 p-0 text-[10px] text-white hover:text-white hover:bg-zinc-800 rounded-sm"
                                        onClick={() => setZoomPreset(z)}
                                    >
                                        x{z}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </TooltipProvider>
        </div>
    )
}