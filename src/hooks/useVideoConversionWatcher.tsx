import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { cameraApi } from "@/api/client";
import { Progress } from "@/components/ui/progress";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";

// ============================================================================
// 動画変換プログレス監視カスタムフック (useVideoConversionWatcher)
// 
// バックエンドの貨物レーン（ワーカースレッド）で実行される TIFF -> MP4 変換の
// 進行状況（進捗率・フレーム数・エラー）を定期ポーリングし、
// Sonner トースト内に shadcn/ui の Progress コンポーネントを組み込んで
// リアルタイムに視覚的フィードバックを提供します。
// ============================================================================

const CONVERSION_TOAST_ID = "video-conversion-progress-toast";

export const useVideoConversionWatcher = () => {
  const isBackendConnected = useAppStore((state) => state.isBackendConnected);
  
  // 直前の変換中ステータスを追跡（完了・失敗の立ち下がりエッジ検知用）
  const wasConvertingRef = useRef<boolean>(false);
  const toastActiveRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isBackendConnected) return;

    let timerId: number | null = null;
    let isPolling = true;

    const checkConversionStatus = async () => {
      try {
        const data = await cameraApi.getVideoConversionStatus();

        if (data.is_converting) {
          wasConvertingRef.current = true;
          toastActiveRef.current = true;

          // トースト内に shadcn/ui の Progress と進捗情報をリアルタイム描画
          toast.custom(
            () => (
              <div className="w-full bg-card text-card-foreground border rounded-lg p-3.5 shadow-lg space-y-2 select-none border-primary/30">
                {/* ヘッダー: タイトル & パーセント */}
                <div className="flex items-center justify-between text-sm">
                  <div className="font-semibold flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
                    <span>Converting Video to MP4</span>
                  </div>
                  <span className="font-mono text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded">
                    {data.progress_percent}%
                  </span>
                </div>

                {/* shadcn/ui の Progress コンポーネント */}
                <Progress value={data.progress_percent} className="h-1.5 w-full bg-muted" />

                {/* フッター: 詳細メッセージ & ファイル名 */}
                <div className="flex items-center justify-between text-xs text-muted-foreground pt-0.5">
                  <span className="truncate max-w-[220px]" title={data.status_message}>
                    {data.status_message || `Frame ${data.current_frame} / ${data.total_frames}`}
                  </span>
                  {data.target_file && (
                    <span className="font-mono text-[11px] opacity-75 shrink-0 ml-2">
                      {data.target_file}
                    </span>
                  )}
                </div>
              </div>
            ),
            {
              id: CONVERSION_TOAST_ID,
              duration: Infinity, // 変換中は自動で消えないように維持
            }
          );
        } else {
          // 変換中から非変換中への切り替え（完了またはエラー）を検知
          if (wasConvertingRef.current) {
            wasConvertingRef.current = false;
            toast.dismiss(CONVERSION_TOAST_ID);

            if (data.error) {
              // エラー通知（元TIFFが保護されていることを明記して安心感を与える）
              toast.error("Video Conversion Failed", {
                description: `Error: ${data.error}. Raw TIFF is preserved safely in videos/ folder.`,
                duration: 8000,
                icon: <AlertTriangle className="w-4 h-4 text-destructive" />
              });
            } else if (data.progress_percent === 100 || data.target_file) {
              // 成功通知
              toast.success("Video Conversion Completed", {
                description: `Saved as ${data.target_file || "MP4 video"} (Drop-frame interpolated).`,
                duration: 5000,
                icon: <CheckCircle2 className="w-4 h-4 text-green-500" />
              });
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
