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
    const { currentMode, setMode } = useAppStore(
        useShallow((state) => ({
            currentMode: state.currentMode,
            setMode: state.setMode,
        }))
    );

    //内部コンポーネント
    const NavButton = ({ mode, icon: Icon, label }: { mode: AppMode, icon: any, label: string }) => {
        const isActive = currentMode === mode;

        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant={isActive ? "default" : "ghost"}
                        size="icon-lg"
                        className={cn(
                            "size-12 rounded-md transition-all my-1",
                            isActive
                                ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                        onClick={() => setMode(mode)}
                        title={label}
                    >
                        <Icon className="size-6" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={5} className="font-semibold">
                    {label}
                </TooltipContent>
            </Tooltip>
        )
    }

    return (
        <TooltipProvider delayDuration={0}>
            {/* 左端に幅16（64px）のサイドバー */}
            <div className="flex w-16 flex-col items-center border-r bg-card py-4 h-full">
                {/* Navigation Items */}
                <div className="flex flex-col gap-3">
                    <NavButton mode="devices" icon={Cable} label="Devices (Connection)" />
                    <NavButton mode="manual" icon={HandMetal} label="Manual Control" />
                    <NavButton mode="auto" icon={Activity} label="Auto Measurement" />
                </div>

                {/* Bottom Actions */}
                <div className="mt-auto flex flex-col gap-3">
                    <NavButton mode="settings" icon={Settings} label="Settings" />

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