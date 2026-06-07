import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store/useAppStore";
import { cameraApi } from "@/api/client";

import { Button } from "../ui/button";
import { Slider } from "../ui/slider";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

import { CameraOff, House, ZoomIn, ZoomOut, Trash2, Minus, Plus } from "lucide-react";
import { Badge } from "../ui/badge";
import { 
    DEFAULT_EXPOSURE_MIN_MS, 
    DEFAULT_EXPOSURE_MAX_MS, 
    DEFAULT_EXPOSURE_STEP_MS, 
    DEFAULT_GAIN_MIN, 
    DEFAULT_GAIN_MAX,
    MIN_ROI_SIZE
} from "@/constants/constants";

interface CameraPanelProps {
    showAngle?: boolean, //currentAngleを表示するかどうかのフラグ
}

/**
 * ニュートラル（白）なゴミ箱カーソル - 少し小さめ(18x18)に設定
 */
const TRASH_CURSOR_NEUTRAL = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6'/></svg>") 9 9, auto`;

/**
 * 赤色のゴミ箱カーソル（削除対象の上で使用） - 少し小さめ(18x18)に設定
 */
const TRASH_CURSOR_RED = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='rgb(239, 68, 68)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6'/></svg>") 9 9, auto`;

export function CameraPanel({ showAngle = false }: CameraPanelProps) {
    const {
        cameraResolution,
        currentAngle,
        exposureTime, setExposureTime,
        gain, setGain,
        cameraExposureRange,
        zoomLevel, setZoomLevel,
        panOffset, setPanOffset,
        isCameraConnected,
        cameraGainRange,
        rois, addROI, updateROI, removeROI,
    } = useAppStore(useShallow((state) => ({
        cameraResolution: state.cameraResolution,
        currentAngle: state.currentAngle,
        exposureTime: state.exposureTime,
        setExposureTime: state.setExposureTime,
        gain: state.gain,
        setGain: state.setGain,
        cameraExposureRange: state.cameraExposureRange,
        zoomLevel: state.zoomLevel,
        setZoomLevel: state.setZoomLevel,
        panOffset: state.panOffset,
        setPanOffset: state.setPanOffset,
        isCameraConnected: state.isCameraConnected,
        cameraGainRange: state.cameraGainRange,
        rois: state.rois,
        addROI: state.addROI,
        updateROI: state.updateROI,
        removeROI: state.removeROI,
    })));

    // カメラ表示領域のサイズ計測用Ref
    const containerRef = useRef<HTMLDivElement>(null);
    const imageContainerRef = useRef<HTMLDivElement>(null);
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

    // ドラッグ操作の状態管理
    const isDragging = useRef(false);
    const lastMousePos = useRef({ x: 0, y: 0 });

    // ROI操作の状態管理
    const [activeRoiId, setActiveRoiId] = useState<string | null>(null);
    const [draggingRoiId, setDraggingRoiId] = useState<string | null>(null);
    const [resizingRoiId, setResizingRoiId] = useState<string | null>(null);
    const [isCtrlPressed, setIsCtrlPressed] = useState(false);
    const [isAltPressed, setIsAltPressed] = useState(false);

    // UIパネルの表示・非表示（畳めるようにする）
    const [isInfoExpanded, setIsInfoExpanded] = useState(true);
    const [isControlsExpanded, setIsControlsExpanded] = useState(true);

    // キー押下状態を監視（カーソル形状・モード変更用）
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey) setIsCtrlPressed(true);
            if (e.altKey) setIsAltPressed(true);
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            if (!e.ctrlKey && !e.metaKey) setIsCtrlPressed(false);
            if (!e.altKey) setIsAltPressed(false);
        };
        const handleBlur = () => {
            setIsCtrlPressed(false);
            setIsAltPressed(false);
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, []);

    // 映像ストリームのURL生成
    // useMemoを使う理由: 再レンダリングのたびにURLが変わると画像がチラつくため。
    // ?t=Date.now() をつける理由: ブラウザのキャッシュを回避し、再接続時に確実に新しい映像を取得するため。
    const videoFeedUrl = useMemo(() => {
        if (!isCameraConnected) return "";
        return `${cameraApi.getVideoFeedUrl()}?t=${Date.now()}`;
    }, [isCameraConnected]);

    // --- 座標変換ロジック ---

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
    }, [containerSize, cameraResolution]);

    // 生ピクセル ↔ 表示用CSSピクセル のスケール率
    const imageScale = useMemo(() => {
        if (!fitSize || !cameraResolution.width) return 1;
        return fitSize.width / cameraResolution.width;
    }, [fitSize, cameraResolution]);

    /**
     * 画面上のマウス座標(clientX, clientY)をカメラの生ピクセル座標に変換します。
     */
    const screenToImage = useCallback((screenX: number, screenY: number) => {
        if (!imageContainerRef.current || !fitSize) return null;

        // getBoundingClientRect() は CSS transform 適用後の「画面上の見かけのサイズ」を返します。
        const rect = imageContainerRef.current.getBoundingClientRect();

        // 1. 画像コンテナ（ズーム・パン適用済み）内での相対座標を取得
        const relativeX = screenX - rect.left;
        const relativeY = screenY - rect.top;

        // 2. 現在のズーム倍率で割ることで、fitSize (ズームなしCSSピクセル) での座標に戻す
        const fx = relativeX / zoomLevel;
        const fy = relativeY / zoomLevel;

        // 3. 表示スケール (fitSize / cameraResolution) で割ることで、生ピクセル座標に変換
        const rx = fx / imageScale;
        const ry = fy / imageScale;

        return { x: rx, y: ry };
    }, [zoomLevel, imageScale, fitSize]);

    // --- イベントハンドラ ---

    // マウスホイールでのズーム処理
    const handleWheel = (e: React.WheelEvent) => {
        const scaleAmount = -e.deltaY * 0.001;
        // 研究用途に合わせて、上限を50倍まで引き上げ（ピクセル単位の観察が可能に）
        const newZoom = Math.min(Math.max(zoomLevel + scaleAmount, 0.5), 50);
        setZoomLevel(newZoom);
    }

    // ドラッグ開始（マウスダウン）
    const handleMouseDown = (e: React.MouseEvent) => {
        // 背景をクリックした場合は選択を解除
        setActiveRoiId(null);

        // Ctrl または Meta (Cmd) キーを押しながらクリックした場合は ROI を追加
        if (e.ctrlKey || e.metaKey) {
            const pos = screenToImage(e.clientX, e.clientY);
            if (pos) {
                // 個別の色割り当てはストア側で行われるため、ここでは指定しない
                addROI({
                    index: 0, // ストア側で自動割り当てされるが、型定義上の要求を満たすために一時的に指定
                    x: Math.round(pos.x),
                    y: Math.round(pos.y),
                    size: 11, // 初期サイズ 11x11
                });
            }
            return;
        }

        if (e.button === 0) { //left click only
            isDragging.current = true;
            lastMousePos.current = { x: e.clientX, y: e.clientY };
        }
    }

    // ドラッグ中（マウスムーブ）
    const handleMouseMove = (e: React.MouseEvent) => {
        // 前回の位置との差分を計算
        const deltaX = e.clientX - lastMousePos.current.x;
        const deltaY = e.clientY - lastMousePos.current.y;
        lastMousePos.current = { x: e.clientX, y: e.clientY };

        // ROIの移動処理
        if (draggingRoiId) {
            const roi = rois.find(r => r.id === draggingRoiId);
            if (roi) {
                // 移動量をズームと表示スケールを考慮して生ピクセル単位に変換してストアを更新
                const dx = deltaX / (zoomLevel * imageScale);
                const dy = deltaY / (zoomLevel * imageScale);
                updateROI(draggingRoiId, {
                    x: roi.x + dx,
                    y: roi.y + dy,
                });
            }
            return;
        }

        // ROIのリサイズ処理
        if (resizingRoiId) {
            const roi = rois.find(r => r.id === resizingRoiId);
            const pos = screenToImage(e.clientX, e.clientY);
            if (roi && pos) {
                // 中心からの距離の最大値を取得して正方形を維持
                const dist = Math.max(Math.abs(pos.x - roi.x), Math.abs(pos.y - roi.y));
                // サイズ = 距離 * 2 + 1 (常に中心ピクセルが定まるよう奇数に固定)
                let newSize = Math.floor(dist) * 2 + 1;
                // 最小サイズ制限を定数から取得
                if (newSize < MIN_ROI_SIZE) newSize = MIN_ROI_SIZE; 

                updateROI(resizingRoiId, { size: newSize });
            }
            return;
        }

        if (!isDragging.current) return;

        // パンのオフセットを更新（これで画像が動く）
        setPanOffset({
            x: panOffset.x + deltaX,
            y: panOffset.y + deltaY,
        });
    }

    // ドラッグ終了（マウスアップ）
    const handleMouseUp = () => {
        isDragging.current = false;
        setDraggingRoiId(null);
        setResizingRoiId(null);
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
    // step が渡された場合は、指定の刻みに丸めてからクランプする
    const handleNumberInput = (setter: (val: number) => void, val: string, min: number, max: number, step?: number) => {
        let num = parseFloat(val);
        if (isNaN(num)) return;

        if (typeof step === "number" && step > 0) {
            const decimals = (String(step).split(".")[1] || "").length;
            const scale = Math.pow(10, decimals);
            const stepInt = Math.round(step * scale);
            const deltaInt = Math.round((num - min) * scale);
            // 入力側でもオーバーシュートを避けるために下方向で丸める
            const steps = Math.floor(deltaInt / stepInt);
            const rounded = steps * stepInt / scale + min;
            num = Number(rounded.toFixed(decimals));
        }

        // Clamp to min/max after rounding
        num = Math.max(min, Math.min(num, max));
        setter(num);
    }

    // 露光範囲: ストアの値を優先し、取得できない場合は定数のフォールバック値を使う
    // 単位はミリ秒。
    const exposureMin = cameraExposureRange?.min ?? DEFAULT_EXPOSURE_MIN_MS;
    const exposureMax = cameraExposureRange?.max ?? DEFAULT_EXPOSURE_MAX_MS;
    const exposureStep = cameraExposureRange?.step ?? DEFAULT_EXPOSURE_STEP_MS;

    // 表示桁数: exposureStep の小数桁数に合わせて数値入力の表示を整える
    const exposureStepStr = String(exposureStep ?? "");
    const exposurePrecision = exposureStepStr.includes(".") ? exposureStepStr.split(".")[1].length : 0;

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

    // Exposure slider の値をデバイスの step/min に合わせて丸め・クランプする
    const handleExposureSliderChange = (val: number[]) => {
        let v = val[0];
        // 丸めは step の小数桁数に基づく整数スケールで行う
        const decimals = (String(exposureStep).split(".")[1] || "").length;
        const scale = Math.pow(10, decimals);
        const stepInt = Math.round(exposureStep * scale);
        const deltaInt = Math.round((v - exposureMin) * scale);
        // 切り上げ/切り捨てによるオーバーシュートを避けるため、下方向（floor）で丸める
        const steps = Math.floor(deltaInt / stepInt);
        const rounded = steps * stepInt / scale + exposureMin;
        const clamped = Math.min(exposureMax, Math.max(exposureMin, Number(rounded.toFixed(decimals))));
        setExposureTime(clamped);
    }

    // カメラ設定の同期（Debounce処理）
    // スライダーを動かすたびにAPIを呼ぶと負荷が高いため、操作が止まってから0.5秒後にAPIを呼びます。
    useEffect(() => {
        if (!isCameraConnected) return;

        const timer = setTimeout(() => {
            cameraApi.config(exposureTime, gain).catch(console.error);
        }, 500);

        return () => clearTimeout(timer);
    }, [exposureTime, gain, isCameraConnected]);

    const ZoomLevelBadge = ({ label }: { label: string }) => (
        <TooltipProvider>
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
        </TooltipProvider>
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
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    {children}
                </TooltipTrigger>
                <TooltipContent align={align} className="font-semibold">
                    {label}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    )

    // キー入力状態に基づき、背景のカーソルを決定
    const containerCursor = useMemo(() => {
        if (isAltPressed) return TRASH_CURSOR_NEUTRAL;
        if (isCtrlPressed) return 'crosshair';
        return 'move';
    }, [isAltPressed, isCtrlPressed]);

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
                                    value={Number(exposureTime).toFixed(exposurePrecision)}
                                    onChange={(e) => handleNumberInput(setExposureTime, e.target.value, exposureMin, exposureMax, exposureStep)}
                                    step={exposureStep}
                                    min={exposureMin}
                                    max={exposureMax}
                                    className="h-7 w-24 text-xs font-mono text-left pl-2 pr-0 tabular-nums"
                                />
                            </div>

                            <Slider
                                value={[exposureTime]}
                                onValueChange={handleExposureSliderChange}
                                min={exposureMin} max={exposureMax} step={exposureStep}
                                className="w-full"
                            />
                        </div>

                        {/* Gain (ゲイン) 設定 */}
                        <div className="space-y-1.5 col-span-2 flex-1">
                            <div className="flex justify-between text-xs">
                                <Label className="flex items-center gap-1 font-medium text-muted-foreground">
                                    Gain
                                </Label>
                                <div className="relative">
                                    <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-xs font-mono text-muted-foreground">
                                        ×
                                    </span>
                                    <Input
                                        type="number"
                                        value={gain.toFixed(2)}
                                        onChange={(e) => handleNumberInput(setGain, e.target.value, cameraGainRange?.min ?? DEFAULT_GAIN_MIN, cameraGainRange?.max ?? DEFAULT_GAIN_MAX, 0.01)}
                                        step={0.01}
                                        min={cameraGainRange?.min ?? DEFAULT_GAIN_MIN}
                                        max={cameraGainRange?.max ?? DEFAULT_GAIN_MAX}
                                        className="h-7 w-20 text-xs font-mono text-left pl-5 pr-0 tabular-nums"
                                    />
                                </div>
                            </div>

                            <Slider
                                value={[gain]}
                                onValueChange={(val) => setGain(val[0])}
                                min={cameraGainRange?.min ?? DEFAULT_GAIN_MIN}
                                max={cameraGainRange?.max ?? DEFAULT_GAIN_MAX}
                                step={0.01}
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
                <div className="flex-1 min-h-0 w-full overflow-hidden relative flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 select-none"
                    style={{ cursor: containerCursor }}
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
                        will-change: transform により、ズーム時のブラウザのレンダリング負荷を軽減し、ちらつきを防止します。
                    */}
                    <div
                        ref={imageContainerRef}
                        className="relative bg-black shadow-2xl border border-zinc-700 will-change-transform"
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
                                /* 
                                    image-rendering: pixelated により、高倍率時にピクセルがボヤけず鮮明なタイル状に見えるようにします。
                                    実機の高画質なRAWデータであれば、これにより1ピクセル単位の特定が容易になります。
                                */
                                className="w-full h-full object-contain pointer-events-none"
                                style={{ imageRendering: zoomLevel > 5 ? 'pixelated' : 'auto' }}
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
                    </div>

                    {/* 
                        ROI 描画レイヤー (SVG)
                        重要: 拡大による「荒れ」を完全に防ぐため、画像コンテナの外側に等倍(1:1)で配置します。
                        描画位置はズーム倍率とパンを考慮して、JavaScriptでリアルタイムに計算します。
                    */}
                    <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible z-10">
                        {/* ビューの中心を基準に位置合わせ */}
                        <g style={{ transform: `translate(${containerSize.width / 2 + panOffset.x}px, ${containerSize.height / 2 + panOffset.y}px)` }}>
                            {/* ズームされた画像の左上位置までオフセットを戻す */}
                            <g style={{ transform: `translate(${-((fitSize?.width || 0) * zoomLevel) / 2}px, ${-((fitSize?.height || 0) * zoomLevel) / 2}px)` }}>
                                {rois.map((roi) => {
                                    // カメラの生ピクセル座標から、現在のズーム画面上の位置(px)を正確に計算
                                    // これにより「何倍に拡大しても」ピクセルパーフェクトな位置にROIを描画できます。
                                    const sx = roi.x * imageScale * zoomLevel;
                                    const sy = roi.y * imageScale * zoomLevel;
                                    const ss = roi.size * imageScale * zoomLevel;

                                    return (
                                        <g key={roi.id} className="pointer-events-auto"
                                            style={{ cursor: isAltPressed ? TRASH_CURSOR_RED : 'pointer' }}
                                            onMouseDown={(e) => {
                                                e.stopPropagation(); // パン操作および背景の選択解除を阻止
                                                if (e.altKey) {
                                                    removeROI(roi.id);
                                                } else {
                                                    setActiveRoiId(roi.id);
                                                    setDraggingRoiId(roi.id);
                                                }
                                            }}
                                        >
                                            {/* 当たり判定用の透明領域 */}
                                            <rect x={sx - ss / 2} y={sy - ss / 2} width={ss} height={ss} fill="transparent" />

                                            {/* 
                                                ROI 枠 
                                                画面解像度(1:1)で直接描画されるため、何倍に拡大しても常に1.5pxのシャープな線を維持します。
                                            */}
                                            <rect
                                                x={sx - ss / 2} y={sy - ss / 2} width={ss} height={ss} fill="none"
                                                stroke={activeRoiId === roi.id ? "#fff" : roi.color}
                                                strokeWidth={1.5}
                                            />

                                            {/* 中心十字マーク */}
                                            <line x1={sx - 3} y1={sy} x2={sx + 3} y2={sy} stroke={roi.color} strokeWidth={1} />
                                            <line x1={sx} y1={sy - 3} x2={sx} y2={sy + 3} stroke={roi.color} strokeWidth={1} />

                                            {/* 
                                                ROI 番号ラベル 
                                                常に100%の画質で描画されます。
                                            */}
                                            <text
                                                x={sx - ss / 2} y={sy - ss / 2 - 4} fontSize={11}
                                                fill={roi.color}
                                                className="font-mono font-bold select-none drop-shadow-md"
                                                style={{ textRendering: 'geometricPrecision' }}
                                            >
                                                ROI {roi.index}
                                            </text>

                                            {/* リサイズハンドル (右下のみ) */}
                                            <rect
                                                x={sx + ss / 2 - 3} y={sy + ss / 2 - 3} width={6} height={6} fill="#fff"
                                                className="cursor-nwse-resize"
                                                onMouseDown={(e) => {
                                                    e.stopPropagation();
                                                    setResizingRoiId(roi.id);
                                                }}
                                            />
                                        </g>
                                    );
                                })}
                            </g>
                        </g>
                    </svg>

                    {/* 
                        オーバーレイコントロール (Floating UI)
                        画面左下に固定表示されるズーム操作ボタン群。
                        pointer-events-autoを指定し、親のドラッグイベントをキャンセルしてボタン操作を可能にします。
                    */}
                    <div className="absolute bottom-4 left-4 flex flex-col gap-2 pointer-events-auto z-20">
                        <ZoomLevelBadge label="Zoom Level" />

                        <div className="flex items-center gap-2">
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
                                        onClick={() => setZoomLevel(Math.min(50, zoomLevel + 0.1))}
                                    >
                                        <ZoomIn className="size-4" />
                                    </Button>
                                </ZoomButton>
                            </div>

                            <div className="flex gap-1 bg-black/50 p-1 rounded-md border border-zinc-700">
                                {[0.5, 1, 5, 10, 25, 50].map((z) => (
                                    <Button key={z} variant="ghost" className="h-6 w-8 p-0 text-[10px] text-white hover:text-white hover:bg-zinc-800 rounded-sm"
                                        onClick={() => setZoomPreset(z)}
                                    >
                                        x{z}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* 
                        右側情報パネル群 
                        場所は画面右上に固定（fixed-position）されています。
                        z-30 を指定して、ROI枠よりも前面に表示されるようにします。
                    */}
                    <div className="absolute top-4 right-4 flex flex-col gap-4 items-end pointer-events-none z-30">
                        
                        {/* ROI情報ミニテーブル */}
                        {rois.length > 0 && (
                            <div className="bg-black/70 backdrop-blur-md border border-white/10 rounded-lg overflow-hidden shadow-2xl pointer-events-auto min-w-64 transition-all duration-200"
                                onWheel={(e) => e.stopPropagation()} // パネル内スクロール時の背景ズームを防止
                            >
                                <div className="bg-white/5 px-3 py-1.5 border-b border-white/10 flex justify-between items-center cursor-pointer"
                                    onClick={() => setIsInfoExpanded(!isInfoExpanded)}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-bold text-white tracking-wider">ROI DETAILS</span>
                                        <Badge variant="secondary" className="h-4 px-1.5 text-[9px] bg-zinc-800 text-zinc-300 border-none">{rois.length}</Badge>
                                    </div>
                                    <Button variant="ghost" size="icon" className="size-4 hover:bg-white/10">
                                        {isInfoExpanded ? <Minus className="size-3 text-white" /> : <Plus className="size-3 text-white" />}
                                    </Button>
                                </div>
                                {isInfoExpanded && (
                                    <div className="max-h-60 overflow-y-auto custom-scrollbar">
                                        <table className="w-full text-[10px] text-left border-collapse">
                                            <thead>
                                                <tr className="text-zinc-500 border-b border-white/5 sticky top-0 bg-zinc-900/90 backdrop-blur-sm z-10">
                                                    <th className="px-3 py-1 font-medium">ID</th>
                                                    <th className="px-2 py-1 font-medium">Pos(X,Y)</th>
                                                    <th className="px-2 py-1 font-medium text-right">Sum</th>
                                                    <th className="px-2 py-1 font-medium text-right">Max</th>
                                                    <th className="px-3 py-1 text-center"></th>
                                                </tr>
                                            </thead>
                                            <tbody className="text-zinc-300 font-mono">
                                                {rois.map((roi) => (
                                                    <tr key={roi.id} className={`border-b border-white/5 hover:bg-white/5 transition-colors ${activeRoiId === roi.id ? 'bg-white/10' : ''}`}
                                                        onMouseEnter={() => setActiveRoiId(roi.id)}
                                                    >
                                                        <td className="px-3 py-1.5 font-bold" style={{ color: roi.color }}>#{roi.index}</td>
                                                        <td className="px-2 py-1.5">{Math.round(roi.x)},{Math.round(roi.y)}</td>

                                                        <td className="px-2 py-1.5 text-right text-zinc-500">--</td>
                                                        <td className="px-2 py-1.5 text-right text-zinc-500">--</td>
                                                        <td className="px-3 py-1.5 text-center">
                                                            <button 
                                                                onClick={(e) => { e.stopPropagation(); removeROI(roi.id); }}
                                                                className="p-1 hover:text-red-500 transition-colors"
                                                            >
                                                                <Trash2 className="size-3" />
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* 操作ヒントパネル */}
                        <div className="bg-black/70 backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden shadow-xl pointer-events-auto transition-all duration-200"
                            onWheel={(e) => e.stopPropagation()} // パネル上でのホイール操作が背景に伝わるのを防止
                        >
                            <div className="bg-white/5 px-3 py-1.5 flex justify-between items-center cursor-pointer min-w-48"
                                onClick={() => setIsControlsExpanded(!isControlsExpanded)}
                            >
                                <span className="text-[10px] font-bold text-white tracking-wider uppercase">Operation Guide</span>
                                <Button variant="ghost" size="icon" className="size-4 hover:bg-white/10">
                                    {isControlsExpanded ? <Minus className="size-3 text-white" /> : <Plus className="size-3 text-white" />}
                                </Button>
                            </div>
                            {isControlsExpanded && (
                                <div className="p-3 text-[10px] text-white space-y-1.5">
                                    <p className="flex justify-between gap-6"><span className="text-zinc-400">Add ROI:</span> <span className="font-bold text-zinc-200">Ctrl + Click</span></p>
                                    <p className="flex justify-between gap-6"><span className="text-zinc-400">Delete ROI:</span> <span className="font-bold text-red-400 font-mono italic">Alt + Click</span></p>
                                    <p className="flex justify-between gap-6"><span className="text-zinc-400">Move ROI:</span> <span className="font-bold text-zinc-200">Drag ROI</span></p>
                                    <p className="flex justify-between gap-6"><span className="text-zinc-400">Resize:</span> <span className="font-bold text-zinc-200">Drag bottom-right handle</span></p>
                                    <p className="flex justify-between gap-6"><span className="text-zinc-400">Move View:</span> <span className="font-bold text-zinc-300">Drag Background</span></p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </TooltipProvider>
        </div>
    )
}
