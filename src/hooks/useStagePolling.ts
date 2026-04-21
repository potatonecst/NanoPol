import { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { stageApi } from '@/api/client';

/**
 * ステージの最新状態（角度や移動中かどうか）を定期的にバックエンドから取得し、
 * Zustandのストアを自動更新し続けるカスタムフック（タイマー）です。
 */
export const useStagePolling = () => {
    // Zustandから「現在ステージが接続されているか」だけを監視
    const isStageConnected = useAppStore((state) => state.isStageConnected);

    useEffect(() => {
        // ステージが未接続なら、タイマーは回さない
        if (!isStageConnected) return;

        // 100msごとに実行されるタイマーをセット
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
        }, 100);

        // コンポーネントが破棄されたり、ステージが切断された時に、自動的にタイマーを消去（お掃除）します。
        return () => clearInterval(intervalId);
    }, [isStageConnected]); // isStageConnected の値が変わるたびにこの処理が再評価される
};
