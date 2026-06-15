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
        isStageConnected
    } = useAppStore(useShallow((state) => ({
        setCurrentAngle: state.setCurrentAngle,
        isSystemBusy: state.isSystemBusy,
        setIsSystemBusy: state.setIsSystemBusy,
        isStageConnected: state.isStageConnected,
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
    const performMove = async (actionName: string, moveFn: () => Promise<void>) => {
        // すでに別の処理が動いている、または接続されていない場合は何もしない
        if (isSystemBusy || !isStageConnected) return;
        
        setIsSystemBusy(true); // UIを操作不能にする（二重押し防止）
        stopSignal.current = false; // 停止フラグをリセット

        try {
            await moveFn();      // 1. 移動開始コマンドを送る
            await waitForIdle(); // 2. 実際に止まるまで待つ

            // 待機が終わったあとの処理
            if (stopSignal.current) {
                // ユーザーによって途中で止められた場合
                toast.warning(`${actionName} Stopped`);
                systemApi.postLogs("WARNING", `${actionName} Stopped by user`).catch(() => {});
            } else {
                // 最後まで正常に動ききった場合
                toast.success(`${actionName} Complete`);
                systemApi.postLogs("INFO", `${actionName} Complete`).catch(() => {});
            }
        } catch (e: any) {
            // エラーが発生した場合（バックエンド異常、タイムアウトなど）
            console.error(e);
            toast.error(`${actionName} Failed: ${e.message || "Unknown error"}`);
            systemApi.postLogs("ERROR", `${actionName} Failed: ${e}`).catch(() => {});
        } finally {
            setIsSystemBusy(false); // 何があっても最後にはUIロックを解除する
        }
    };

    /**
     * 指定した角度分だけ相対的に移動（ジョグ）します。
     * @param target - 移動量（度）
     */
    const moveRelative = (target: number) => {
        performMove("Step Move", async () => {
            await stageApi.moveRelative(target);
        });
    };

    /**
     * 指定した絶対角度へ移動します。
     * @param target - 目標角度（度）
     */
    const moveAbsolute = (target: number) => {
        performMove("Absolute Move", async () => {
            toast.info(`Moving to ${target}°...`);
            await stageApi.moveAbsolute(target);
        });
    };

    /**
     * 機械的原点復帰（Homing）を実行します。
     */
    const homeStage = () => {
        performMove("Homing", async () => {
            toast.info("Homing...");
            await stageApi.home();
        });
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
                toast.info("EMERGENCY STOP EXECUTED");
                systemApi.postLogs("WARNING", "EMERGENCY STOP EXECUTED").catch(() => {});
                // 1秒後に再Homingを促すメッセージを出す
                setTimeout(() => toast.warning("Please re-home the stage."), 1000);
            } else {
                toast.info("Stopping...");
                systemApi.postLogs("INFO", "Manual deceleration stop executed").catch(() => {});
            }
        } catch (e) {
            console.error(e);
            toast.error("Stop Command Failed");
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
