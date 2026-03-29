import { z } from "zod";

// ステージの最小分解能（これの倍数でしか動けない）
const STEP_RESOLUTION = 0.0025;

// 浮動小数点誤差の許容範囲
// コンピュータで 0.1 + 0.2 を計算すると 0.30000000000000004 になるような誤差（丸め誤差）を考慮し、
// 厳密な一致ではなく「非常に近いかどうか」で判定するために使用します。
const EPSILON = 0.001;

// カスタムバリデーションロジック: ステップ倍数チェック
// 入力された角度が、機械が動ける最小単位（0.0025度）の倍数になっているか確認します。
const isMultipleOfStep = (val: number) => {
    if (val === 0) return true;
    const divided = val / STEP_RESOLUTION;
    const rounded = Math.round(divided);
    // 割り算の結果と、それを四捨五入した整数の差が極小であれば「倍数である」とみなします。
    return Math.abs(divided - rounded) < EPSILON;
};

// 共通の角度入力スキーマ
// 複数の場所（移動量、目標角度など）で使い回せるように定義を切り出しています。
export const angleInputSchema = z
    .union([z.number(), z.string()]) // 入力は数値、または文字列（空文字含む）を受け入れます
    .transform((val) => {
        // 1. 前処理（Transform）: 入力値を扱いやすい形に変換
        if (typeof val === "number") return val;
        if (val.trim() === "") return NaN; // 空文字ならNaN（Not a Number）にする
        return Number(val); // 文字列を数値に変換
    })
    .refine((val) => !isNaN(val), {
        // 2. 検証（Refine）: 数値かどうかチェック
        message: "値を入力してください"
    })
    .refine(isMultipleOfStep, {
        // 3. 検証（Refine）: ステージの仕様に合っているかチェック
        message: `値は ${STEP_RESOLUTION} の倍数である必要があります`,
    });

// 個別の操作に対するスキーマ定義（必要に応じて拡張可能）
export const manualControlSchema = z.object({
    // 上で作った共通スキーマを再利用
    moveStep: angleInputSchema,
    targetAngle: angleInputSchema,
    sweepStart: angleInputSchema,
    sweepEnd: angleInputSchema,

    // sweepSpeed（回転速度）は倍数制限なしだが、正の値である必要がある
    // z.coerce.number() は文字列 "10" を数値 10 に変換します。
    sweepSpeed: z.coerce.number().positive("速度は正の値である必要があります"),
});
