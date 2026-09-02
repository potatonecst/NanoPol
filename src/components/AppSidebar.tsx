import { Cable, HandMetal, Activity, Settings, HelpCircle, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import { AppMode } from "@/types";
import { Button, buttonVariants } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useShallow } from "zustand/react/shallow";

export function AppSidebar() {
    // Zustandストアから必要な状態と関数を取り出す
    const { 
        currentMode, 
        setMode, 
        isSystemBusy,
        isSettingsDirty,
        setIsSettingsDirty,
        pendingNavigationMode,
        setPendingNavigationMode
    } = useAppStore(
        useShallow((state) => ({
            currentMode: state.currentMode, // 現在選択されているモード
            setMode: state.setMode,         // モードを変更する関数
            isSystemBusy: state.isSystemBusy, // システムが処理中かどうか（ロック用）
            isSettingsDirty: state.isSettingsDirty, // 設定画面の未保存変更フラグ
            setIsSettingsDirty: state.setIsSettingsDirty,
            pendingNavigationMode: state.pendingNavigationMode, // 遷移保留先のモード
            setPendingNavigationMode: state.setPendingNavigationMode,
        }))
    );

    /**
     * ナビゲーションクリック時のインターセプト（割り込み）処理
     * 
     * 【技術的解説】
     * 設定画面（SettingsView）で未保存の変更（`isSettingsDirty === true`）が存在する状態で
     * 別のモードへ移動しようとした場合、即座の遷移をブロックし、`pendingNavigationMode` に
     * 遷移先を一時保存した上で確認用 AlertDialog を開きます。
     */
    const handleNavClick = (targetMode: AppMode) => {
        if (currentMode === targetMode) return; // 同じ画面なら何もしない

        if (currentMode === "settings" && isSettingsDirty) {
            // 未保存の変更がある場合は、画面遷移を保留して確認ダイアログを開く
            setPendingNavigationMode(targetMode);
            return;
        }

        // 通常の画面遷移
        setMode(targetMode);
    };

    /**
     * 未保存変更を破棄して目的の画面へ移動する処理
     */
    const handleConfirmDiscard = () => {
        if (pendingNavigationMode) {
            setIsSettingsDirty(false); // 未保存フラグをリセット
            setMode(pendingNavigationMode); // 保留していた画面へ遷移
            setPendingNavigationMode(null); // 保留状態をクリア
        }
    };

    /**
     * 遷移をキャンセルして設定画面に留まる処理
     */
    const handleCancelDiscard = () => {
        setPendingNavigationMode(null); // 保留状態をクリアしてダイアログを閉じる
    };

    // 内部コンポーネント: ナビゲーションボタン
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
                        onClick={() => handleNavClick(mode)}
                        title={label}
                        disabled={isSystemBusy}
                    >
                        <Icon className="size-6" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={5} className="font-semibold">
                    {label}
                </TooltipContent>
            </Tooltip>
        );
    };

    return (
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
                <div className="mt-auto flex flex-col gap-3">
                    <NavButton mode="settings" icon={Settings} label="Settings" />

                    {/* ヘルプボタン */}
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

            {/* 未保存変更がある場合の確認ダイアログ (AlertDialog) */}
            <AlertDialog open={pendingNavigationMode !== null} onOpenChange={(open) => { if (!open) handleCancelDiscard(); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <div className="flex items-center gap-2 text-destructive">
                            <AlertTriangle className="size-5" />
                            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                        </div>
                        <AlertDialogDescription className="text-sm pt-2">
                            You have unsaved changes in Settings. Leaving this page will discard all your modifications. Are you sure you want to proceed?
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className="mt-4">
                        <AlertDialogCancel onClick={handleCancelDiscard}>
                            Stay on Settings
                        </AlertDialogCancel>
                        <AlertDialogAction 
                            onClick={handleConfirmDiscard}
                            className={cn(buttonVariants({ variant: "destructive" }), "text-white font-medium")}
                        >
                            Discard & Leave
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </TooltipProvider>
    );
}