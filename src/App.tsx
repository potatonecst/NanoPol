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

import "./App.css";
import { cameraApi, systemApi } from "./api/client";
import { save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile, mkdir, BaseDirectory, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { LogPanel } from "./components/shared/LogPanel";

// 共通の定数ファイルから設定ファイル名をインポート
import { CONFIG_FILENAME, DEFAULT_SETTINGS, getDefaultOutputDirectory } from "./constants/constants";

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

  // 【アプリ起動時の初期設定同期】
  // アプリが起動した直後（最初の1回だけ）に、保存されている設定をバックエンドに送信します。
  // これをやらないと、Settings画面を開くまでの間、バックエンドがデフォルトの保存先(backend直下)を使ってしまいます。
  useEffect(() => {
    const syncInitialSettings = async () => {
      try {
        let settings;
        const configExists = await exists(CONFIG_FILENAME, { baseDir: BaseDirectory.AppConfig });

        if (configExists) {
          const contents = await readTextFile(CONFIG_FILENAME, { baseDir: BaseDirectory.AppConfig });
          settings = JSON.parse(contents);
        } else {
          // 【初回起動時】config.jsonが存在しない場合、デフォルト設定を生成して保存する
          const defaultPath = await getDefaultOutputDirectory();

          settings = {
            // constantsからデフォルト設定を展開（コピー）し、パスだけ動的に設定する
            ...DEFAULT_SETTINGS,
            outputDirectory: defaultPath || "",
          };

          // AppConfigディレクトリがなければ作成し、デフォルトのconfig.jsonを書き込む
          if (!(await exists("", { baseDir: BaseDirectory.AppConfig }))) {
            await mkdir("", { baseDir: BaseDirectory.AppConfig, recursive: true });
          }
          await writeTextFile(CONFIG_FILENAME, JSON.stringify(settings, null, 2), { baseDir: BaseDirectory.AppConfig });
          console.log("Created default config.json at AppConfig directory.");
        }

        // バックエンドに設定（読み込んだもの、または新規作成したもの）を適用
        await systemApi.updateSettings(settings);
        systemApi.postLogs("INFO", "Settings synced to backend on startup.").catch(() => { });
      } catch (error) {
        console.warn("Failed to sync settings on startup:", error);
      }
    };

    syncInitialSettings();
  }, []); // 空の依存配列により、マウント時のみ実行

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
  const toggleRecording = async () => {
    try {
      if (isRecording) {
        // 録画停止リクエスト
        const res = await cameraApi.stopRecording();

        // 成功したら状態をOFFにする
        setIsRecording(false);
        toast.success(`Recording stopped: ${res.filepath}`);
        systemApi.postLogs("INFO", `Recording stopped: ${res.filepath}`).catch(() => { });
      } else {
        // 録画開始リクエスト
        const res = await cameraApi.startRecording();

        // 成功したら状態をONにする
        setIsRecording(true);
        toast.success(`Recording started: ${res.filepath}`);
        systemApi.postLogs("INFO", `Recording started: ${res.filepath}`).catch(() => { });
      }
    } catch (error) {
      console.error("Recording error:", error);
      // エラーが起きた場合は状態を反転させず、警告を出す
      const action = isRecording ? "stop" : "start";
      toast.error(`Failed to ${action} recording`);
      systemApi.postLogs("ERROR", `Failed to ${action} recording: ${error}`).catch(() => { });
    }
  };

  /**
   * スナップショット撮影ボタンのハンドラー
   * 
   * 1. バックエンドに撮影リクエスト（takeSnapshot）を送信します。
   * 2. 設定(askSavePath)がOFFの場合、バックエンドが自動で保存し `saved` ステータスを返すので、完了通知を出します。
   * 3. 設定(askSavePath)がONの場合、バックエンドはメモリに画像を保持して `pending` を返すので、
   *    フロントエンド側でOSの保存ダイアログを開き、ユーザーが指定したパスをバックエンドに送信して保存を確定させます。
   */
  const handleSnapshot = async () => {
    if (!isCameraConnected) return; // カメラ未接続時は何もしない

    try {
      // バックエンドに撮影を指示
      const res = await cameraApi.takeSnapshot();

      if (res.status === "saved") {
        toast.success(`Snapshot saved: ${res.filepath}`);
        systemApi.postLogs("INFO", `Snapshot saved automatically to ${res.filepath}`).catch(() => { });
      } else if (res.status === "pending") {
        // 1. 設定ファイル(config.json)から現在の設定を読み込む
        // Zustand等のグローバル状態には保存先設定を持たせていないため、TauriのAPIで直接OSのファイルシステムから読み取ります。
        // BaseDirectory.AppConfig を指定することで、SettingsViewで保存した時と全く同じ
        // OS標準のアプリ設定フォルダ（Windows: AppData/Roaming/nanopol, macOS: Library/Application Support/nanopol 等）
        // にある config.json を自動的に参照します。
        let defaultDir = "";
        let prefix = "snapshot_";
        let ext = "tif";
        let formatName = "TIFF Image";

        try {
          // TauriのセキュアなファイルアクセスAPIを使用します。
          // baseDir: BaseDirectory.AppConfig を指定することで、OS標準のアプリ設定フォルダを起点とし、
          // その中にある CONFIG_FILENAME (config.json) を読み込みます。
          // これにより、OSのパス区切り文字の違いやアクセス権限の問題をTauriが自動で解決してくれます。
          const contents = await readTextFile(CONFIG_FILENAME, { baseDir: BaseDirectory.AppConfig });
          const settings = JSON.parse(contents);

          defaultDir = settings.outputDirectory || "";
          prefix = settings.snapshotPrefix || "snapshot_";

          // 設定画面で選ばれている Image Format に応じて、強制的に使用する拡張子を1つに絞ります。
          // これにより、バックエンド（Python）が生成する画像形式と、保存されるファイルの拡張子が一致することを保証します。
          if (settings.imageFormat === "JPEG") { ext = "jpg"; formatName = "JPEG Image"; }
          else if (settings.imageFormat === "PNG") { ext = "png"; formatName = "PNG Image"; }
        } catch (e) {
          console.warn("Could not read config.json, using defaults.", e);
        }

        // 2. タイムスタンプ文字列の生成 (例: 20260404_185733)
        const now = new Date();
        const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
        const defaultFilename = `${prefix}${timestamp}.${ext}`;

        // 3. Tauriのネイティブ保存ダイアログを開く
        const filePath = await save({
          title: "Save Snapshot",
          // join関数を使うことで、Mac(/)やWindows(\)の区切り文字の違いを気にせず安全にパスを結合できます。
          defaultPath: defaultDir ? await join(defaultDir, defaultFilename) : defaultFilename,
          filters: [{
            // filtersに複数の拡張子を渡すとOSのダイアログでユーザーが自由に変更できてしまうため、
            // ここでは config.json から読み取った1つの拡張子（ext）だけを渡し、フォーマットをロックします。
            name: formatName,
            extensions: [ext] // ここで拡張子を一つに絞ることで、OSのダイアログでも他の形式を選べなくなります
          }]
        });

        if (filePath) {
          // ユーザーがパスを選択したら、バックエンドに送って保存を実行
          const saveRes = await cameraApi.saveSnapshot(filePath);
          toast.success("Snapshot saved successfully");
          systemApi.postLogs("INFO", `Snapshot saved to ${saveRes.filepath} via dialog`).catch(() => { });
        } else {
          // ユーザーがダイアログで「キャンセル」を押した場合
          toast.info("Snapshot saving cancelled");
          systemApi.postLogs("INFO", "User cancelled snapshot save dialog").catch(() => { });
        }
      }
    } catch (error) {
      console.error("Snapshot error:", error);
      toast.error("Failed to take snapshot");
      systemApi.postLogs("ERROR", `Failed to take snapshot: ${error}`).catch(() => { });
    }
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
                onClick={handleSnapshot}
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
