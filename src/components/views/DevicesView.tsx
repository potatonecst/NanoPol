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

export function DevicesView() {
    const {
        stagePort, setStagePort,
        isStageConnected, setIsStageConnected,
        cameraId, setCameraId,
        availableCameras, setAvailableCameras,
        isCameraConnected, setIsCameraConnected,
        isRecording,
        resetAllConnections,
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

    //Port一覧
    const fetchPorts = async () => {
        try {
            const res = await systemApi.getPorts();
            setAvailablePorts(res.ports);
        } catch (error) {
            console.error("Failed to fetch ports", error);
            toast.error("Failed to list COM ports");
        }
    }

    //Camera一覧
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
        }
    }

    //初回マウント時にポート一覧を取得
    const initialized = useRef(false);
    useEffect(() => {
        if (!initialized.current) {
            initialized.current = true;
            fetchPorts();
            fetchCameras();
        }
    }, []);

    //ステージ接続ハンドラー
    const handleStageConnect = async () => {
        if (isStageConnected) {
            //切断処理（Mockなので状態を変えるだけ）
            setIsStageConnected(false);
            toast.info("Disconnected Stage");
            return;
        }

        if (!stagePort) {
            toast.error("Please select a COM port."); //簡易アラート
            return;
        }

        try {
            setIsStageLoading(true);
            //API呼び出し
            const res = await stageApi.connect(stagePort);
            console.log(res); //{status: "success"}

            //成功したら接続状態にする
            setIsStageConnected(true);
            toast.success(`Connected to ${stagePort}`);
        } catch (error) {
            console.error(error);
            toast.error("Failed to connect stage.");
        } finally {
            setIsStageLoading(false);
        }
    }

    //カメラ接続ハンドラー
    const handleCameraConnect = async () => {
        if (isCameraConnected) {
            try {
                //切断処理
                setIsCameraLoading(true);
                await cameraApi.disconnect();
                setIsCameraConnected(false);
                toast.info("Disconnected Camera");
            } catch (error) {
                console.error(error);
                toast.error("Failed to disconnect camera.");
            } finally {
                setIsCameraLoading(false);
            }
            return;
        }

        if (!cameraId) {
            toast.error("Please select a Camera ID."); //簡易アラート
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
        } catch (error) {
            console.error(error);
            toast.error("Failed to connect camera.");
        } finally {
            setIsCameraLoading(false);
        }
    }

    //Force Resetハンドラー
    const executeForceReset = async () => {
        console.log("Executing Force Reset...");

        try {
            await systemApi.reset();
            toast.success("System reset command sent.");
        } catch (error) {
            console.error(error);
            toast.warning("Backend reset failed, but resetting UI anyway.");
        } finally {
            resetAllConnections();
            toast.info("All connections reset.");
        }
    }

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
                    <Card className={isStageConnected ? "border-green500/50 bg-green-500/10" : ""}>
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
                    <Card className={isCameraConnected ? "border-green500/50 bg-green-500/10" : ""}>
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