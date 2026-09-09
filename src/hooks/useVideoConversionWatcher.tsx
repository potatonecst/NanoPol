import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { cameraApi } from "@/api/client";
import { Progress } from "@/components/ui/progress";
import { useAppStore } from "@/store/useAppStore";

// ============================================================================
// 動画変換プログレス監視カスタムフック (useVideoConversionWatcher)
// 
// バックエンドの貨物レーン（ワーカースレッド）で実行される TIFF -> MP4 変換の
// 進行状況（進捗率・フレーム数・エラー）を定期ポーリングし、
// Sonner トースト内に shadcn/ui の Progress コンポーネントを組み込んで
// リアルタイムに視覚的フィードバックを提供します。
// 
// 【UX設計のポイント】
// 1. 同一 ID (CONVERSION_TOAST_ID) によるインプレース更新:
//    トーストを再生成せず、同一の枠内で「変換中（ローディング） -> 完了（チェック/警告）」
//    へと滑らかに状態を昇格させます。
// 2. デザインの完全統一:
//    Sonner 標準の Toaster テーマ（popover 背景・ボーダー・シャドウ）に統合。
// ============================================================================

const CONVERSION_TOAST_ID = "video-conversion-progress-toast";

export const useVideoConversionWatcher = () => {
  const isBackendConnected = useAppStore((state) => state.isBackendConnected);
  
  // 直前の変換中ステータスを追跡（完了・失敗の立ち下がりエッジ検知用）
  const wasConvertingRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isBackendConnected) return;

    let timerId: number | null = null;
    let isPolling = true;

    const checkConversionStatus = async () => {
      try {
        const data = await cameraApi.getVideoConversionStatus();

        if (data.is_converting) {
          wasConvertingRef.current = true;

          // Sonner 標準の loading トースト枠内に shadcn/ui の Progress を埋め込み、同一IDで常時更新
          toast.loading("MP4動画へ変換中", {
            id: CONVERSION_TOAST_ID,
            duration: Infinity, // 変換中は消えないように維持
            description: (
              <div className="space-y-1.5 pt-1.5 min-w-[240px]">
                <Progress value={data.progress_percent} className="h-1.5 w-full bg-muted" />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="truncate max-w-[180px]" title={data.status_message}>
                    {data.status_message || `フレーム ${data.current_frame} / ${data.total_frames}`}
                  </span>
                  <span className="font-mono font-medium ml-2 shrink-0">
                    {data.progress_percent}%
                  </span>
                </div>
              </div>
            ),
          });
        } else {
          // 変換中から非変換中への切り替え（完了またはエラー）を検知
          if (wasConvertingRef.current) {
            wasConvertingRef.current = false;

            if (data.error) {
              // ローディングトーストを手仕舞いし、標準のプレーンテキスト description でエラー表示
              toast.dismiss(CONVERSION_TOAST_ID);
              toast.error("動画変換に失敗しました", {
                description: `エラー: ${data.error}。元TIFFファイルは安全に保護されています。`,
                duration: 8000,
              });
            } else if (data.progress_percent === 100 || data.target_file) {
              // 1. まずプログレスバーを 100% まで完全に伸ばし、完了した余韻を視覚的にフィードバック
              toast.loading("MP4動画へ変換中", {
                id: CONVERSION_TOAST_ID,
                duration: Infinity,
                description: (
                  <div className="space-y-1.5 pt-1.5 min-w-[240px]">
                    <Progress value={100} className="h-1.5 w-full bg-muted" />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className="truncate max-w-[180px]">変換完了 (100%)</span>
                      <span className="font-mono font-medium ml-2 shrink-0">100%</span>
                    </div>
                  </div>
                ),
              });

              // 2. 350ms の心地よい余韻（イージング完了待ち）を挟んでから、ローディングを閉じて
              //    他のトーストと全く同じ標準のプレーン文字列 description で完了トーストを発行。
              //    これにより、Sonner 内部の高さキャッシュと完全一致し、ホバー時の縦幅の揺れが 100% 解消されます。
              window.setTimeout(() => {
                toast.dismiss(CONVERSION_TOAST_ID);

                const summary = data.summary;
                const targetFileName = data.target_file || "MP4動画";

                if (summary && summary.interpolated_frames > 0) {
                  // ドロップ補完あり
                  toast.warning("動画変換が完了しました（補完あり）", {
                    description: `${targetFileName} (${summary.source_frames} + ${summary.interpolated_frames}フレーム補完)`,
                    duration: 6000,
                  });
                } else {
                  // ドロップなし
                  const totalFrames = summary?.output_mp4_frames ?? data.total_frames;
                  toast.success("動画変換が完了しました", {
                    description: `${targetFileName} (${totalFrames}フレーム / ドロップなし)`,
                    duration: 5000,
                  });
                }
              }, 350);
            } else {
              // それ以外の予期せぬ終了時はトーストを閉じる
              toast.dismiss(CONVERSION_TOAST_ID);
            }
          }
        }
      } catch (e) {
        // バックエンド通信エラー時は静かに無視（定期ポーリングでのコンソール汚染防止）
      } finally {
        if (isPolling) {
          // 変換中は高頻度（500ms）、待機時は低頻度（2000ms）でポーリング
          const nextInterval = wasConvertingRef.current ? 500 : 2000;
          timerId = window.setTimeout(checkConversionStatus, nextInterval);
        }
      }
    };

    // 初回実行
    checkConversionStatus();

    return () => {
      isPolling = false;
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    };
  }, [isBackendConnected]);
};
