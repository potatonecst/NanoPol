import { z } from "zod";

const STEP_RESOLUTION = 0.0025;
const EPSILON = 0.001; // 浮動小数点誤差の許容範囲

// カスタムバリデーションロジック: ステップ倍数チェック
const isMultipleOfStep = (val: number) => {
    if (val === 0) return true;
    const divided = val / STEP_RESOLUTION;
    const rounded = Math.round(divided);
    return Math.abs(divided - rounded) < EPSILON;
};

// 共通の角度入力スキーマ
export const angleInputSchema = z
    .union([z.number(), z.string()])
    .transform((val) => {
        if (typeof val === "number") return val;
        if (val.trim() === "") return NaN;
        return Number(val);
    })
    .refine((val) => !isNaN(val), {
        message: "値を入力してください"
    })
    .refine(isMultipleOfStep, {
        message: `値は ${STEP_RESOLUTION} の倍数である必要があります`,
    });

// 個別の操作に対するスキーマ定義（必要に応じて拡張可能）
export const manualControlSchema = z.object({
    moveStep: angleInputSchema,
    targetAngle: angleInputSchema,
    sweepStart: angleInputSchema,
    sweepEnd: angleInputSchema,
    // sweepSpeedは倍数制限なし、正の値であること
    sweepSpeed: z.coerce.number().positive("速度は正の値である必要があります"),
});
