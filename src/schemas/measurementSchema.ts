import { z } from "zod";

// バリデーションルールの定義
// フォームに入力されるデータの「形」と「制約」をここで定義します。
export const setupFormSchema = z.object({
    laserPower: z.any().transform((val, ctx) => {
        // 空文字や未入力の場合はエラー（必須項目）
        if (val === "" || val === undefined || val === null) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "必須項目です",
            });
            return z.NEVER;
        }
        const num = Number(val);
        if (isNaN(num)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "数値を入力してください",
            });
            return z.NEVER;
        }
        if (num < 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "0以上の値を入力してください",
            });
            return z.NEVER;
        }
        return num;
    }),

    fiberX: z.any().transform((val, ctx) => {
        // 未入力は許容し、undefined を返す（0とは区別する）
        if (val === "" || val === undefined || val === null) return undefined;
        const num = Number(val);
        if (isNaN(num) || !Number.isInteger(num)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "整数で入力してください" });
            return z.NEVER;
        }
        return num;
    }).optional(),

    fiberY: z.any().transform((val, ctx) => {
        if (val === "" || val === undefined || val === null) return undefined;
        const num = Number(val);
        if (isNaN(num) || !Number.isInteger(num)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "整数で入力してください" });
            return z.NEVER;
        }
        return num;
    }).optional(),

    startAngle: z.coerce.number(),
    endAngle: z.coerce.number(),
    stepAngle: z.coerce.number()
        .min(0.0025, "最小分解能(0.0025)以上を指定してください")
        .max(360, "最大360度以下を指定してください"),
});

// スキーマから型を自動生成
export type SetupFormValues = z.infer<typeof setupFormSchema>;