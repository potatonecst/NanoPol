import { useEffect, useState, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store/useAppStore";
import { stageApi, cameraApi, systemApi } from "@/api/client";

import { Button } from "../ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "../ui/card";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "../ui/select";
import { Badge } from "../ui/badge";
import { Label } from "../ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "../ui/alert-dialog";
import { toast } from "sonner";

import { Cable, Camera, RefreshCw, AlertCircle } from "lucide-react";

/**
 * デバイス接続管理画面 (Devices View) コンポーネント
 *
 * システム（回転ステージとカメラ）の通信ポートやIDを選択し、接続・切断を行うための画面です。
 *
 * 【主な機能】
 * - 利用可能なCOMポートおよびカメラの一覧の自動取得（ポーリング/手動リフレッシュ）。
 * - デバイスごとの独立した接続・切断操作。
 * - Zustandストア（グローバル状態）の接続フラグの更新。
 * - トラブル時のシステム全体強制リセット機能。
 */
export function DevicesView() {
    const {
        stagePort, setStagePort,
        isStageConnected, setIsStageConnected,
        cameraId, setCameraId,
        availableCameras, setAvailableCameras,
        isCameraConnected, setIsCameraConnected,
        isRecording,
        resetAllConnections,
        // useShallow: パフォーマンス最適化フック。
        // ストア全体のデータが変わっても、ここで指定したプロパティ（stagePortなど）に変化がなければ
        // このコンポーネントは再レンダリングされません。
    } = useAppStore(
        useShallow((state) => ({
            stagePort: state.stagePort,
            setStagePort: state.setStagePort,
            isStageConnected: state.isStageConnected,
            setIsStageConnected: state.setIsStageConnected,
            cameraId: state.cameraId,
            setCameraId: state.setCameraId,
            availableCameras: state.availableCameras,
            setAvailableCameras: state.setAvailableCameras,
            isCameraConnected: state.isCameraConnected,
            setIsCameraConnected: state.setIsCameraConnected,
            isRecording: state.isRecording,
            resetAllConnections: state.resetAllConnections,
        }))
    );

    const [availablePorts, setAvailablePorts] = useState<string[]>([]);
    const [isStageLoading, setIsStageLoading] = useState(false);
    const [isCameraLoading, setIsCameraLoading] = useState(false);

    /**
     * COMポート一覧を取得する非同期関数
     * 
     * バックエンド(FastAPI)の `/system/ports` APIに問い合わせて、現在PCに認識されている
     * シリアルポートのリストを取得し、ドロップダウンメニューの選択肢を更新します。
     */
    const fetchPorts = async () => {
        try {
            const res = await systemApi.getPorts();
            setAvailablePorts(res.ports);
        } catch (error) {
            console.error("Failed to fetch ports", error);
            toast.error("Failed to list COM ports");
            systemApi.postLogs("ERROR", `Failed to fetch COM ports: ${error}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        }
    }

    /**
     * 接続可能なカメラ一覧を取得する非同期関数
     */
    const fetchCameras = async () => {
        try {
            const res = await cameraApi.listCameras();
            setAvailableCameras(res.cameras);
            // If only one camera, select it automatically if none selected
            if (res.cameras.length > 0 && !cameraId) {
                setCameraId(res.cameras[0].id.toString());
            }
        } catch (error) {
            console.error("Failed to fetch cameras", error);
            toast.error("Failed to list cameras");
            systemApi.postLogs("ERROR", `Failed to fetch cameras: ${error}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        }
    }

    /**
     * 【初期化エフェクト】
     * 画面マウント時に1回だけ、ポートとカメラの一覧を自動取得します。
     * 
     * 【useRef(initialized) によるガード】
     * React 18のStrict Mode（開発モード）特有の「二重マウント（useEffectの2回実行）」によって
     * APIリクエストが2回連続で飛んでしまうのを防ぐためのフラグです。
     */
    const initialized = useRef(false);
    useEffect(() => {
        if (!initialized.current) {
            initialized.current = true;
            fetchPorts();
            fetchCameras();
        }
    }, []);

    /**
     * ステージコントローラーの「Connect / Disconnect」ボタンハンドラ
     * 
     * 現在の接続状態（isStageConnected）に応じて、接続または切断のAPIを呼び出します。
     * 通信中はボタンをローディング状態（isStageLoading）にし、ユーザーの二重操作を防ぎます。
     * 処理完了後、成功・失敗に関わらずグローバル状態とログを更新します。
     */
    const handleStageConnect = async () => {
        if (isStageConnected) {
            //切断処理（Mockなので状態を変えるだけ）
            setIsStageConnected(false);
            toast.info("Disconnected Stage");
            systemApi.postLogs("INFO", "Disconnected Stage (Mock state updated)").catch((e) => console.debug("※ログ送信も失敗しました:", e));
            return;
        }

        if (!stagePort) {
            toast.error("Please select a COM port."); //簡易アラート
            systemApi.postLogs("WARNING", "Stage connection failed: No COM port selected").catch((e) => console.debug("※ログ送信も失敗しました:", e));
            return;
        }

        try {
            setIsStageLoading(true); // ボタンを無効化し、スピナーを表示
            // API呼び出し: バックエンドに接続命令を送る
            const res = await stageApi.connect(stagePort);
            console.log(res); //{status: "success"}

            // 成功したらストアの状態を更新（これにより画面上のバッジなどが緑色に変わる）
            setIsStageConnected(true);
            toast.success(`Connected to ${stagePort}`);
            systemApi.postLogs("INFO", `Stage connected successfully to ${stagePort}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } catch (error) {
            console.error(error);
            toast.error("Failed to connect stage.");
            systemApi.postLogs("ERROR", `Failed to connect stage on ${stagePort}: ${error}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } finally {
            setIsStageLoading(false);
        }
    }

    /**
     * カメラデバイスの「Connect / Disconnect」ボタンハンドラ
     * 
     * 指定されたカメラID（整数）を使用してバックエンドの接続APIを呼び出します。
     * 接続成功後、バックエンド側ではMJPEGストリーム配信用（特急レーン）の別スレッドが起動します。
     */
    const handleCameraConnect = async () => {
        if (isCameraConnected) {
            try {
                //切断処理
                setIsCameraLoading(true);
                await cameraApi.disconnect();
                setIsCameraConnected(false);
                toast.info("Disconnected Camera");
                systemApi.postLogs("INFO", "Disconnected Camera successfully").catch((e) => console.debug("※ログ送信も失敗しました:", e));
            } catch (error) {
                console.error(error);
                toast.error("Failed to disconnect camera.");
                systemApi.postLogs("ERROR", `Failed to disconnect camera: ${error}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
            } finally {
                setIsCameraLoading(false);
            }
            return;
        }

        if (!cameraId) {
            toast.error("Please select a Camera ID."); //簡易アラート
            systemApi.postLogs("WARNING", "Camera connection failed: No Camera ID selected").catch((e) => console.debug("※ログ送信も失敗しました:", e));
            return;
        }

        try {
            setIsCameraLoading(true);
            //API呼び出し (backend expects int, but client passes string "1" usually. cast it if needed in client.ts or here)
            // client.ts accepts number.
            const res = await cameraApi.connect(parseInt(cameraId));
            console.log(res); //{status: "success"}

            //成功したら接続状態にする
            setIsCameraConnected(true);
            toast.success(`Connected to Camera ${cameraId}`);
            systemApi.postLogs("INFO", `Camera ${cameraId} connected successfully`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } catch (error) {
            console.error(error);
            toast.error("Failed to connect camera.");
            systemApi.postLogs("ERROR", `Failed to connect camera ${cameraId}: ${error}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } finally {
            setIsCameraLoading(false);
        }
    }

    /**
     * 【緊急用】システム全体強制リセット処理
     * 
     * 機器の暴走、フリーズ、通信のデッドロックなどが発生した場合のフェイルセーフ機能です。
     * 1. バックエンドに対し、全デバイスのシリアルポートやカメラハンドルの強制クローズ（解放）を要求します。
     * 2. フロントエンド（Zustandストア）の接続フラグを全て「未接続」状態にリセットします。
     */
    const executeForceReset = async () => {
        console.log("Executing Force Reset...");
        systemApi.postLogs("WARNING", "User initiated Force Reset sequence").catch((e) => console.debug("※ログ送信も失敗しました:", e));

        try {
            await systemApi.reset();
            toast.success("System reset command sent.");
            systemApi.postLogs("INFO", "Force system reset command executed by backend successfully").catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } catch (error) {
            console.error(error);
            toast.warning("Backend reset failed, but resetting UI anyway.");
            systemApi.postLogs("ERROR", `Backend force reset failed (API error): ${error}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
        } finally {
            resetAllConnections();
            toast.info("All connections reset.");
            systemApi.postLogs("INFO", "All frontend connection states have been reset").catch((e) => console.debug("※ログ送信も失敗しました:", e));
        }
    }

    /**
     * 補助コンポーネント: リフレッシュボタン
     * ドロップダウンメニューの横に配置され、ポートやカメラの一覧を再取得するためのボタンです。
     */
    const RefreshButton = ({
        label,
        disabled,
        onClick,
    }: {
        label: string,
        disabled: boolean,
        onClick?: () => void,
    }) => (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="outline"
                    size="icon-lg"
                    aria-label={label}
                    disabled={disabled}
                    onClick={onClick}
                >
                    <RefreshCw className="size-4" />
                </Button>
            </TooltipTrigger>
            <TooltipContent>
                {label}
            </TooltipContent>
        </Tooltip>
    )

    return (
        <TooltipProvider delayDuration={200}>
            <div className="p-8 max-w-5xl mx-auto space-y-8">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">Devices Connection</h2>
                    <p className="text-xs text-muted-foreground mt-2">
                        Manage connections for the GSC-01 Stage Controller and DCC1645C Camera.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Stage Controller Panel */}
                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Cable className="size-5 text-primary" />
                                    <CardTitle>Stage Controller</CardTitle>
                                </div>
                                <Badge
                                    variant={isStageConnected ? "default" : "outline"}
                                    className={isStageConnected ? "bg-green-600 hover:bg-green-600" : ""}
                                >
                                    {isStageConnected ? "Connected" : "Disconnected"}
                                </Badge>
                            </div>
                            <CardDescription>OptoSigma GSC-01 (RS232C)</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label className="text-sm font-medium">COM Port</Label>
                                <div className="flex gap-2 items-center">
                                    <Select value={stagePort} onValueChange={setStagePort} disabled={isStageConnected}>
                                        <SelectTrigger className="w-full">
                                            <SelectValue placeholder="Select COM Port" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {availablePorts.length === 0 ? (
                                                <SelectItem value="placeholder" disabled>No ports found</SelectItem>
                                            ) : (
                                                availablePorts.map((port) => (
                                                    <SelectItem key={port} value={port}>
                                                        {port}
                                                    </SelectItem>
                                                ))
                                            )}
                                        </SelectContent>
                                    </Select>

                                    {/* リフレッシュボタン（Tooltip付き） */}
                                    <RefreshButton
                                        label="Refresh Ports"
                                        disabled={isStageConnected}
                                        onClick={fetchPorts}
                                    />
                                </div>
                            </div>
                        </CardContent>
                        <CardFooter className="justify-between border-t pt-4">
                            <div className="text-xs text-muted-foreground">Baudrate: 9600</div>
                            <Button
                                variant={isStageConnected ? "destructive" : "default"}
                                onClick={handleStageConnect}
                                disabled={isStageLoading || (isStageConnected && isRecording)}
                            >
                                {isStageLoading ? "Connecting..." : (isStageConnected ? "Disconnect" : "Connect")}
                            </Button>
                        </CardFooter>
                    </Card>

                    {/* Camera Panel */}
                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Camera className="size-5 text-primary" />
                                    <CardTitle>Camera</CardTitle>
                                </div>
                                <Badge
                                    variant={isCameraConnected ? "default" : "outline"}
                                    className={isCameraConnected ? "bg-green-600 hover:bg-green-600" : ""}
                                >
                                    {isCameraConnected ? "Connected" : "Disconnected"}
                                </Badge>
                            </div>
                            <CardDescription>Thorlabs DCC1645C (uEye)</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label className="text-sm font-medium">Camera ID</Label>
                                <div className="flex gap-2 items-center">
                                    <Select value={cameraId} onValueChange={setCameraId} disabled={isCameraConnected}>
                                        <SelectTrigger className="w-full">
                                            <SelectValue placeholder="Select Camera" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {availableCameras.length === 0 ? (
                                                <SelectItem value="placeholder" disabled>No cameras found</SelectItem>
                                            ) : (
                                                availableCameras.map((cam) => (
                                                    <SelectItem key={cam.id} value={cam.id.toString()}>
                                                        {cam.name} ({cam.id})
                                                    </SelectItem>
                                                ))
                                            )}
                                        </SelectContent>
                                    </Select>

                                    {/* リフレッシュボタン（Tooltip付き） */}
                                    <RefreshButton label="Refresh List" disabled={isCameraConnected} onClick={fetchCameras} />
                                </div>
                            </div>
                        </CardContent>
                        <CardFooter className="justify-between border-t pt-4">
                            <div className="text-xs text-muted-foreground">Mode: 10-bit RAW</div>
                            <Button
                                variant={isCameraConnected ? "destructive" : "default"}
                                onClick={handleCameraConnect}
                                disabled={isCameraLoading || (isCameraConnected && isRecording)}
                            >
                                {isCameraLoading ? "Connecting..." : (isCameraConnected ? "Disconnect" : "Connect")}
                            </Button>
                        </CardFooter>
                    </Card>
                </div>

                {/* Troubleshoot Area */}
                <div className="pt-8 border-t">
                    <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <AlertCircle className="size-5 text-amber-500" />
                        Troubleshooting
                    </h3>

                    <AlertDialog>
                        <AlertDialogTrigger asChild>
                            <Button
                                variant="outline"
                                className="text-muted-foreground border-dashed"
                            >
                                Force Reset All Connections
                            </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                                <AlertDialogDescription>
                                    This will forcefully disconnected all devices and reset the system states.
                                    Any ongoing measurements will be stopped.
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                {/* Continueを押した時にexecuteForceResetを実行 */}
                                <AlertDialogAction onClick={executeForceReset} className="bg-destructive hover:bg-destructive/90">
                                    Force Reset
                                </AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>

                    <p className="text-xs text-muted-foreground mt-2">
                        Use this if devices are stuck or not responding. It will forcefully close all handles.
                    </p>
                </div>
            </div>
        </TooltipProvider>
    )
}