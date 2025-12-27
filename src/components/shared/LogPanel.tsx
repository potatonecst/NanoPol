import { useEffect, useRef, useState } from "react";
import { systemApi } from "../../api/client";
import { LogEntry } from "../../types";
import { ScrollArea } from "../ui/scroll-area";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import { Terminal, ChevronUp, ChevronDown, Maximize2, Minimize2 } from "lucide-react";

export function LogPanel() {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isOpen, setIsOpen] = useState(false); //開閉状態
    const [isMaximized, setIsMaximized] = useState(false); //最大化状態
    const bottomRef = useRef<HTMLDivElement>(null);

    //定期フェッチ（1秒ごと）
    useEffect(() => {
        const fetchLogs = async () => {
            try {
                const res = await systemApi.getLogs();
                setLogs(res.logs);
            } catch (e) {
                console.error(e);
            }
        };
        fetchLogs();
        const interval = setInterval(fetchLogs, 1000);
        return () => clearInterval(interval);
    }, []);

    //ログ更新時のログ更新時の自動スクロール
    useEffect(() => {
        if (isOpen) {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs.length, isOpen])

    //色分け
    const getLevelColor = (level: string) => {
        switch (level) {
            case "INFO": return "text-blue-400";
            case "WARNING": return "text-amber-400";
            case "ERROR": return "text-red-400 font-bold";
            default: return "text-muted-foreground";
        }
    };

    //最新のログ
    const latestLog = logs.length > 0 ? logs[logs.length - 1] : null;

    //パネルの高さ決定
    const getHeightClass = () => {
        if (isMaximized) return "h-[80vh]"; //最大化時
        if (isOpen) return "h-48"; //通常オープン時
        return "h-9"; //閉じている時（ヘッダーのみ）
    };

    return (
        <div
            className={cn(
                "flex flex-col border-t bg-zinc-950 text-zinc-100 font-mono text-xs transition-all duration-300 ease-in-out shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]",
                getHeightClass()
            )}
        >
            {/* ヘッダー（常に表示） */}
            <div
                className="flex items-center justify-between px-2 py-1 bg-white/5 border-b border-white/10 cursor-pointer hover:bg-white/10 transition-colors"
                onClick={() => setIsOpen(!isOpen)}
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
                            <span className="text-zinx-500 text-[10px] shrink-0">
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
                <ScrollArea className="flex-1 p-2">
                    <div className="space-y-0.5">
                        {logs.map((log, i) => (
                            <div key={i} className="flex gap-3 hover:bg-white/5 px-2 py-0.5 rounded transition-colors group">
                                <span className="ext-zinc-500 w-16 shrink-0 text-[10px] pt-0.5 select-none">
                                    {log.timestamp}
                                </span>
                                <span className={cn("w-14 shrink-0 font-bold text-[10px] pt-0.5 select-none", getLevelColor(log.level))}>
                                    {log.level}
                                </span>
                                <span className="break-all whitespace-pre-wrap text-zinc-300 group-hover:text-white">
                                    {log.message}
                                </span>
                            </div>
                        ))}
                        <div ref={bottomRef} /> {/* 自動スクロール用のダミー要素 */}
                    </div>
                </ScrollArea>
            )}
        </div>
    );
}