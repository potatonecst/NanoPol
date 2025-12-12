import { z } from "zod";

// バリデーションルールの定義
export const setupFormSchema = z.object({
    laserPower: z.coerce
        .number({ invalid_type_error: "数値を入力してください" })
        .min(0, "0以上の値を入力してください")
        .max(1000, "値が大きすぎます"), // 上限も設定可能

    fiberX: z.coerce
        .number()
        .int("整数で入力してください"),

    fiberY: z.coerce
        .number()
        .int("整数で入力してください"),
});

// スキーマから型を自動生成
export type SetupFormValues = z.infer<typeof setupFormSchema>;