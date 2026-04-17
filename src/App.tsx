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
import { cameraApi, systemApi, setApiBase } from "./api/client";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile, mkdir, BaseDirectory, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { LogPanel } from "./components/shared/LogPanel";
import { useStagePolling } from "./hooks/useStagePolling";

// 共通の定数ファイルから設定ファイル名をインポート
import { CONFIG_FILENAME, DEFAULT_SETTINGS, getDefaultOutputDirectory } from "./constants/constants";

function App() {
  const {
    currentMode,
    isBackendConnected,
    isStageConnected,
    isCameraConnected, // 現在選択されているモードと、カメラ接続状態
    isRecording, setIsRecording, // 録画中かどうかのフラグと、それを更新する関数
    isStageBusy,
    isMeasuring,
  } = useAppStore(
    // 【パフォーマンス最適化】
    // useShallow を使うことで、ここで取り出した値（currentModeなど）が変化した時だけ
    // Appコンポーネントを再レンダリングするようにしています。
    // これを使わないと、ストア内の無関係なデータ（例えばステージの位置情報など）が変わっただけでも
    // 画面全体が再描画されてしまい、動作が重くなる原因になります。
    useShallow((state) => ({
      currentMode: state.currentMode,
      isBackendConnected: state.isBackendConnected,
      isStageConnected: state.isStageConnected,
      isCameraConnected: state.isCameraConnected,
      isRecording: state.isRecording,
      setIsRecording: state.setIsRecording,
      isStageBusy: state.isStageBusy,
      isMeasuring: state.isMeasuring,
    }))
  );

  // 1. 【監視タイマーのスタンバイ】
  // ここで呼び出しておくだけで、ステージが接続された瞬間に勝手にタイマーが回り始めます。
  useStagePolling();

  // 2. 【バックエンドの死活監視 (ハートビート) と状態復元】
  useEffect(() => {
    let healthIntervalId: number;
    let portIntervalId: number;
    let healthFailureCount = 0;
    // 初期化が複数経路（IPC / ヒント / フォールバック）から重複実行されるのを防ぐ
    let hasConnected = false;

    /**
     * Release環境でDevToolsが使えない場合に備え、接続初期化の要点をAppDataへ追記します。
     */
    const appendConnectionTrace = async (message: string) => {
      try {
        const traceFile = "frontend_connection_trace.log";
        const now = new Date().toISOString();
        const line = `[${now}] ${message}\n`;

        const fileExists = await exists(traceFile, { baseDir: BaseDirectory.AppData });
        const previous = fileExists ? await readTextFile(traceFile, { baseDir: BaseDirectory.AppData }) : "";

        await writeTextFile(traceFile, previous + line, {
          baseDir: BaseDirectory.AppData,
        });
      } catch {
        // トレース出力失敗は本体処理に影響させない
      }
    };

    /**
     * AppData に保存された `backend_port.json` を読み取り、候補ポートを返します。
     *
     * JSON には `port` / `pid` / `startedAt` を持たせますが、
     * この関数ではまず `port` の妥当性だけを厳密に検証します。
     *
     * @returns 候補ポートが読めた場合は `number`、それ以外は `null`。
     */
    const readPortHintFromAppData = async (): Promise<number | null> => {
      try {
        // ヒントファイルがなければ「未確定」と同義なのでnullを返す
        const hintExists = await exists("backend_port.json", { baseDir: BaseDirectory.AppData });
        if (!hintExists) return null;

        // JSON文字列を読み取り、port だけを候補として抽出する
        const raw = await readTextFile("backend_port.json", { baseDir: BaseDirectory.AppData });
        const parsed = JSON.parse(raw) as { port?: unknown };
        const port = Number(parsed.port);

        // TCPポート範囲外・非数値は無効値として破棄
        if (!Number.isFinite(port) || port <= 0 || port > 65535) {
          return null;
        }

        return port;
      } catch (error) {
        console.warn("Failed to read backend_port.json hint:", error);
        return null;
      }
    };

    /**
     * バックエンド接続初期化を一度だけ確定し、ヘルスチェックの定期実行を開始します。
     *
     * @param port 接続先バックエンドのポート番号。
     * @param source ポート取得元 (`tauri-ipc` | `port-hint` | `fallback`)。
     * @returns 戻り値はありません。重複呼び出し時は何もせず終了します。
     */
    const startHealthChecks = (port: number, source: "tauri-ipc" | "port-hint" | "fallback") => {
      // すでに初期化済みなら、二重でtimerを作らない
      if (hasConnected) return;
      hasConnected = true;

      // ポート探索ループはここで終了（これ以降はhealth監視フェーズへ移行）
      if (portIntervalId) window.clearInterval(portIntervalId);
      // APIクライアントのベースURLを最終確定したポートへ切り替える
      setApiBase(port);
      console.log(`Using backend port ${port} via ${source}.`);
      void appendConnectionTrace(`startHealthChecks source=${source} port=${port}`);

      // 1回目は即時に疎通確認し、以降は3秒ごとに定期監視する
      checkSystemHealth();
      healthIntervalId = window.setInterval(checkSystemHealth, 3000);
    };

    /**
     * 候補ポートに対して `/health` を1回だけ問い合わせ、
     * 本当に接続先として使ってよいかを確認します。
     *
     * ヒントファイルが古くても、ここで失敗したら採用しないことで
     * 誤接続や Offline 固定を避けます。
     *
     * @param port 検証したい候補ポート。
     * @returns `true` なら疎通可能、`false` なら無効。
     */
    const probeBackendPort = async (port: number): Promise<boolean> => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          method: "GET",
          cache: "no-store",
        });
        if (!response.ok) {
          void appendConnectionTrace(`probeBackendPort failed port=${port} status=${response.status}`);
        }
        return response.ok;
      } catch (error) {
        console.warn(`Health probe failed for candidate port ${port}:`, error);
        void appendConnectionTrace(`probeBackendPort exception port=${port} error=${String(error)}`);
        return false;
      }
    };

    /**
     * 現在設定されたAPIベースURLに対して `/health` を実行し、
     * グローバルストアの接続状態を最新化します。
     *
     * @returns Promise<void>
     */
    const checkSystemHealth = async () => {
      try {
        // ここで使われるURLは setApiBase で確定済みのもの
        const data = await systemApi.health();
        healthFailureCount = 0;
        const state = useAppStore.getState(); // 現在の状態を取得

        // オフラインから復帰した瞬間だけログを出す（毎秒コンソールが埋まるのを防ぐ）
        if (!state.isBackendConnected) {
          console.log("Backend is back online!", data);
          void appendConnectionTrace("checkSystemHealth success backend online");
        }

        // バックエンドが生きている場合は、接続状態を常に最新に同期する
        useAppStore.setState({
          isBackendConnected: true,
          isStageConnected: data.stage_connected,
          isCameraConnected: data.camera_connected,
        });
      } catch (error) {
        healthFailureCount += 1;
        const state = useAppStore.getState();

        // 初期起動直後の失敗も追えるように、先頭数回と定期サンプルを記録する
        if (healthFailureCount <= 5 || healthFailureCount % 20 === 0) {
          void appendConnectionTrace(
            `checkSystemHealth failure count=${healthFailureCount} error=${String(error)}`
          );
        }

        // オンラインから落ちた瞬間だけエラーログを出す
        if (state.isBackendConnected) {
          console.error("Backend went offline!", error);
          useAppStore.setState({ isBackendConnected: false });
        }
      }
    };

    // 【動的ポート取得フェーズ】
    let retryCount = 0;

    /**
     * ポート確定までの接続ハンドシェイクを担当します。
     * 優先順は `tauri-ipc` -> `port-hint` -> `fallback(DEV/timeout時)` です。
     *
     * @returns Promise<void>
     */
    const fetchPortAndConnect = async () => {
      // すでに接続初期化が完了したら何もしない
      if (hasConnected) return;

      try {
        // Rustの共有メモリにポート番号が書き込まれているか尋ねる
        const port = await invoke<number | null>("get_backend_port");
        if (port !== null) {
          // 正規経路: Rust IPCでポートが取得できた
          void appendConnectionTrace(`invoke get_backend_port -> ${port}`);
          startHealthChecks(port, "tauri-ipc");
          return;
        } else {
          // 保険経路: AppDataのヒントファイルを参照
          if (retryCount === 0 || retryCount % 20 === 0) {
            void appendConnectionTrace(`invoke get_backend_port -> null retry=${retryCount}`);
          }
          const hintedPort = await readPortHintFromAppData();
          if (hintedPort !== null) {
            // 古いヒントを掴みっぱなしにしないため、先に疎通確認してから採用する
            const healthy = await probeBackendPort(hintedPort);
            if (healthy) {
              void appendConnectionTrace(`hint accepted port=${hintedPort}`);
              startHealthChecks(hintedPort, "port-hint");
              return;
            }
            void appendConnectionTrace(`hint rejected port=${hintedPort}`);
          }

          // Rustからの返答がnull（まだPythonがポートを叫んでいない）場合
          retryCount++;
          // 開発環境(DEV)は手動起動を想定して5秒(10回)でフォールバック。
          // 実機環境(PROD)はPyInstallerの解凍(Windows Defenderのスキャン等)で非常に時間がかかるため、120秒(240回)まで気長に待つ。
          const maxRetries = import.meta.env.DEV ? 10 : 240;
          if (retryCount > maxRetries) {
            // 最後の手段: 既定ポートへ切り替えて接続可否を確認
            console.warn(`Backend port not received via Tauri after ${maxRetries * 0.5}s. Falling back to default 14201.`);
            void appendConnectionTrace(`fallback to default port=14201 after retries=${retryCount}`);
            startHealthChecks(14201, "fallback");
          }
        }
      } catch (err) {
        console.warn("Failed to invoke get_backend_port:", err);
        void appendConnectionTrace(`invoke get_backend_port exception error=${String(err)}`);

        // 本番環境では、Rust側からの受け渡しが遅延していてもヒントファイルで復旧を試みる
        if (!import.meta.env.DEV) {
          const hintedPort = await readPortHintFromAppData();
          if (hintedPort !== null) {
            // 例外経路でもヒントを無条件採用せず、必ず疎通確認してから使う
            const healthy = await probeBackendPort(hintedPort);
            if (healthy) {
              // 本番ではIPC失敗時でもヒント経路が取れれば復旧させる
              void appendConnectionTrace(`hint accepted on invoke exception port=${hintedPort}`);
              startHealthChecks(hintedPort, "port-hint");
              return;
            }
            void appendConnectionTrace(`hint rejected on invoke exception port=${hintedPort}`);
          }
        }

        // ブラウザ（localhost:1420等）での開発時はTauriのinvoke自体が使えないため即フォールバック
        if (import.meta.env.DEV) {
          console.warn("Running in DEV mode without Tauri. Falling back to 14201.");
          // 開発時は手動起動(固定ポート)を想定して即フォールバック
          void appendConnectionTrace("dev mode fallback to default port=14201");
          startHealthChecks(14201, "fallback");
        }
        // 本番環境(PROD)では、Tauri IPCの準備遅延等の可能性があるため、即フォールバックはせず再試行を継続する
      }
    };

    // アプリ起動時、Rustからポート番号が返ってくるまで0.5秒おきに尋ね続ける
    fetchPortAndConnect();
    portIntervalId = window.setInterval(fetchPortAndConnect, 500);

    return () => {
      window.clearInterval(portIntervalId);
      if (healthIntervalId) window.clearInterval(healthIntervalId);
    };
  }, []);

  // ダークモードの状態管理（trueならダークモード、falseならライトモード）
  const [isDark, setIsDark] = useState(false);

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

  // ヘッダーのステータス表示ロジック
  let systemStatusText = "Backend Offline";
  let shortStatusText = "Offline";
  let badgeClasses = "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20";
  let dotClasses = "bg-red-500";
  let pingClasses = "bg-red-400";
  let showPing = false;

  if (!isBackendConnected) {
    // バックエンドが落ちている場合は赤色（デフォルト設定のまま）で警告
    showPing = true;
  } else if (isMeasuring) {
    systemStatusText = "Measuring (Auto Mode)...";
    shortStatusText = "Measuring";
    badgeClasses = "border-yellow-500/20 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 hover:bg-yellow-500/20";
    dotClasses = "bg-yellow-500";
    pingClasses = "bg-yellow-400";
    showPing = true;
  } else if (isStageBusy) {
    systemStatusText = "Stage Moving...";
    shortStatusText = "Moving";
    badgeClasses = "border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20";
    dotClasses = "bg-blue-500";
    pingClasses = "bg-blue-400";
    showPing = true;
  } else if (isStageConnected && isCameraConnected) {
    systemStatusText = "All Devices Ready";
    shortStatusText = "All Rdy";
    badgeClasses = "border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20";
    dotClasses = "bg-green-500";
    pingClasses = "bg-green-400";
    showPing = true;
  } else if (isStageConnected) {
    systemStatusText = "Stage Ready";
    shortStatusText = "Stage Rdy";
    badgeClasses = "border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20";
    dotClasses = "bg-green-500";
    pingClasses = "bg-green-400";
    showPing = true;
  } else if (isCameraConnected) {
    systemStatusText = "Camera Ready";
    shortStatusText = "Cam Rdy";
    badgeClasses = "border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20";
    dotClasses = "bg-green-500";
    pingClasses = "bg-green-400";
    showPing = true;
  } else {
    // バックエンドは元気だが、デバイスは未接続（平和な待機状態）
    systemStatusText = "System Ready";
    shortStatusText = "Ready";
    badgeClasses = "border-slate-500/20 bg-slate-500/10 text-slate-600 dark:text-slate-400 hover:bg-slate-500/20";
    dotClasses = "bg-slate-500";
    pingClasses = "bg-slate-400";
  }

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
                className={`gap-1.5 py-1 px-3 font-medium transition-colors ${badgeClasses}`}
              >
                <span className="relative flex size-2">
                  {showPing && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${pingClasses}`} />}
                  <span className={`relative inline-flex rounded-full size-2 ${dotClasses}`} />
                </span>
                <div className="hidden md:inline-flex">{systemStatusText}</div>
                <div className="md:hidden">{shortStatusText}</div>
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
