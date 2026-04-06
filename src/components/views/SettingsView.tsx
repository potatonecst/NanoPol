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
} from "lucide-react";
import { Switch } from "../ui/switch";
import { toast } from "sonner";
import { systemApi } from "@/api/client";

// 共通の定数ファイルから設定ファイル名をインポート
import { CONFIG_FILENAME, DEFAULT_SETTINGS, getDefaultOutputDirectory } from "../../constants/constants";

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
      // constantsからデフォルト設定を展開
      ...DEFAULT_SETTINGS,
      outputDirectory: "",
    },
  });

  // 現在選択されている画像フォーマットを監視し、対応する拡張子を決定する
  const currentFormat = form.watch("imageFormat");

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
          // 2. 設定ファイルがない場合、OSのドキュメントフォルダのサブフォルダ（NanoPol）をデフォルトのアウトプットディレクトリにする
          // 共通関数からデフォルトパス（例: "Documents/NanoPol"）を取得します
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
      // 保存処理中はローディング表示にする
      setIsLoading(true);
      // 1. AppConfigディレクトリが存在することを確認（なければ作成）
      // mkdir: ディレクトリを作成するTauriの関数です。
      // recursive: true にすると、親フォルダがない場合でもまとめて作成してくれます。
      if (!(await exists("", { baseDir: BaseDirectory.AppConfig }))) {
        await mkdir("", { baseDir: BaseDirectory.AppConfig, recursive: true });
      }

      // 2. JSONとしてファイルに書き込み
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
    // 全体のレイアウト: 縦方向に並べるフレックスボックス。画面の高さ(h-full)いっぱいに広げ、はみ出しは隠す(overflow-hidden)
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* Header (Fixed) */}
      {/* 画面上部のヘッダー領域。スクロールしても常に上に固定表示されます。 */}
      <div className="p-8 pb-6 shrink-0 border-b bg-card z-10">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        </div>
      </div>

      {/* Scrollable Content */}
      {/* メインコンテンツ領域。flex-1を指定して残りの高さを全て使い、中身が多い場合はここだけスクロール(overflow-y-auto)します。 */}
      <div className="flex-1 overflow-y-auto bg-background">
        <div className="p-8 max-w-5xl mx-auto">
          {/* フォーム定義: onSubmitイベントで form.handleSubmit を呼び出します */}
          <form id="settings-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

            {/* --- General File Settings --- */}
            <Card>
              <CardHeader>
                <CardTitle>General File Settings</CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid gap-4">
                  {/* Controller: React Hook FormとUIコンポーネントを繋ぐラッパー */}
                  {/* これを使うことで、shadcn/uiのInputコンポーネントなどがフォームの状態と連動します */}
                  {/* useFormは基本「非制御」で高速ですが、Controllerを使うと明示的に「制御コンポーネント」として扱います。 */}
                  {/* これにより、値が変更されたタイミングでこのフィールド部分だけが確実に再レンダリングされ、表示が更新されます。 */}
                  {/* name属性で、Settings型のどのプロパティと紐付けるかを指定します */}
                  <Controller
                    control={form.control}
                    name="outputDirectory"
                    render={({ field, fieldState }) => (
                      // Field: ラベル、入力欄、エラーメッセージをまとめるラッパーコンポーネント
                      <Field data-invalid={fieldState.invalid}>
                        <FieldLabel htmlFor="outputDirectory">Output Directory</FieldLabel>
                        <div className="flex gap-2">
                          {/* Input: テキスト入力欄。readOnlyにすることで手入力を防ぎ、必ずBrowseボタンを使わせます */}
                          {/* {...field} を展開することで、valueやonChangeなどのイベントハンドラが自動的に設定されます */}
                          <Input {...field} id="outputDirectory" readOnly placeholder="Select a folder..." />
                          <Button type="button" variant="outline" onClick={handleSelectDir}>
                            <FolderOpen className="w-4 h-4 mr-2" />
                            Browse
                          </Button>
                        </div>
                        {/* バリデーションエラーがある場合のみ、エラーメッセージを表示します */}
                        {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                      </Field>
                    )}
                  />

                  <Controller
                    control={form.control}
                    name="askSavePath"
                    render={({ field }) => (
                      <Field orientation="horizontal" className="justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
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

            {/* --- Camera Settings --- */}
            <Card>
              <CardHeader>
                <CardTitle>Camera Settings</CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                  <Controller
                    control={form.control}
                    name="defaultExposure"
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid}>
                        <FieldLabel htmlFor="defaultExposure">Default Exposure (ms)</FieldLabel>
                        <Input type="number" step={0.1} {...field} id="defaultExposure" />
                        {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                      </Field>
                    )}
                  />
                  <Controller
                    control={form.control}
                    name="defaultGain"
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid}>
                        <FieldLabel htmlFor="defaultGain">Default Gain (0-100)</FieldLabel>
                        <Input type="number" {...field} id="defaultGain" />
                        {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                      </Field>
                    )}
                  />
                </FieldGroup>
              </CardContent>
            </Card>

            {/* --- Motion Settings --- */}
            <Card>
              <CardHeader>
                <CardTitle>Stage Motion Defaults</CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                      <Field data-invalid={fieldState.invalid}>
                        <FieldLabel htmlFor="defaultAccelTime">Accel Time (ms)</FieldLabel>
                        <Input type="number" {...field} id="defaultAccelTime" />
                        {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                      </Field>
                    )}
                  />
                </FieldGroup>
              </CardContent>
            </Card>

            {/* --- Snapshot Settings --- */}
            <Card>
              <CardHeader>
                <CardTitle>Snapshot Settings</CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Controller
                    control={form.control}
                    name="snapshotPrefix"
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid}>
                        <FieldLabel htmlFor="snapshotPrefix">Snapshot Prefix</FieldLabel>
                        <Input {...field} id="snapshotPrefix" />
                        <FieldDescription>Example: {field.value}20260101_143000{currentExt}</FieldDescription>
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

            {/* --- Recording Settings --- */}
            <Card>
              <CardHeader>
                <CardTitle>Recording Settings</CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid gap-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Controller
                      control={form.control}
                      name="recordPrefix"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid}>
                          <FieldLabel htmlFor="recordPrefix">Record Prefix</FieldLabel>
                          <Input {...field} id="recordPrefix" />
                          <FieldDescription>Example: {field.value}20260101_143000.tif</FieldDescription>
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
                          {/* 8-bit TIFF選択時に遅延の可能性に関する注意書きを表示 */}
                          {field.value === "8-bit TIFF" && (
                            <FieldDescription className="text-amber-600 dark:text-amber-500 flex items-center gap-2 mt-2">
                              <TriangleAlert className="h-4 w-4 shrink-0" />
                              <span>
                                録画開始時にモード切替のため僅かな遅延が生じる場合があります。
                              </span>
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
                      <Field orientation="horizontal" className="justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                          <FieldLabel>Auto Convert to MP4</FieldLabel>
                          <FieldDescription>
                            Generate a lightweight MP4 video file automatically after the measurement is complete.
                          </FieldDescription>
                        </div>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </Field>
                    )}
                  />

                  {/* autoConvertMp4 が ON の時だけ、TIFFを残すかどうかの設定を表示する */}
                  {form.watch("autoConvertMp4") && (
                    <Controller
                      control={form.control}
                      name="keepRawTiff"
                      render={({ field }) => (
                        <Field orientation="horizontal" className="justify-between rounded-lg border p-4 bg-muted/50">
                          <div className="space-y-0.5">
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
          </form>
        </div>
      </div>

      {/* Footer (Fixed) */}
      {/* 画面下部のフッター領域。保存ボタンなどを配置し、常に画面下に固定表示されます。 */}
      <div className="p-4 border-t bg-card shrink-0 z-10">
        <div className="max-w-5xl mx-auto flex justify-end gap-4">
          <Button
            type="button"
            variant="outline"
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