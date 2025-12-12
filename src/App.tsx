import { useState, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { AppSidebar } from "./components/AppSidebar";
import { useAppStore } from "./store/useAppStore";
import { Button } from "./components/ui/button";
import { Separator } from "./components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";

import { Camera, Moon, Sun, Video, Square } from "lucide-react"
import { IconWaveSine } from "@tabler/icons-react"

import { DevicesView } from "./components/views/DevicesView";

import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { ManualView } from "./components/views/ManualView";

function App() {
  const { currentMode, isCameraConnected } = useAppStore(
    useShallow((state) => ({
      currentMode: state.currentMode,
      isCameraConnected: state.isCameraConnected
    }))
  ); //どのモードかを聞き出す
  const [isDark, setIsDark] = useState(true); //ダークモード切り替え用
  const [isRecording, setIsRecording] = useState(false); //録画状態管理用

  //HTMLタグ自体にdarkクラスを付与
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(isDark ? "dark" : "light");
  }, [isDark]);

  //録画ボタンのトグル処理
  const toggleRecording = () => {
    if (isRecording) {
      console.log("Stop Recording...")
      //ここにバックエンドへのリクエスト
    } else {
      console.group("Start Recording...")
      //ここにバックエンドへのリクエスト
    }
    setIsRecording(!isRecording);
  };

  //currentModeの値によって表示内容を切り替え
  const renderContent = () => {
    switch (currentMode) {
      case "devices":
        return <DevicesView />;
      case "manual":
        return <ManualView />;
      case "auto":
        return <div className="p-8 text-2xl font-bold text-muted-foreground">▶️ Auto Mode Area</div>;
      case "settings":
        return <div className="p-8 text-2xl font-bold text-muted-foreground">⚙️ Settings Mode Area</div>;
      default:
        return null;
    }
  };

  //Tooltip付きボタン
  const HeaderAction = ({
    label,
    children,
    align = "center",
  }: {
    label: string,
    children: React.ReactNode,
    align?: "center" | "start" | "end",
  }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom" align={align} className="font-semibold">
        {label}
      </TooltipContent>
    </Tooltip>
  );

  return (
    //画面の大枠（全体を縦並び）
    <TooltipProvider>
      <div className={"flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground"}>
        {/* Header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-4 bg-card shadow-sm z-50">
          <div className="flex items-center gap-2">
            {/* Logo Area */}
            <div className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <IconWaveSine className="size-5" />
            </div>
            <div className="flex items-baseline gap-2">
              <h1 className="font-bold text-lg tracking-tight hidden md:inline">NanoPol Controller</h1>
              <h1 className="font-bold text-lg tracking-tight md:hidden">NanoPol</h1>
              <span className="text-xs text-muted-foreground">v0.1</span>
            </div>

            {/* Status Badge */}
            <div className="ml-4">
              <Badge
                variant="outline"
                className="gap-1.5 py-1 px-3 border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400 font-medium hover:bg-green-500/20"
              >
                <span className="relative flex size-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full size-2 bg-green-500" />
                </span>
                <div className="hidden md:inline-flex">System Ready</div>
                <div className="md:hidden">Ready</div>
              </Badge>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex items-center gap-2">
            {/* テーマ切り替え */}
            <HeaderAction label={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}>
              <Button
                variant="secondary"
                size="icon-sm"
                onClick={() => setIsDark(!isDark)}
                aria-label={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
              >
                {isDark ? <Moon className="size-5" /> : <Sun className="size-5" />}
              </Button>
            </HeaderAction>

            <div className="h-7">
              <Separator orientation="vertical" className="h-auto w-px bg-border mx-1" />
            </div>

            {/* 動画撮影ボタン */}
            <HeaderAction label={isRecording ? "Stop Recording" : "Record"}>
              <Button
                variant={isRecording ? "destructive" : "outline"}
                size="sm"
                className="gap-2 flex w-9 md:w-28 justify-center transition-all"
                onClick={toggleRecording}
                disabled={!isCameraConnected}
                aria-label={isRecording ? "Stop Recording" : "Start Recording"}
              >
                {isRecording ? <Square className="size-4" /> : <Video className="size-4" />}
                <span className="hidden md:flex">{isRecording ? "Stop Rec." : "Rec."}</span>
              </Button>
            </HeaderAction>

            {/* スナップショット */}
            <HeaderAction label="Take Snapshot" align="end">
              <Button
                variant="outline"
                size="sm"
                className="gap-2 flex md:w-28 justify-center"
                disabled={!isCameraConnected}
                aria-label="Snapshot"
              >
                <Camera className="size-4" />
                <span className="hidden md:flex">Snapshot</span>
              </Button>
            </HeaderAction>
          </div>
        </header>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          <AppSidebar />

          {/* メインコンテンツ表示エリア */}
          <main className="flex-1 overflow-auto bg-secondary/20 relative">
            {/* 現在のモードに対応した画面 */}
            {renderContent()}
          </main>
        </div>

        {/* ステータスバー */}
        <footer className="flex h-6 shrink-0 items-center border-t bg-card px-4 text-xs text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-green-500 mr-2" />
          <span>[INFO] Application initialized successfully. Waiting for device connection...</span>
        </footer>
      </div>
    </TooltipProvider>
  )
}

export default App;
