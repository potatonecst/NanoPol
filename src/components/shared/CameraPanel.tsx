import { useRef, useState, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store/useAppStore";
import { cameraApi } from "@/api/client";

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
        isCameraConnected,
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
        isCameraConnected: state.isCameraConnected,
    })));

    // カメラ表示領域のサイズ計測用Ref
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

    // ドラッグ操作の状態管理
    const isDragging = useRef(false);
    const lastMousePos = useRef({ x: 0, y: 0 });

    // 映像ストリームのURL生成
    // useMemoを使う理由: 再レンダリングのたびにURLが変わると画像がチラつくため。
    // ?t=Date.now() をつける理由: ブラウザのキャッシュを回避し、再接続時に確実に新しい映像を取得するため。
    const videoFeedUrl = useMemo(() => {
        if (!isCameraConnected) return "";
        return `${cameraApi.getVideoFeedUrl()}?t=${Date.now()}`;
    }, [isCameraConnected]);

    // マウスホイールでのズーム処理
    const handleWheel = (e: React.WheelEvent) => {
        const scaleAmount = -e.deltaY * 0.001;
        const newZoom = Math.min(Math.max(zoomLevel + scaleAmount, 0.5), 10); //0.5x ~ 10x
        setZoomLevel(newZoom);
    }

    // ドラッグ開始（マウスダウン）
    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button === 0) { //left click only
            isDragging.current = true;
            lastMousePos.current = { x: e.clientX, y: e.clientY };
        }
    }

    // ドラッグ中（マウスムーブ）
    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging.current) return;
        // 前回の位置との差分を計算
        const deltaX = e.clientX - lastMousePos.current.x;
        const deltaY = e.clientY - lastMousePos.current.y;
        lastMousePos.current = { x: e.clientX, y: e.clientY };

        // パンのオフセットを更新（これで画像が動く）
        setPanOffset({
            x: panOffset.x + deltaX,
            y: panOffset.y + deltaY,
        });
    }

    // ドラッグ終了（マウスアップ）
    const handleMouseUp = () => {
        isDragging.current = false;
    }

    const handleResetView = () => {
        setZoomLevel(1);
        setPanOffset({ x: 0, y: 0 });
    }

    const setZoomPreset = (zoom: number) => {
        setZoomLevel(zoom);
        setPanOffset({ x: 0, y: 0 });
    }

    // 数値入力のバリデーションヘルパー（範囲外の値を防ぐ）
    const handleNumberInput = (setter: (val: number) => void, val: string, min: number, max: number) => {
        let num = parseFloat(val);
        if (isNaN(num)) return;
        //Clamp
        num = Math.max(min, Math.min(num, max));
        setter(num);
    }

    // コンテナのサイズ監視 (ResizeObserver)
    // ウィンドウサイズが変わった時に、表示エリアの大きさを再取得します。
    useEffect(() => {
        if (!containerRef.current) return;
        const obs = new ResizeObserver(entries => {
            const r = entries[0].contentRect;
            setContainerSize({ width: r.width, height: r.height });
        });
        obs.observe(containerRef.current);
        return () => obs.disconnect();
    }, [])

    // カメラ設定の同期（Debounce処理）
    // スライダーを動かすたびにAPIを呼ぶと負荷が高いため、操作が止まってから0.5秒後にAPIを呼びます。
    useEffect(() => {
        if (!isCameraConnected) return;

        const timer = setTimeout(() => {
            cameraApi.config(exposureTime, gain).catch(console.error);
        }, 500);

        return () => clearTimeout(timer);
    }, [exposureTime, gain, isCameraConnected]);

    // 画像のアスペクト比維持計算
    // コンテナの中に収まる最大のサイズ（object-contain相当）を計算します。
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
        // メインコンテナ: デスクトップではフレックス表示、モバイルでは非表示（または別レイアウト）
        <div className="flex-1 hidden md:flex flex-col min-w-0 bg-zinc-950">
            <TooltipProvider>
                {/* 
                    上部ツールバー
                    Exposure, Gainなどのカメラ設定パラメータを調整するスライダー群を配置。
                    backdrop-blurを使用して映像の上に重なっても視認性を確保（現在は上部固定）。
                */}
                <div className="shrink-0 border-b bg-card backdrop-blur py-3.5 flex items-center justify-between gap-2 lg:gap-6 xl:gap-10 px-2 lg:px-6 xl:px-10 shadow-sm">
                    {/* 現在地情報（ManualView以外でも角度を確認できるようにするオプション） */}
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

                    {/* 設定スライダー群: グリッドレイアウトでExposureとGainを配置 */}
                    <div className="grid grid-cols-5 items-center gap-2 lg:gap-6 xl:gap-10 flex-1">
                        {/* Exposure (露光時間) 設定 */}
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

                        {/* Gain (ゲイン) 設定 */}
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

                {/* 
                    プレビュー表示エリア
                    マウスホイールでのズーム、ドラッグでのパン操作イベントをここで受け取ります。
                    overflow-hiddenにより、拡大した画像が領域外に出ないようにします。
                */}
                <div className="flex-1 min-h-0 w-full overflow-hidden relative flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 cursor-move select-none"
                    onWheel={handleWheel}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    ref={containerRef}
                >
                    {/* 背景グリッド: 画像がない場合や余白部分に表示されるドットパターン */}
                    <div className="absolute inset-0 opacity-[0.05]"
                        style={{
                            backgroundImage: "radial-gradient(#fff 1px, transparent 1px",
                            backgroundSize: "20px 20px",
                        }}
                    />

                    {/* 
                        カメラ画像のコンテナ
                        計算されたフィットサイズ(fitSize)と、ユーザー操作によるパン・ズーム(transform)を適用します。
                    */}
                    <div
                        className="relative bg-black shadow-2xl border border-zinc-700 transition-transform duration-75 ease-out"
                        style={{
                            width: fitSize?.width,
                            height: fitSize?.height,
                            transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
                        }}
                    >
                        {/* Camera Image: 接続時はMJPEGストリームを表示、未接続時はプレースホルダー */}
                        {isCameraConnected ? (
                            <img
                                src={videoFeedUrl}
                                alt="Camera Stream"
                                className="w-full h-full object-contain pointer-events-none"
                                draggable={false}
                            />
                        ) : (
                            /* Placeholder */
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-700">
                                <CameraOff className="size-16 mb-4" />
                                <p className="text-lg font-medium">No Signal</p>
                                <p className="text-sm">Check connection</p>
                            </div>
                        )}

                        {/* ROI選択などの操作は、このdivに対してonClickイベントを設定すれば、文字などに邪魔せれずに座標を取得できる。 */}
                    </div>

                    {/* 
                        オーバーレイコントロール (Floating UI)
                        画面左下に固定表示されるズーム操作ボタン群。
                        pointer-events-autoを指定し、親のドラッグイベントをキャンセルしてボタン操作を可能にします。
                    */}
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