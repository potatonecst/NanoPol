import React, { useEffect, useState } from "react";
// React Hook Form: フォームの状態管理（入力値、エラー、送信処理など）を簡単に行うためのライブラリ
import { useForm, Controller } from "react-hook-form";
// zodResolver: バリデーションライブラリ Zod と React Hook Form を連携させるためのアダプター
import { zodResolver } from "@hookform/resolvers/zod";
import {
  settingsSchema,
  Settings,
  ImageFormats,
} from "../../schemas/settingsSchema";

// Tauri APIs
// open: ネイティブのファイル選択ダイアログを開く関数
import { open } from "@tauri-apps/plugin-dialog";
import { documentDir, join } from "@tauri-apps/api/path";
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
import { Loader2, FolderOpen, Save, RotateCcw } from "lucide-react";
import { toast } from "sonner";

const CONFIG_FILENAME = "config.json";

// 設定画面のコンポーネント定義
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
    defaultValues: {
      outputDirectory: "",
      filenamePrefix: "scan_",
      imageFormat: "TIFF",
      defaultSpeedMin: 500,
      defaultSpeedMax: 5000,
      defaultAccelTime: 200,
      defaultExposure: 10.0,
      defaultGain: 50,
    },
  });

  // 【初期化処理】
  // コンポーネントがマウントされた（画面に表示された）直後に1回だけ実行されます。
  // useEffect: コンポーネントの表示時やデータ変更時に副作用（API呼び出しなど）を実行するフックです。
  // 設定ファイルを読み込み、フォームに値をセットします。
  useEffect(() => {
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
          // form.reset: フォームの値を新しいデータで上書きする関数です。
          form.reset(savedSettings);
        } else {
          // 2. 設定がない場合、OSのドキュメントフォルダのサブフォルダ（NanoPol）をデフォルトにする
          // documentDir: OSのドキュメントフォルダのパスを取得するTauriの関数です。
          const docDir = await documentDir();
          // join: パスを結合する関数です（例: "Documents" + "NanoPol" -> "Documents/NanoPol"）。
          // OSごとの区切り文字（\ や /）の違いを自動で吸収してくれます。
          const defaultPath = await join(docDir, "NanoPol");
          // form.setValue: フォームの特定の項目の値をプログラムから設定する関数です。
          // これを実行すると、内部の値が書き換わり、UIにも反映されます。
          form.setValue("outputDirectory", defaultPath || "");
        }
      } catch (error) {
        console.error("Failed to load settings:", error);
        toast.error("設定の読み込みに失敗しました");
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

  // 保存ボタンが押された時の処理 (onSubmit)
  // react-hook-form の handleSubmit によって、バリデーション通過後に呼ばれます。
  // data: フォームに入力された値がオブジェクトとして渡されます。
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

      // TODO: ここでバックエンド(Python側)に設定変更を通知する処理が必要なら追加
      // invoke('update_settings', { settings: data }) ...

    } catch (error) {
      console.error("Failed to save settings:", error);
      toast.error("保存に失敗しました");
    } finally {
      // 成功・失敗に関わらず、処理が終わったらローディングを解除
      setIsLoading(false);
    }
  };

  // フォルダ選択ダイアログを開く処理
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
    <div className="flex flex-col h-full overflow-hidden">
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
            {/* --- File I/O Settings --- */}
            {/* 設定グループ1: ファイル保存設定 */}
            <Card>
              <CardHeader>
                <CardTitle>File Save Settings</CardTitle>
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
                  <div className="grid grid-cols-2 gap-4">
                    <Controller
                      control={form.control}
                      name="filenamePrefix"
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid}>
                          <FieldLabel htmlFor="filenamePrefix">Filename Prefix</FieldLabel>
                          <Input {...field} id="filenamePrefix" />
                          <FieldDescription>Example: {field.value}001.tif</FieldDescription>
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
                  </div>
                </FieldGroup>
              </CardContent>
            </Card>

            {/* --- Motion Settings --- */}
            {/* 設定グループ2: ステージ動作設定 */}
            <Card>
              <CardHeader>
                <CardTitle>Stage Motion Defaults</CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid grid-cols-3 gap-4">
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

            {/* --- Camera Defaults --- */}
            {/* 設定グループ3: カメラ初期設定 */}
            <Card>
              <CardHeader>
                <CardTitle>Camera Defaults</CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup className="grid grid-cols-2 gap-4">
                  <Controller
                    control={form.control}
                    name="defaultExposure"
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid}>
                        <FieldLabel htmlFor="defaultExposure">Exposure (ms)</FieldLabel>
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
                        <FieldLabel htmlFor="defaultGain">Gain (0-100)</FieldLabel>
                        <Input type="number" {...field} id="defaultGain" />
                        {fieldState.invalid && <FieldError>{fieldState.error?.message}</FieldError>}
                      </Field>
                    )}
                  />
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