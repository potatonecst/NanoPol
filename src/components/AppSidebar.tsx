import { Cable, HandMetal, Activity, Settings, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import { AppMode } from "@/types";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useShallow } from "zustand/react/shallow";

export function AppSidebar() {
    // Zustandストアから必要な状態と関数を取り出す
    // useShallow: パフォーマンス最適化フック。
    // ストア全体の状態(state)のうち、ここで使用する { currentMode, setMode, isSystemBusy } の
    // いずれかが変更された場合のみ、このコンポーネントを再レンダリングします。
    const { currentMode, setMode, isSystemBusy } = useAppStore(
        useShallow((state) => ({
            currentMode: state.currentMode, // 現在選択されているモード
            setMode: state.setMode,         // モードを変更する関数
            isSystemBusy: state.isSystemBusy, // システムが処理中かどうか（ロック用）
        }))
    );

    // 内部コンポーネント: ナビゲーションボタン
    // 繰り返し使用されるボタンのロジックとデザインを共通化しています。
    const NavButton = ({ mode, icon: Icon, label }: { mode: AppMode, icon: any, label: string }) => {
        // 現在のモードとこのボタンのモードが一致するか判定
        const isActive = currentMode === mode;

        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant={isActive ? "default" : "ghost"} // アクティブなら塗りつぶし(default)、非アクティブなら背景なし(ghost)
                        size="icon-lg"
                        className={cn(
                            "size-12 rounded-md transition-all my-1",
                            isActive
                                ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90" // アクティブ時のスタイル
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"       // 非アクティブ時のスタイル
                        )}
                        onClick={() => setMode(mode)} // クリック時にモードを切り替え
                        title={label}
                        disabled={isSystemBusy} // システム処理中はボタンを無効化（誤操作防止）
                    >
                        <Icon className="size-6" />
                    </Button>
                </TooltipTrigger>
                {/* マウスホバー時に右側にラベルを表示 */}
                <TooltipContent side="right" sideOffset={5} className="font-semibold">
                    {label}
                </TooltipContent>
            </Tooltip>
        )
    }

    return (
        // TooltipProvider: アプリケーション内でツールチップを表示するためのコンテキストを提供
        // delayDuration={0}: ホバーした瞬間に表示（遅延なし）
        <TooltipProvider delayDuration={0}>
            {/* 左端に幅16（64px）のサイドバーコンテナ */}
            <div className="flex w-16 flex-col items-center border-r bg-card py-4 h-full">
                {/* Navigation Items: 上部のメイン機能切り替えボタン群 */}
                <div className="flex flex-col gap-3">
                    <NavButton mode="devices" icon={Cable} label="Devices (Connection)" />
                    <NavButton mode="manual" icon={HandMetal} label="Manual Control" />
                    <NavButton mode="auto" icon={Activity} label="Auto Measurement" />
                </div>

                {/* Bottom Actions: 下部の設定・ヘルプボタン群 */}
                {/* mt-auto を使うことで、このブロックを親コンテナの一番下に押し下げています */}
                <div className="mt-auto flex flex-col gap-3">
                    <NavButton mode="settings" icon={Settings} label="Settings" />

                    {/* ヘルプボタン（モード切り替えではないためNavButtonを使わず個別に実装） */}
                    <Tooltip>
                        <TooltipTrigger>
                            <Button
                                variant="ghost"
                                size="icon-lg"
                                title="Help"
                                className="size-12 rounded-md transition-all my-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                                <HelpCircle className="size-6" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="font-semibold">Help</TooltipContent>
                    </Tooltip>
                </div>
            </div>
        </TooltipProvider>
    )
}