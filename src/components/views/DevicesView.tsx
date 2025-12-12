import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store/useAppStore";

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
import { Cable, Camera, RefreshCw, AlertCircle } from "lucide-react";

export function DevicesView() {
    const {
        stagePort, setStagePort,
        isStageConnected, setIsStageConnected,
        cameraId, setCameraId,
        isCameraConnected, setIsCameraConnected,
    } = useAppStore(
        useShallow((state) => ({
            stagePort: state.stagePort,
            setStagePort: state.setStagePort,
            isStageConnected: state.isStageConnected,
            setIsStageConnected: state.setIsStageConnected,
            cameraId: state.cameraId,
            setCameraId: state.setCameraId,
            isCameraConnected: state.isCameraConnected,
            setIsCameraConnected: state.setIsCameraConnected,
        }))
    );

    const RefreshButton = ({ label, disabled }: { label: string, disabled: boolean }) => (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button variant="outline" size="icon-lg" aria-label={label} disabled={disabled}>
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
                                            <SelectItem value="COM1">COM1</SelectItem>
                                            <SelectItem value="COM3">COM3</SelectItem>
                                            <SelectItem value="COM4">COM4</SelectItem>
                                        </SelectContent>
                                    </Select>

                                    {/* リフレッシュボタン（Tooltip付き） */}
                                    <RefreshButton label="Refresh Ports" disabled={isStageConnected} />
                                </div>
                            </div>
                        </CardContent>
                        <CardFooter className="justify-between border-t pt-4">
                            <div className="text-xs text-muted-foreground">Baudrate: 9600</div>
                            <Button
                                variant={isStageConnected ? "destructive" : "default"}
                                onClick={() => setIsStageConnected(!isStageConnected)}
                            >
                                {isStageConnected ? "Disconnect" : "Connect"}
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
                                            <SelectItem value="1">ID: 1 (DCC1645C)</SelectItem>
                                        </SelectContent>
                                    </Select>

                                    {/* リフレッシュボタン（Tooltip付き） */}
                                    <RefreshButton label="Refresh List" disabled={isCameraConnected} />
                                </div>
                            </div>
                        </CardContent>
                        <CardFooter className="justify-between border-t pt-4">
                            <div className="text-xs text-muted-foreground">Mode: 10-bit RAW</div>
                            <Button
                                variant={isCameraConnected ? "destructive" : "default"}
                                onClick={() => setIsCameraConnected(!isCameraConnected)}
                            >
                                {isCameraConnected ? "Disconnect" : "Connect"}
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
                    <Button variant="outline" className="text-muted-foreground border-dashed">
                        Force Reset All Connections
                    </Button>
                    <p className="text-xs text-muted-foreground mt-2">
                        Use this if devices are stuck or not responding. It will forcefully close all handles.
                    </p>
                </div>
            </div>
        </TooltipProvider>
    )
}