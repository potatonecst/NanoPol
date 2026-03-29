import { z } from "zod";

// バリデーションルールの定義
// フォームに入力されるデータの「形」と「制約」をここで定義します。
export const setupFormSchema = z.object({
    // z.coerce.number():
    // HTMLの<input type="number">は、実は文字列として値を返すことがあります。
    // coerce（強制変換）を使うことで、"100" という文字列が来ても自動的に数値の 100 に変換してから検証します。
    laserPower: z.coerce
        .number()
        .min(0, "0以上の値を入力してください")
        .max(1000, "値が大きすぎます"), // 上限も設定可能

    fiberX: z.coerce
        .number()
        .int("整数で入力してください"), // 小数点以下を許容しない

    fiberY: z.coerce
        .number()
        .int("整数で入力してください"),
});

// スキーマから型を自動生成
// TypeScriptの型定義（type SetupFormValues = { laserPower: number; ... }）を
// 上記のスキーマから自動的に抽出します。
// これにより、バリデーションルールと型定義が常に一致し、二重管理の手間がなくなります。
export type SetupFormValues = z.infer<typeof setupFormSchema>;