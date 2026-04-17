import { useEffect, useRef, useState } from "react";
import { systemApi } from "../../api/client";
import { LogEntry } from "../../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import { Terminal, ChevronUp, ChevronDown, Maximize2, Minimize2, ArrowDown } from "lucide-react";

export function LogPanel() {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isOpen, setIsOpen] = useState(false); //開閉状態
    const [isMaximized, setIsMaximized] = useState(false); //最大化状態

    const scrollRef = useRef<HTMLDivElement>(null);
    const [isAtBottom, setIsAtBottom] = useState(true); // ユーザーが一番下にいるか
    const [showResumeBtn, setShowResumeBtn] = useState(false); // Resumeボタンの表示制御

    // 定期フェッチ（0.2秒ごと）
    // サーバーから最新のログを取得し続けます（ポーリング）。
    // WebSocketを使わないシンプルな実装です。
    useEffect(() => {
        let timeoutId: ReturnType<typeof setTimeout>;
        let isMounted = true;

        const fetchLogs = async () => {
            try {
                const res = await systemApi.getLogs();
                if (isMounted) {
                    setLogs(res.logs);
                }
            } catch (e) {
                console.error(e);
            } finally {
                // 処理が終わったら、次のタイマーをセット（再帰呼び出し）
                if (isMounted) {
                    timeoutId = setTimeout(fetchLogs, 200);
                }
            }
        };

        fetchLogs();

        return () => {
            isMounted = false;
            clearTimeout(timeoutId);
        };
    }, []);

    // スクロールイベントの監視
    // ユーザーが手動で上にスクロールしたかどうかを判定します。
    const handleScroll = () => {
        if (!scrollRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;

        // 下から20px以内にいれば「底にいる」とみなす
        const atBottom = scrollHeight - (scrollTop + clientHeight) < 20;
        setIsAtBottom(atBottom);
        setShowResumeBtn(!atBottom);
    };

    // Smart Auto-Scroll: ログ更新時、ユーザーが底にいる場合のみスクロール
    // これにより、ユーザーが過去のログを読んでいる最中に勝手にスクロールされるのを防ぎます。
    // isMaximized を依存に含める理由: パネルの高さ切り替え直後にも最下部追従を再実行し、
    // 「最新ログの張り付き」が中途半端になるのを防ぐためです。
    useEffect(() => {
        if (isOpen && isAtBottom && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs, isOpen, isMaximized, isAtBottom]);

    // Resume Button: 強制的に最新へスクロール
    const scrollToBottom = () => {
        if (scrollRef.current) {
            scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
            // スクロール完了を待たずにフラグを戻す（UX向上のため）
            setIsAtBottom(true);
            setShowResumeBtn(false);
        }
    };

    // パネル開閉（閉じる時に最大化リセット）
    const togglePanel = () => {
        if (isOpen) {
            setIsMaximized(false); // Close Action: Reset maximization
        } else {
            // Re-open Action: Reset scroll state to bottom
            setIsAtBottom(true);
            setShowResumeBtn(false);
        }
        setIsOpen(!isOpen);
    };

    // ログレベルに応じた色分け
    const getLevelColor = (level: string) => {
        switch (level) {
            case "INFO": return "text-blue-400";
            case "WARNING": return "text-amber-400";
            case "ERROR": return "text-red-400 font-bold";
            default: return "text-muted-foreground";
        }
    };

    // メッセージ本文の色分け（Mock判定など）
    const getMessageColor = (message: string) => {
        if (message.includes("MOCK]")) { // [STAGE-MOCK], [CAMERA-MOCK] 等を検出
            return "text-violet-400";
        }
        return "text-zinc-300 group-hover:text-white";
    };

    // 最新のログ（閉じた状態のヘッダーに表示するため）
    const latestLog = logs.length > 0 ? logs[logs.length - 1] : null;

    // パネルの高さ決定（CSSクラス）
    const getHeightClass = () => {
        if (isMaximized) return "h-[80vh]"; //最大化時
        if (isOpen) return "h-48"; //通常オープン時
        return "h-9"; //閉じている時（ヘッダーのみ）
    };

    return (
        <div
            className={cn(
                "flex flex-col border-t bg-zinc-950 text-zinc-100 font-mono text-xs transition-all duration-300 ease-in-out shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] overflow-hidden",
                getHeightClass()
            )}
        >
            {/* ヘッダー（常に表示） */}
            <div
                className="flex items-center justify-between px-2 py-1 bg-white/5 border-b border-white/10 cursor-pointer hover:bg-white/10 transition-colors shrink-0"
                onClick={togglePanel}
            >
                <div className="flex items-center gap-3 overflow-hidden">
                    {/* アイコンとタイトル */}
                    <div className="flex items-center gap-2 shrink-0">
                        {isOpen ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
                        <Terminal className="size-3 text-muted-foreground" />
                        <span className="font-semibold text-muted-foreground">Log</span>
                    </div>

                    {/* 閉じている時に最新ログを表示 */}
                    {!isOpen && latestLog && (
                        <div className="flex items-center gap-2 overflow-hidden opacity-80">
                            <span className="text-zinc-500 text-[10px] shrink-0">
                                {latestLog.timestamp}
                            </span>
                            <span className={cn("font-bold text-[10px] shrink-0", getLevelColor(latestLog.level))}>
                                {latestLog.level}
                            </span>
                            <span className="truncate text-zinc-300">
                                {latestLog.message}
                            </span>
                        </div>
                    )}
                </div>

                {/* 右側の操作ボタン */}
                <div className="flex items-center gap-1 shrink-0">
                    <Badge
                        variant="outline"
                        className="text-[10px] h-4 px-1 text-muted-foreground border-muted-foreground/30 hidden sm:flex"
                    >
                        {logs.length} events
                    </Badge>

                    {/* 最大化ボタン */}
                    {isOpen && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 hover:bg-white/20"
                            onClick={(e) => {
                                e.stopPropagation(); //親のonClick（開閉）を止める
                                setIsMaximized(!isMaximized);
                            }}
                        >
                            {isMaximized ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
                        </Button>
                    )}
                </div>
            </div>

            {/* ログリスト（開いている時だけ中身を表示） */}
            {isOpen && (
                <div className="relative flex-1 min-h-0 overflow-hidden">
                    <div
                        ref={scrollRef}
                        onScroll={handleScroll}
                        className="h-full overflow-y-auto p-2 space-y-0.5"
                    >
                        {logs.map((log, i) => (
                            <div key={i} className="flex gap-3 hover:bg-white/5 px-2 py-0.5 rounded transition-colors group">
                                <span className="text-zinc-500 w-16 shrink-0 text-[10px] pt-0.5 select-none">
                                    {log.timestamp}
                                </span>
                                <span className={cn("w-14 shrink-0 font-bold text-[10px] pt-0.5 select-none", getLevelColor(log.level))}>
                                    {log.level}
                                </span>
                                <span className={cn("break-all whitespace-pre-wrap transition-colors", getMessageColor(log.message))}>
                                    {log.message}
                                </span>
                            </div>
                        ))}
                    </div>

                    {/* Resume Button (Floating) */}
                    {showResumeBtn && (
                        <div className="absolute bottom-4 right-4 z-10 animate-in fade-in zoom-in duration-200">
                            <Button size="sm" variant="secondary" className="h-7 text-[10px] shadow-md border border-white/10 bg-zinc-800 hover:bg-zinc-700 text-zinc-100" onClick={scrollToBottom}>
                                <ArrowDown className="mr-1 h-3 w-3" />
                                New Logs
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}