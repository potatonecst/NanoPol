import { z } from "zod";

// 画像保存形式の選択肢
// as const をつけることで、単なる文字列の配列ではなく、
// "PNG" | "TIFF" | "JPEG" という具体的な値の型（リテラル型）として扱われます。
export const ImageFormats = ["PNG", "TIFF", "JPEG"] as const;

export const settingsSchema = z.object({
    // --- File I/O Settings ---
    outputDirectory: z
        .string()
        .min(1, { message: "保存先ディレクトリを入力してください" }), // 空文字を許容しない

    filenamePrefix: z
        .string()
        .default("scan_")
        // refine: カスタム検証ロジック。ここでは正規表現を使ってファイル名に使えない文字を弾いています。
        .refine((val) => /^[a-zA-Z0-9_-]+$/.test(val), {
            message: "ファイル名には英数字、ハイフン、アンダースコアのみ使用できます",
        }),
    imageFormat: z.enum(ImageFormats).default("TIFF"),

    // --- Motion Settings (Stage) ---
    // バックエンドのデフォルト値: Min=500, Max=5000, Accel=200

    // z.coerce.number():
    // フォームの入力値は文字列("500")として来ることが多いため、数値(500)に自動変換してから検証します。
    defaultSpeedMin: z.coerce
        .number()
        .min(100, "最小速度は100 PPS以上で設定してください")
        .max(20000, "安全のため20000 PPS以下で設定してください")
        // transform: 検証後の値を加工します。
        // ここでは100単位に丸めることで、中途半端な速度設定（例: 501 PPS）を防ぎます。
        .transform((val) => Math.floor(val / 100) * 100)
        .default(500),
    defaultSpeedMax: z.coerce
        .number()
        .min(100, "最大速度は100 PPS以上で設定してください")
        .max(20000, "安全のため20000 PPS以下で設定してください")
        .transform((val) => Math.floor(val / 100) * 100)
        .default(5000),
    defaultAccelTime: z.coerce
        .number()
        .min(10, "加減速時間は10ms以上で設定してください")
        .max(1000, "加減速時間は1000ms以下で設定してください")
        .default(200),

    // --- Camera Defaults ---
    defaultExposure: z.coerce.number().min(0.01).max(1000).default(10.0),
    defaultGain: z.coerce.number().min(0).max(100).default(50),
})
    // refine: オブジェクト全体に対する検証（クロスフィールドバリデーション）
    // 「最大速度」が「最小速度」より小さい場合など、複数の項目が絡む矛盾をチェックします。
    .refine((data) => data.defaultSpeedMax >= data.defaultSpeedMin, {
        message: "最大速度は最小速度以上に設定してください",
        path: ["defaultSpeedMax"], // エラーメッセージを表示するフィールドを指定
    });

// スキーマからTypeScriptの型定義を自動生成
// これにより、Settings型は { outputDirectory: string; defaultSpeedMin: number; ... } となります。
export type Settings = z.infer<typeof settingsSchema>;
