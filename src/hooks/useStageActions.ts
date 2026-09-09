import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/useAppStore';
import { stageApi, systemApi } from '@/api/client';
import { toast } from 'sonner';

/**
 * ステージ操作に関する共通ロジックを提供するカスタムフック。
 * 
 * 【背景と役割】
 * 以前は ManualView と MeasurementManager でそれぞれ同じような「移動命令を送る→終わるまで待つ」
 * という処理を書いていましたが、コードの重複を避け、保守性を高めるためにこのフックに集約しました。
 * 
 * このフックは以下の「一連の流れ」を自動化します：
 * 1. UIのロック（isSystemBusy を true にする）
 * 2. バックエンドへの移動コマンド送信
 * 3. ステージが実際に動き終わるまでの監視（ポーリング）
 * 4. 成功・失敗・中断に応じたトースト通知とログ記録
 * 5. UIのロック解除（isSystemBusy を false にする）
 */
export function useStageActions() {
    // Zustandストアから、ステージの角度更新やBusy状態の管理に必要なアクションを取得
    const { 
        setCurrentAngle, 
        isSystemBusy, 
        setIsSystemBusy,
        isStageConnected,
        setStagePollingInterval
    } = useAppStore(useShallow((state) => ({
        setCurrentAngle: state.setCurrentAngle,
        isSystemBusy: state.isSystemBusy,
        setIsSystemBusy: state.setIsSystemBusy,
        isStageConnected: state.isStageConnected,
        setStagePollingInterval: state.setStagePollingInterval,
    })));

    /**
     * 停止シグナル管理用フラグ (Ref)
     * 
     * 非同期のポーリング待機中に「ユーザーが停止ボタンを押したか」を判定するために使用します。
     * useRef を使うことで、非同期処理のループ内でも常に最新の値を参照できます。
     */
    const stopSignal = useRef(false);

    /**
     * ステージの動作完了を監視（ポーリング）する非同期関数。
     * 
     * バックエンドの API (/stage/position) を定期的に叩き、
     * ステージの `is_busy` フラグが false になるまで待機します。
     * 
     * @param timeoutMs - タイムアウトまでの最大待機時間（デフォルト5分）。この時間を超えても動作が終わらない場合はエラーとなります。
     * @returns {Promise<void>} ステージの動作が完了した際に resolve される Promise。
     * @throws {Error} タイムアウトに達した場合、またはバックエンドとの通信エラーが連続して閾値を超えた場合に reject されます。
     */
    const waitForIdle = async (timeoutMs = 300000): Promise<void> => {
        const startTime = Date.now();
        let errorCount = 0;
        const MAX_ERRORS = 5; // 連続5回（約2.5秒）のエラーまでは許容する

        return new Promise<void>((resolve, reject) => {
            const checkInterval = setInterval(async () => {
                // 1. タイムアウトチェック
                if (Date.now() - startTime > timeoutMs) {
                    clearInterval(checkInterval);
                    reject(new Error("Timeout: Stage operation took too long."));
                    return;
                }

                try {
                    // バックエンドに現在の角度とBusy状態を確認
                    const res = await stageApi.getPosition();
                    errorCount = 0; // 成功したらエラーカウントをリセット

                    // グローバルストアの角度を更新（画面上の表示が動く）
                    setCurrentAngle(res.current_angle);

                    // ステージが停止（Busy解除）したら待機完了
                    if (!res.is_busy) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                } catch (e) {
                    errorCount++;
                    console.warn(`Polling error (${errorCount}/${MAX_ERRORS}):`, e);
                    
                    // 連続エラーが閾値を超えたら「接続断」とみなして失敗させる
                    if (errorCount >= MAX_ERRORS) {
                        clearInterval(checkInterval);
                        reject(new Error("Connection lost with stage controller."));
                    }
                }
            }, 500); // 0.5秒ごとに確認
        });
    };

    /**
     * 各種移動操作の共通ラッパー関数。
     * 
     * 「UIロック -> コマンド送信 -> 完了待機 -> 通知 -> ロック解除」という
     * 複雑な一連のライフサイクルをカプセル化し、呼び出し元（各画面）をシンプルにします。
     * 
     * @param actionName - トーストやログに表示するアクションの名称
     * @param moveFn - 実際のAPI呼び出し（移動開始命令）を行う非同期関数
     */
    /**
     * トースト通知用の固定ID
     */
    const STAGE_TOAST_ID = "stage-action-toast";

    /**
     * 各種移動操作の共通ラッパー関数。
     * 
     * 「UIロック -> ローディングトースト表示 -> コマンド送信 -> 完了待機 -> 完了トーストへその場昇格 -> ロック解除」
     * という一連のライフサイクルをカプセル化し、呼び出し元（各画面）をシンプルにします。
     * 
     * @param options - アクション名、および各フェーズ（実行中・完了・停止・失敗）のメッセージ
     * @param moveFn - 実際のAPI呼び出し（移動開始命令）を行う非同期関数
     */
    const performMove = async (
        options: {
            actionName: string;
            loadingMessage: string;
            successMessage: string;
            stoppedMessage?: string;
            errorMessage?: string;
        },
        moveFn: () => Promise<void>
    ) => {
        // すでに別の処理が動いている、または接続されていない場合は何もしない
        if (isSystemBusy || !isStageConnected) return;
        
        setIsSystemBusy(true); // UIを操作不能にする（二重押し防止）
        setStagePollingInterval(100); // 【動的ポーリング】移動開始の直前にポーリング間隔を 100ms（高頻度）に引き上げます。
        stopSignal.current = false; // 停止フラグをリセット

        // 1. ローディングトーストを表示（同一IDで維持・前回のdescriptionを空文字で確実にリセット）
        toast.loading(options.loadingMessage, {
            id: STAGE_TOAST_ID,
            description: "",
            duration: Infinity,
        });

        try {
            await moveFn();      // 2. 移動開始コマンドを送る
            await waitForIdle(); // 3. 実際に止まるまで待つ

            // 待機が終わったあとの処理
            if (stopSignal.current) {
                // ユーザーによって途中で止められた場合: 同一IDで warning へ昇格
                const stoppedText = options.stoppedMessage || `${options.actionName}を停止しました`;
                toast.warning(stoppedText, {
                    id: STAGE_TOAST_ID,
                    description: "",
                    duration: 5000,
                });
                systemApi.postLogs("WARNING", `${options.actionName} Stopped by user`).catch(() => {});
            } else {
                // 最後まで正常に動ききった場合: 同一IDで success へ昇格
                toast.success(options.successMessage, {
                    id: STAGE_TOAST_ID,
                    description: "",
                    duration: 4000,
                });
                systemApi.postLogs("INFO", `${options.actionName} Complete`).catch(() => {});
            }
        } catch (e: any) {
            // エラーが発生した場合: 同一IDで error へ昇格
            console.error(e);
            const errText = options.errorMessage || `${options.actionName}に失敗しました`;
            
            // バックエンドからの 0-360 範囲外エラー等のメッセージを検出し、親切な日本語に整形
            let detailMessage = e.message || "通信エラーまたはタイムアウトが発生しました";
            if (typeof detailMessage === "string" && (detailMessage.includes("0-360") || detailMessage.includes("out of bounds"))) {
                detailMessage = "指定可能な角度は 0.0° 〜 360.0° の範囲内です";
            }

            toast.error(errText, {
                id: STAGE_TOAST_ID,
                description: detailMessage,
                duration: 6000,
            });
            systemApi.postLogs("ERROR", `${options.actionName} Failed: ${e}`).catch(() => {});
        } finally {
            setStagePollingInterval(1000); // 【動的ポーリング】移動完了直後にポーリング間隔を 1000ms（低頻度）に戻します。
            setIsSystemBusy(false); // 何があっても最後にはUIロックを解除する
        }
    };

    /**
     * 指定した角度分だけ相対的に移動（ジョグ）します。
     * @param target - 移動量（度）
     */
    const moveRelative = (target: number) => {
        const sign = target > 0 ? "+" : "";
        performMove(
            {
                actionName: "Step Move",
                loadingMessage: `相対移動: ${sign}${target}° 実行中...`,
                successMessage: `相対移動: ${sign}${target}° 完了`,
                stoppedMessage: "相対移動: 停止しました",
                errorMessage: "相対移動: 失敗しました",
            },
            async () => {
                await stageApi.moveRelative(target);
            }
        );
    };

    /**
     * 指定した絶対角度へ移動します。
     * @param target - 目標角度（度）
     */
    const moveAbsolute = (target: number) => {
        performMove(
            {
                actionName: "Absolute Move",
                loadingMessage: `絶対移動: ${target}° へ移動中...`,
                successMessage: `絶対移動: ${target}° への移動完了`,
                stoppedMessage: "絶対移動: 停止しました",
                errorMessage: "絶対移動: 失敗しました",
            },
            async () => {
                await stageApi.moveAbsolute(target);
            }
        );
    };

    /**
     * 機械的原点復帰（Homing）を実行します。
     */
    const homeStage = () => {
        performMove(
            {
                actionName: "Homing",
                loadingMessage: "原点復帰: 実行中...",
                successMessage: "原点復帰: 完了",
                stoppedMessage: "原点復帰: 停止しました",
                errorMessage: "原点復帰: 失敗しました",
            },
            async () => {
                await stageApi.home();
            }
        );
    };

    /**
     * 動作中のステージを即座に停止させます。
     * 
     * @param immediate - true なら非常停止（即座に電源OFF）、false なら通常の減速停止
     */
    const stopStage = async (immediate: boolean = false) => {
        try {
            stopSignal.current = true; // ポーリング待機側に「止まった」ことを通知
            await stageApi.stop(immediate);
            
            if (immediate) {
                toast.error("非常停止を実行しました", {
                    id: STAGE_TOAST_ID,
                    description: "ステージを再度操作する前に、原点復帰（Homing）を実行してください。",
                    duration: 8000,
                });
                systemApi.postLogs("WARNING", "EMERGENCY STOP EXECUTED").catch(() => {});
            } else {
                toast.info("減速停止を実行しました", {
                    id: STAGE_TOAST_ID,
                    duration: 4000,
                });
                systemApi.postLogs("INFO", "Manual deceleration stop executed").catch(() => {});
            }
        } catch (e) {
            console.error(e);
            toast.error("停止コマンドの送信に失敗しました", {
                id: STAGE_TOAST_ID,
                duration: 6000,
            });
            systemApi.postLogs("ERROR", `Stop Command Failed: ${e}`).catch(() => {});
        }
    };

    return {
        moveRelative,
        moveAbsolute,
        homeStage,
        stopStage,
        waitForIdle,
        isSystemBusy,
        isStageConnected,
        stopSignal,
    };
}
