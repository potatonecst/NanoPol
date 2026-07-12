import { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { stageApi } from '@/api/client';

/**
 * ステージの最新状態（角度や移動中かどうか）を定期的にバックエンドから取得し、
 * Zustandのストアを自動更新し続けるカスタムフック（タイマー）です。
 * 負荷軽減のため、ステージの動作状態（静止時は低頻度、移動時は高頻度）に合わせて
 * ポーリング間隔（stagePollingInterval）を動的に切り替えます。
 */
export const useStagePolling = () => {
    // Zustandから「現在ステージが接続されているか」と「ポーリング間隔」を購読
    const isStageConnected = useAppStore((state) => state.isStageConnected);
    const stagePollingInterval = useAppStore((state) => state.stagePollingInterval);

    useEffect(() => {
        // ステージが未接続なら、タイマーは回さない
        if (!isStageConnected) return;

        // ストアから提供される動的な間隔（stagePollingInterval）でタイマーを起動します
        const intervalId = setInterval(async () => {
            try {
                // client.ts の共通関数を使用して通信
                const data = await stageApi.getPosition();

                // 取得したデータで直接Zustandストアを更新する
                useAppStore.setState({
                    currentAngle: data.current_angle,
                    isStageBusy: data.is_busy,
                    isMeasuring: data.is_measuring,
                });
            } catch (error) {
                console.error("Stage polling failed:", error);
                // 通信断やAPI失敗時に接続状態を落とし、UIの操作不能状態を避ける
                useAppStore.setState({
                    isStageConnected: false,
                    isStageBusy: false,
                });
            }
        }, stagePollingInterval);

        // コンポーネントが破棄されたり、ステージが切断された時、またはポーリング間隔が切り替わった時に、
        // 古いタイマーを自動的に消去し、最新の間隔で再設定できるようにします。
        return () => clearInterval(intervalId);
    }, [isStageConnected, stagePollingInterval]); // 接続状態および間隔が変化するたびにタイマーを再生成
};
