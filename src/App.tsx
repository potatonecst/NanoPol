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
import { Toaster } from "./components/ui/sonner";
import { toast } from "sonner";

import { Camera, Moon, Sun, Video, Square } from "lucide-react"
import { IconWaveSine } from "@tabler/icons-react"

import { DevicesView } from "./components/views/DevicesView";
import { ManualView } from "./components/views/ManualView";
import { SettingsView } from "./components/views/SettingsView";

import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { LogPanel } from "./components/shared/LogPanel";

function App() {
  const {
    currentMode, isCameraConnected, // 現在選択されているモードと、カメラ接続状態
    isRecording, setIsRecording, // 録画中かどうかのフラグと、それを更新する関数
  } = useAppStore(
    // 【パフォーマンス最適化】
    // useShallow を使うことで、ここで取り出した値（currentModeなど）が変化した時だけ
    // Appコンポーネントを再レンダリングするようにしています。
    // これを使わないと、ストア内の無関係なデータ（例えばステージの位置情報など）が変わっただけでも
    // 画面全体が再描画されてしまい、動作が重くなる原因になります。
    useShallow((state) => ({
      currentMode: state.currentMode,
      isCameraConnected: state.isCameraConnected,
      isRecording: state.isRecording,
      setIsRecording: state.setIsRecording,
    }))
  );

  // ダークモードの状態管理（trueならダークモード、falseならライトモード）
  const [isDark, setIsDark] = useState(true);

  // 【副作用 (Side Effect) の制御】
  // テーマ切り替え処理：isDark の値が変わるたびに実行されます。
  // Reactの状態変化に合わせて、ブラウザのDOM（<html>タグ）のクラスを直接書き換えます。
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(isDark ? "dark" : "light");
    // [isDark] は依存配列です。この中の値が変化した時だけ、このuseEffectの中身が実行されます。
  }, [isDark]);

  // 【安全装置】カメラ切断時の録画停止処理
  // 録画中にケーブルが抜けるなどしてカメラ接続が切れた場合、
  // 録画中フラグが立ったままだとUIと内部状態が矛盾するため、強制的にOFFにします。
  useEffect(() => {
    // 条件: カメラが切断され(isCameraConnected === false)、かつ現在録画中(isRecording === true)の場合
    if (!isCameraConnected && isRecording) {
      console.warn("Camera disconnected during recording. Stopping recording.");
      setIsRecording(false);
      toast.error("Recording stopped due to disconnection.");
    }
    // 依存配列: これらの変数のいずれかが変化するたびに、上記のチェックが走ります。
  }, [isCameraConnected, isRecording, setIsRecording]);

  // 録画ボタンが押された時の処理
  const toggleRecording = () => {
    if (isRecording) {
      console.log("Stop Recording...")
      // TODO: ここにバックエンド(Python/Rust)への録画停止リクエストを実装予定
    } else {
      console.group("Start Recording...")
      // TODO: ここにバックエンドへの録画開始リクエストを実装予定
    }
    // 状態を反転させる（true -> false, false -> true）
    setIsRecording(!isRecording);
  };

  // 現在のモード（currentMode）に応じて、メインエリアに表示するコンポーネントを切り替える関数
  const renderContent = () => {
    switch (currentMode) {
      case "devices":
        return <DevicesView />;
      case "manual":
        return <ManualView />;
      case "auto":
        return <div className="p-8 text-2xl font-bold text-muted-foreground">▶️ Auto Mode Area</div>;
      case "settings":
        return <SettingsView />;
      default:
        return null;
    }
  };

  // ヘッダー用のアクションボタンコンポーネント（Tooltip付き）
  // マウスホバー時に説明文（label）を表示するUI部品です。
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
    // 画面の大枠レイアウト（全体を縦並び flex-col）
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

            {/* Status Badge: システムの状態を表示するバッジ（点滅アニメーション付き） */}
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
          {/* Sidebar: 左側のナビゲーションメニュー */}
          <AppSidebar />

          {/* メインコンテンツ表示エリア: renderContent()の結果がここに表示される */}
          <main className="flex-1 overflow-auto bg-secondary/20 relative">
            {/* 現在のモードに対応した画面 */}
            {renderContent()}
          </main>
        </div>

        {/* ログパネル: 画面下部にログを表示。z-50で最前面に表示 */}
        <div className="shrink-0 z-50">
          <LogPanel />
        </div>

        {/* トースト通知: エラーや成功メッセージを画面上部にポップアップ表示 */}
        <Toaster richColors position="top-center" />
      </div>
    </TooltipProvider>
  )
}

export default App;
