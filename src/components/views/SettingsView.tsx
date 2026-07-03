import React, { useEffect, useState } from "react";
// React Hook Form: フォームの状態管理（入力値、エラー、送信処理など）を簡単に行うためのライブラリ
import { useForm, Controller } from "react-hook-form";
// zodResolver: バリデーションライブラリ Zod と React Hook Form を連携させるためのアダプター
import { zodResolver } from "@hookform/resolvers/zod";
import {
  settingsSchema,
  Settings,
  ImageFormats,
  RecordFormats,
  CameraModes,
} from "../../schemas/settingsSchema";
import { useAppStore } from "@/store/useAppStore";
import { useShallow } from "zustand/react/shallow";

// Tauri APIs
// open: ネイティブのファイル選択ダイアログを開く関数
import { open } from "@tauri-apps/plugin-dialog";
import {
  readTextFile,
  writeTextFile,
  BaseDirectory,
  mkdir,
  exists,
} from "@tauri-apps/plugin-fs";

// UI Components (shadcn/ui)
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Loader2,
  FolderOpen,
  Save,
  RotateCcw,
  TriangleAlert,
  Activity,
} from "lucide-react";
import { Switch } from "../ui/switch";
import { toast } from "sonner";
import { systemApi } from "@/api/client";

// 共通の定数ファイルから設定ファイル名をインポート
import { CONFIG_FILENAME, DEFAULT_SETTINGS, getDefaultOutputDirectory, DEFAULT_EXPOSURE_MIN_MS, DEFAULT_EXPOSURE_MAX_MS, DEFAULT_EXPOSURE_STEP_MS, DEFAULT_GAIN_MIN, DEFAULT_GAIN_MAX } from "../../constants/constants";

/**
 * 設定画面 (Settings View) コンポーネント
 * 
 * ユーザーがアプリケーションの全体設定（保存先フォルダ、カメラのデフォルト値、ステージのデフォルト速度など）を
 * 変更・保存するための画面です。
 * 
 * 【内部動作】
 * 1. 起動時に `config.json` を読み込み、フォームに反映します（存在しない場合はデフォルト値を設定）。
 * 2. ユーザーが変更を行い「Save Settings」を押すと、変更内容を `config.json` に保存します。
 * 3. 同時に、バックエンド（FastAPI）にも `/system/settings` 経由で変更を送信し、
 *    ハードウェア（カメラやステージ）の動作に即時反映させます。
 */
export const SettingsView: React.FC = () => {
  // 画面の読み込み状態（ローディング中かどうか）。初期値はtrue。
  // useState: コンポーネント内で変化するデータ（状態）を管理するReactのフックです。
  const [isLoading, setIsLoading] = useState(true);

  // 現在選択されているカテゴリの管理
  // 【重要】ReactのHookルールに基づき、早期リターン（Early Return）よりも必ず前で定義する必要があります。
  const [activeCategory, setActiveCategory] = useState<"file" | "hardware" | "measurement">("file");

  // React Hook Form の初期化
  // useForm は、フォームの入力値、エラー、送信状態などを一元管理するためのフックです。
  // 【useFormを使うメリット】
  // 1. コードがスッキリする: useStateを個別の入力項目ごとに作る必要がありません。
  // 2. パフォーマンスが良い:
  //    useStateを使うと、1文字入力するたびにコンポーネント全体（SettingsView）が再レンダリングされます。
  //    useFormは「非制御コンポーネント(ref)」の仕組みを使い、入力時は画面全体を再レンダリングせず、
  //    必要なタイミング（バリデーション時や送信時）だけ処理を行うため高速です。
  // 3. バリデーション連携: Zodなどのライブラリと組み合わせて、入力値のチェック（必須、数値範囲など）を簡単に実装できます。
  // <Settings>: フォームが扱うデータの型（TypeScriptの型定義）を指定しています。
  const form = useForm<Settings>({
    resolver: zodResolver(settingsSchema) as any,
    mode: "onChange", // 追加: 最初から1ストロークごとにリアルタイムでバリデーションを行う
    defaultValues: {
      // outputDirectory はOS依存で実行時に決まるため、ここではいったん空文字にする。
      // 先にフォームを描画し、初回起動時だけ useEffect で実パスを後から入れる。
      // それ以外の固定値だけを DEFAULT_SETTINGS から展開する。
      ...(DEFAULT_SETTINGS as any),
      outputDirectory: "",
    },
  });

  // 現在選択されている画像フォーマットを監視し、対応する拡張子を決定する
  const currentFormat = form.watch("imageFormat");

  // ストアからカメラのキャッシュされたレンジを購読する（変化があれば再レンダリングされる）
  const { cameraExposureRange, cameraGainRange } = useAppStore(
    useShallow((s) => ({ cameraExposureRange: s.cameraExposureRange, cameraGainRange: s.cameraGainRange }))
  );

  /**
   * 画像フォーマット名から対応する拡張子を取得します。
   * @param format - 選択された画像フォーマット（例: "JPEG", "TIFF"）
   * @returns 対応する拡張子の文字列（例: ".jpg", ".tif"）
   */
  const getExtension = (format: string) => {
    switch (format) {
      case "JPEG": return ".jpg";
      case "PNG": return ".png";
      case "TIFF": default: return ".tif";
    }
  };
  const currentExt = getExtension(currentFormat); //現在指定しているフォーマットの拡張子

  // 【初期化処理】
  // コンポーネントがマウントされた（画面に表示された）直後に1回だけ実行されます。
  // useEffect: コンポーネントの表示時やデータ変更時に副作用（API呼び出しなど）を実行するフックです。
  // 設定ファイルを読み込み、フォームに値をセットします。
  useEffect(() => {
    /**
     * 設定ファイルを非同期で読み込み、フォームに初期値をセットする関数
     */
    const initSettings = async () => {
      // 非同期処理（async/await）を使って、ファイル読み込みを行います。
      try {
        // 1. 設定ファイルの存在確認
        // exists: 指定したパスにファイルがあるか確認するTauriの関数です。
        // BaseDirectory.AppConfig: OS標準のアプリ設定フォルダ（例: WindowsならAppData/Roaming/...）を指します。
        const configExists = await exists(CONFIG_FILENAME, {
          baseDir: BaseDirectory.AppConfig,
        });

        if (configExists) {
          // 設定ファイルがある場合: 読み込んでJSONパースし、フォームに反映(reset)
          // readTextFile: テキストファイルの中身を文字列として読み込むTauriの関数です。
          const contents = await readTextFile(CONFIG_FILENAME, {
            baseDir: BaseDirectory.AppConfig,
          });
          const savedSettings = JSON.parse(contents);

          // 【重要】古い設定ファイル(config.json)に新しい項目のキーが存在しない場合、
          // undefinedとして上書きされ、入力欄が空欄になってしまうのを防ぐためのマージ処理です。
          const mergedSettings = {
            ...form.getValues(), // スキーマで定義したデフォルト値をベースにする
            ...savedSettings,    // 保存された値で上書きする（存在するものだけ）
          };

          // form.reset: フォームの値を新しいデータで上書きする関数です。
          form.reset(mergedSettings);
        } else {
          // 設定ファイルがない初回起動時だけ、OSのドキュメントフォルダ配下を初期値として入れる。
          // defaultValues で空文字にしているのは、ここで実行時のパスを後から確定させるため。
          // つまり、空文字は最終値ではなく「後で埋めるための仮の初期値」。
          const defaultPath = await getDefaultOutputDirectory();
          // form.setValue: フォームの特定の項目の値をプログラムから設定する関数です。
          // これを実行すると、内部の値が書き換わり、UIにも反映されます。
          form.setValue("outputDirectory", defaultPath || "");
        }
      } catch (error) {
        console.error("Failed to load settings:", error);
        toast.error("設定の読み込みに失敗しました");
        // バックエンドにもエラーログを送信
        systemApi.postLogs("ERROR", `Failed to load settings: ${error}`);
      } finally {
        // 成功しても失敗しても、読み込み完了としてローディング表示を消す
        setIsLoading(false);
      }
    };

    // 定義した非同期関数を実行
    initSettings();
    // 【重要】依存配列を空配列 [] にすることで、このuseEffectは「最初の1回だけ」実行されます。
    // もし [form] などを入れると、入力のたびに設定がリセットされてしまうバグになります。
  }, []);

  /**
   * 保存ボタンが押された時の処理 (onSubmit)
   * 
   * react-hook-form の handleSubmit によって、バリデーション通過後に呼ばれます。
   * 
   * @param data - フォームに入力された値がオブジェクトとして渡されます。Zodスキーマのバリデーションを通過済みの安全なデータです。
   */
  const onSubmit = async (data: Settings) => {
    try {
      // 保存前にカメラの露光レンジがあれば step/min/max に基づいてクランプと丸めを行う
      try {
        const cameraExposureRange = useAppStore.getState().cameraExposureRange;
        const exposureMin = cameraExposureRange?.min ?? DEFAULT_EXPOSURE_MIN_MS;
        const exposureMax = cameraExposureRange?.max ?? DEFAULT_EXPOSURE_MAX_MS;
        const exposureStep = cameraExposureRange?.step ?? DEFAULT_EXPOSURE_STEP_MS;

        const roundToStep = (val: number, min: number, step: number) => {
          // step が 0.1 や 0.01 でも、float の誤差でズレないように整数スケールへ変換して計算する。
          const decimals = (String(step).split(".")[1] || "").length;
          const scale = Math.pow(10, decimals);
          const stepInt = Math.round(step * scale);
          const deltaInt = Math.round((val - min) * scale);
          const rounded = Math.round(deltaInt / stepInt) * stepInt / scale + min;
          return Math.min(exposureMax, Math.max(exposureMin, Number(rounded.toFixed(decimals))));
        };

        if (typeof data.defaultExposure === "number") {
          // 設定ファイルに保存する前に、デバイスが受け付ける露光刻みに合わせる。
          data.defaultExposure = roundToStep(data.defaultExposure, exposureMin, exposureStep);
        }

        // Gain の安全クランプ（キャッシュ済みのデバイス範囲があればそれを優先）
        if (typeof data.defaultGain === "number") {
          const cameraGainRange = useAppStore.getState().cameraGainRange;
          const gainMin = cameraGainRange?.min ?? DEFAULT_GAIN_MIN;
          const gainMax = cameraGainRange?.max ?? DEFAULT_GAIN_MAX;
          data.defaultGain = Math.min(gainMax, Math.max(gainMin, data.defaultGain));
        }
      } catch (e) {
        console.debug("Exposure clamp error, continuing:", e);
      }

      // 保存処理中はローディング表示にする
      setIsLoading(true);
      // 1. AppConfigディレクトリが存在することを確認（なければ作成）
      // ここでは config.json の置き場所を先に確保する。
      // mkdir: ディレクトリを作成するTauriの関数です。
      // recursive: true にすると、親フォルダがない場合でもまとめて作成してくれます。
      if (!(await exists("", { baseDir: BaseDirectory.AppConfig }))) {
        await mkdir("", { baseDir: BaseDirectory.AppConfig, recursive: true });
      }

      // 2. JSONとしてファイルに書き込み
      // ここで最終的なフォーム値をそのまま config.json に保存する。
      // outputDirectory は初回起動時に空文字ではなく実パスへ置き換わっているため、通常は空のまま保存されない。
      // writeTextFile: 文字列をファイルに保存するTauriの関数です。
      // JSON.stringify: JavaScriptオブジェクトをJSON文字列に変換します（null, 2 は整形用）。
      await writeTextFile(CONFIG_FILENAME, JSON.stringify(data, null, 2), {
        baseDir: BaseDirectory.AppConfig,
      });

      // 3. 出力先ディレクトリの作成（存在しない場合）
      // ユーザーが指定したパス（またはデフォルトパス）を実際に作成します
      if (data.outputDirectory) {
        // 絶対パスで指定されたフォルダが存在するか確認します。
        // ここでは baseDir を指定していないので、フルパスとして扱われます。
        if (!(await exists(data.outputDirectory))) {
          await mkdir(data.outputDirectory, { recursive: true });
        }
      }

      // 成功通知（トースト表示）
      toast.success("設定を保存しました");
      // ファイル保存の成功をログに記録
      systemApi.postLogs("INFO", "Settings saved to config.json successfully.");

      // 4. バックエンド(FastAPI)に設定変更を通知して即時反映させる
      try {
        // APIクライアントを経由して通信を行う
        await systemApi.updateSettings(data);
        console.log("Settings synced to backend successfully.");
      } catch (backendError) {
        console.error("Failed to sync settings to backend:", backendError);
        // ファイルへの保存自体は成功しているので、エラーではなく警告（warning）としてユーザーに知らせる
        toast.warning("設定は保存されましたが、機器への即時反映に失敗しました（バックエンド未接続など）");
        // バックエンドに警告ログを送信（バックエンドが落ちている場合はこの通信も失敗する可能性がありますが、
        // 少なくとも「同期失敗」というフロントエンド側の事象を記録しようと試みます）
        systemApi.postLogs("WARNING", `Settings saved locally but backend sync failed: ${backendError}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
      }

    } catch (error) {
      // ここに到達するのは、Tauriのファイル書き込み(writeTextFile)などに失敗した場合のみです。
      console.error("Failed to save settings:", error);
      toast.error("保存に失敗しました");
      // バックエンドへのログ送信も試みますが、バックエンドが落ちている可能性も考慮してエラーはコンソールに出すだけに留めます。
      systemApi.postLogs("ERROR", `Failed to save settings: ${error}`).catch((e) => console.debug("※ログ送信も失敗しました:", e));
    } finally {
      // 成功・失敗に関わらず、処理が終わったらローディングを解除
      setIsLoading(false);
    }
  };

  /**
   * フォルダ選択ダイアログを開く処理
   * 
   * Tauriのネイティブダイアログプラグイン(`@tauri-apps/plugin-dialog`)を呼び出し、
   * ユーザーにOSのフォルダ選択画面を表示します。選択されたパスはフォームに反映されます。
   */
  const handleSelectDir = async () => {
    console.log("Browse button clicked. Trying to open dialog...");
    try {
      // Tauriのダイアログプラグインを使用
      // open: ネイティブのファイル/フォルダ選択ダイアログを表示する関数です。
      const selected = await open({
        directory: true, // trueにすると、ファイルではなくフォルダを選択するモードになります。
        multiple: false, // falseにすると、1つのフォルダしか選択できなくなります。
        defaultPath: form.getValues("outputDirectory"), // ダイアログが開いたときの初期フォルダを指定します。
      });
      console.log("Dialog selection result:", selected);

      // 選択された場合、パス（文字列）が返ってきます。キャンセルされた場合は null が返ります。
      if (selected && typeof selected === "string") {
        // 選択されたパスをフォームに設定し、バリデーション（入力チェック）を実行します。
        form.setValue("outputDirectory", selected, { shouldValidate: true });
      } else {
        console.log("Dialog was cancelled or returned an unexpected value.");
      }
    } catch (error) {
      console.error("Dialog error:", error);
    }
  };

  // 初期読み込み中（かつ、まだディレクトリ設定が空の場合）は、画面全体にローディングスピナーを表示して待機させます。
  if (isLoading && !form.getValues("outputDirectory")) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }


  // 画面の描画（JSX）
  return (
    // 【全体レイアウト】
    // inset-0: 画面いっぱいに広げます。flex-col: ヘッダー、メイン領域、フッターを縦に並べます。
    // overflow-hidden: 画面全体の不要なスクロールやバウンスを防ぎます。
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-background">
      {/* Header (Fixed): 固定ヘッダー */}
      {/* shrink-0: 画面サイズが小さくなってもこのヘッダーは縮まず、元の高さを維持します。 */}
      <div className="p-8 pb-6 shrink-0 border-b bg-card z-10">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        </div>
      </div>

      {/* Main Content Area: メイン左右分割エリア */}
      {/* flex-col md:flex-row: モバイル時は縦並び、PCなどの画面幅(md以上)では横並び(左右分割)にします。 */}
      {/* overflow-hidden: メイン領域全体のはみ出しを防ぎ、スクロールは内部のコンテンツエリアに限定します。 */}
      <div className="flex-1 overflow-hidden flex flex-col md:flex-row max-w-6xl w-full mx-auto">
        
        {/* Sidebar Navigation: 左側カテゴリ選択サイドバー */}
        {/* w-full md:w-64: モバイル時は幅一杯、PC時は幅64(16rem/約256px)に固定します。 */}
        {/* border-r: 右側に細い区切り線を引きます（モバイル時は下側 border-b に切り替えます）。 */}
        <div className="w-full md:w-64 shrink-0 p-4 border-b md:border-b-0 md:border-r overflow-y-auto bg-muted/10">
          {/* nav: セマンティックなナビゲーション。md:flex-colによりPC時はボタンを縦一列に並べます。 */}
          <nav className="flex md:flex-col gap-2 overflow-x-auto md:overflow-x-visible pb-2 md:pb-0">
            {/* Button (File & Storage): 保存・画像等の設定カテゴリ */}
            {/* variant: 現在アクティブなカテゴリであれば secondary (灰色塗りつぶし)、それ以外は ghost (透明背景) に切り替えます。 */}
            <Button
              variant={activeCategory === "file" ? "secondary" : "ghost"}
              className={`justify-start shrink-0 ${activeCategory === "file" ? "font-semibold" : ""}`}
              onClick={() => setActiveCategory("file")} // クリックで file カテゴリをアクティブに
            >
              File & Storage
            </Button>
            {/* Button (Hardware): 機器の設定カテゴリ */}
            <Button
              variant={activeCategory === "hardware" ? "secondary" : "ghost"}
              className={`justify-start shrink-0 ${activeCategory === "hardware" ? "font-semibold" : ""}`}
              onClick={() => setActiveCategory("hardware")} // クリックで hardware カテゴリをアクティブに
            >
              Hardware
            </Button>
            {/* Button (Measurement): 自動測定のプリセット（将来機能）カテゴリ */}
            <Button
              variant={activeCategory === "measurement" ? "secondary" : "ghost"}
              className={`justify-start shrink-0 ${activeCategory === "measurement" ? "font-semibold" : ""}`}
              onClick={() => setActiveCategory("measurement")} // クリックで measurement カテゴリをアクティブに
            >
              Measurement
            </Button>
          </nav>
        </div>

        {/* Scrollable Content: 右側設定フォームエリア */}
        {/* flex-1: 残りの画面幅すべてをこのエリアに割り当てます。 */}
        {/* overflow-y-auto: 設定項目が多くスクロールが必要な場合、このエリア内部だけで縦スクロールさせます。 */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          {/* フォーム定義: onSubmitイベントで form.handleSubmit を呼び出します */}
          <form id="settings-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 max-w-3xl">

            {/* --- Category: File & Storage --- */}
            <div className={activeCategory === "file" ? "block space-y-6" : "hidden"}>
              <div className="mb-6">
                <h3 className="text-lg font-semibold tracking-tight mb-1">File & Storage</h3>
                <p className="text-sm text-muted-foreground">Manage where and how your measurement data is saved.</p>
              </div>

              {/* General File Settings */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Output Directory</CardTitle>
                </CardHeader>
                <CardContent>
                  <FieldGroup className="grid gap-4">
                    <Controller
                      control={form.control}
                      name="outputDirectory"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid}>
                          <div className="flex gap-2">
                            <Input {...field} id="outputDirectory" readOnly placeholder="Select a folder..." />
                            <Button type="button" variant="outline" onClick={handleSelectDir} className="shrink-0">
                              <FolderOpen className="w-4 h-4 mr-2" />
                              Browse
                            </Button>
                          </div>
                          {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                        </Field>
                      )}
                    />

                    <Controller
                      control={form.control}
                      name="askSavePath"
                      render={({ field }) => (
                        <Field orientation="horizontal" className="justify-between rounded-lg border p-4 bg-card">
                          <div className="space-y-0.5 pr-4">
                            <FieldLabel>Always ask where to save files</FieldLabel>
                            <FieldDescription>
                              If disabled, files will be saved automatically using the prefixes and timestamp.
                            </FieldDescription>
                          </div>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </Field>
                      )}
                    />
                  </FieldGroup>
                </CardContent>
              </Card>

              {/* Snapshot Settings */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Snapshot Format</CardTitle>
                </CardHeader>
                <CardContent>
                  <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Controller
                      control={form.control}
                      name="snapshotPrefix"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid}>
                          <FieldLabel htmlFor="snapshotPrefix">Prefix</FieldLabel>
                          <Input {...field} id="snapshotPrefix" />
                          <FieldDescription className="truncate">Ex: {field.value}20260101_143000{currentExt}</FieldDescription>
                          {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                        </Field>
                      )}
                    />
                    <Controller
                      control={form.control}
                      name="imageFormat"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid}>
                          <FieldLabel>Image Format</FieldLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select format" />
                            </SelectTrigger>
                            <SelectContent>
                              {ImageFormats.map((fmt) => (
                                <SelectItem key={fmt} value={fmt}>
                                  {fmt}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                        </Field>
                      )}
                    />
                  </FieldGroup>
                </CardContent>
              </Card>

              {/* Recording Settings */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Recording Format</CardTitle>
                </CardHeader>
                <CardContent>
                  <FieldGroup className="grid gap-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Controller
                        control={form.control}
                        name="recordPrefix"
                        render={({ field, fieldState }) => (
                          <Field data-invalid={fieldState.invalid}>
                            <FieldLabel htmlFor="recordPrefix">Prefix</FieldLabel>
                            <Input {...field} id="recordPrefix" />
                            <FieldDescription className="truncate">Ex: {field.value}20260101_143000.tif</FieldDescription>
                            {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                          </Field>
                        )}
                      />
                      <Controller
                        control={form.control}
                        name="recordFormat"
                        render={({ field, fieldState }) => (
                          <Field data-invalid={fieldState.invalid}>
                            <FieldLabel>Record Format (Raw TIFF)</FieldLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value}>
                              <SelectTrigger>
                                <SelectValue placeholder="Select format" />
                              </SelectTrigger>
                              <SelectContent>
                                {RecordFormats.map((fmt) => (
                                  <SelectItem key={fmt} value={fmt}>
                                    {fmt}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                            {field.value === "8-bit TIFF" && (
                              <FieldDescription className="text-amber-600 dark:text-amber-500 flex items-center gap-2 mt-2 leading-tight">
                                <TriangleAlert className="h-4 w-4 shrink-0" />
                                <span>録画開始時にモード切替のため僅かな遅延が生じる場合があります。</span>
                              </FieldDescription>
                            )}
                          </Field>
                        )}
                      />
                    </div>

                    <Controller
                      control={form.control}
                      name="autoConvertMp4"
                      render={({ field }) => (
                        <Field orientation="horizontal" className="justify-between rounded-lg border p-4 bg-card">
                          <div className="space-y-0.5 pr-4">
                            <FieldLabel>Auto Convert to MP4</FieldLabel>
                            <FieldDescription>
                              Generate a lightweight MP4 video file automatically after the measurement is complete.
                            </FieldDescription>
                          </div>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </Field>
                      )}
                    />

                    {form.watch("autoConvertMp4") && (
                      <Controller
                        control={form.control}
                        name="keepRawTiff"
                        render={({ field }) => (
                          <Field orientation="horizontal" className="justify-between rounded-lg border p-4 bg-muted/30">
                            <div className="space-y-0.5 pr-4">
                              <FieldLabel>Keep Raw TIFF Data</FieldLabel>
                              <FieldDescription>
                                If disabled, the heavy multi-page TIFF file will be deleted after MP4 conversion.
                              </FieldDescription>
                            </div>
                            <Switch checked={field.value} onCheckedChange={field.onChange} />
                          </Field>
                        )}
                      />
                    )}
                  </FieldGroup>
                </CardContent>
              </Card>
            </div>

            {/* --- Category: Hardware --- */}
            <div className={activeCategory === "hardware" ? "block space-y-6" : "hidden"}>
              <div className="mb-6">
                <h3 className="text-lg font-semibold tracking-tight mb-1">Hardware</h3>
                <p className="text-sm text-muted-foreground">Configure hardware parameters and connection settings.</p>
              </div>

               {/* 
                【デバイス接続の初期設定カード（最優先表示）】
                ユーザーが起動時に毎回COMポートを手動選択する手間を省くための永続化設定です。
                初回の誤操作による誤接続を防ぐため、初期値は空文字列（未設定）で扱われます。
                物理運動特性（Motion Profile）と論理的に分離するために独立したカードとして最上部に配置しています。
              */}
              {/* Device Connection Defaults */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Device Connection Defaults</CardTitle>
                </CardHeader>
                <CardContent>
                  <FieldGroup className="grid grid-cols-1 gap-4">
                    <Controller
                      control={form.control}
                      name="defaultStagePort"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid}>
                          <FieldLabel htmlFor="defaultStagePort">Default Stage COM Port</FieldLabel>
                          <Input {...field} id="defaultStagePort" placeholder="e.g. COM5 (Leave empty to disable auto-selection)" />
                          <FieldDescription>The COM port that will be automatically selected on startup. If left blank, no port will be pre-selected.</FieldDescription>
                          {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                        </Field>
                      )}
                    />
                  </FieldGroup>
                </CardContent>
              </Card>

              {/* Camera Settings */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Camera Initialization</CardTitle>
                </CardHeader>
                <CardContent>
                  <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Controller
                      control={form.control}
                      name="cameraMode"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid}>
                          <FieldLabel>Color Mode</FieldLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select mode" />
                            </SelectTrigger>
                            <SelectContent>
                              {CameraModes.map((mode) => (
                                <SelectItem key={mode} value={mode}>
                                  {mode}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                        </Field>
                      )}
                    />
                    {/* Placeholder for layout */}
                    <div className="hidden sm:block"></div>

                    <Controller
                      control={form.control}
                      name="defaultExposure"
                      render={({ field, fieldState }) => {
                        const exposureMin = cameraExposureRange?.min ?? DEFAULT_EXPOSURE_MIN_MS;
                        const exposureMax = cameraExposureRange?.max ?? DEFAULT_EXPOSURE_MAX_MS;
                        const exposureStep = cameraExposureRange?.step ?? DEFAULT_EXPOSURE_STEP_MS;
                        return (
                          <Field data-invalid={fieldState.invalid}>
                            <FieldLabel htmlFor="defaultExposure">Exposure (ms)</FieldLabel>
                            <Input type="number" step={exposureStep} min={exposureMin} max={exposureMax} {...field} id="defaultExposure" />
                            {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                          </Field>
                        );
                      }}
                    />
                    <Controller
                      control={form.control}
                      name="defaultGain"
                      render={({ field, fieldState }) => {
                        const gainMin = cameraGainRange?.min ?? DEFAULT_GAIN_MIN;
                        const gainMax = cameraGainRange?.max ?? DEFAULT_GAIN_MAX;
                        return (
                          <Field data-invalid={fieldState.invalid}>
                            <FieldLabel htmlFor="defaultGain">Hardware Gain (×{gainMin.toFixed(2)}-×{gainMax.toFixed(2)})</FieldLabel>
                            <Input type="number" step={0.01} min={gainMin} max={gainMax} {...field} id="defaultGain" />
                            {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                          </Field>
                        );
                      }}
                    />
                  </FieldGroup>
                </CardContent>
              </Card>

              {/* Stage Settings */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Stage Motion Profile</CardTitle>
                </CardHeader>
                <CardContent>
                  <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Controller
                      control={form.control}
                      name="defaultSpeedMin"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid}>
                          <FieldLabel htmlFor="defaultSpeedMin">Min Speed (PPS)</FieldLabel>
                          <Input type="number" {...field} id="defaultSpeedMin" step={100} />
                          {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                        </Field>
                      )}
                    />
                    <Controller
                      control={form.control}
                      name="defaultSpeedMax"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid}>
                          <FieldLabel htmlFor="defaultSpeedMax">Max Speed (PPS)</FieldLabel>
                          <Input type="number" {...field} id="defaultSpeedMax" step={100} />
                          {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                        </Field>
                      )}
                    />
                    <Controller
                      control={form.control}
                      name="defaultAccelTime"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid} className="sm:col-span-2">
                          <FieldLabel htmlFor="defaultAccelTime">Acceleration Time (ms)</FieldLabel>
                          <Input type="number" {...field} id="defaultAccelTime" />
                          <FieldDescription>Time required to reach max speed.</FieldDescription>
                          {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                        </Field>
                      )}
                    />
                  </FieldGroup>
                </CardContent>
              </Card>
            </div>

            {/* --- Category: Measurement (Future) --- */}
            <div className={activeCategory === "measurement" ? "block space-y-6" : "hidden"}>
              <div className="mb-6">
                <h3 className="text-lg font-semibold tracking-tight mb-1">Measurement</h3>
                <p className="text-sm text-muted-foreground">Configure profiles and presets for automated measurements.</p>
              </div>
              <Card className="border-dashed bg-muted/10">
                <CardContent className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                  <Activity className="w-8 h-8 mb-4 opacity-50" />
                  <p className="font-medium">Presets feature is coming soon.</p>
                  <p className="text-sm mt-1">You will be able to manage Start/End/Step angle presets here.</p>
                </CardContent>
              </Card>
            </div>

          </form>
        </div>
      </div>

      {/* Footer (Fixed) */}
      {/* 画面下部のフッター領域。保存ボタンなどを配置し、常に画面下に固定表示されます。 */}
      <div className="p-4 border-t bg-card shrink-0 z-20">
        <div className="max-w-6xl mx-auto flex justify-end gap-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => form.reset()} // リセット処理（最後に保存された値に戻す）
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Reset Changes
          </Button>
          {/* 保存ボタン: form="settings-form" を指定することで、フォームの外にあっても送信ボタンとして機能します */}
          {/* disabled={isLoading}: 保存処理中はボタンを押せないようにします */}
          <Button type="submit" form="settings-form" disabled={isLoading}>
            {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            <Save className="w-4 h-4 mr-2" />
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  );
};