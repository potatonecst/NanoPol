import { useShallow } from 'zustand/react/shallow';
import { 
    CheckCircle2, 
    ArrowLeft, 
    ChevronRight, 
    History,
    Beaker
} from 'lucide-react';
import { format } from 'date-fns';

import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
    Table,
    TableBody,
    TableCell,
    TableRow,
    TableHeader,
    TableHead,
} from '@/components/ui/table';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';

/**
 * 測定カテゴリの定義
 * ユーザー指定の順序: Left-Front, Right-Front, Left-Rear, Right-Rear
 */
const MEASUREMENT_CATEGORIES = [
    { id: 'Left_Front', label: 'Left - Front', description: 'Laser from Left, Plate at Front' },
    { id: 'Right_Front', label: 'Right - Front', description: 'Laser from Right, Plate at Front' },
    { id: 'Left_Rear', label: 'Left - Rear', description: 'Laser from Left, Plate at Rear' },
    { id: 'Right_Rear', label: 'Right - Rear', description: 'Laser from Right, Plate at Rear' },
] as const;

/**
 * カテゴリ選択 (Category Selector) コンポーネント
 * 
 * 自動測定の第2フェーズ。
 * - 現在のセッション（サンプル名）の表示
 * - 4つの測定カテゴリの選択ボタン（進捗チェック付き）
 * - セッション内の測定履歴一覧
 * - セッション終了（最初の画面へ戻る）機能
 */
export function CategorySelector() {
    const { 
        currentSession, 
        setAutoPhase, 
        setSelectedCategory,
        resetAutoMeasurement 
    } = useAppStore(useShallow((state) => ({
        currentSession: state.currentSession,
        setAutoPhase: state.setAutoPhase,
        setSelectedCategory: state.setSelectedCategory,
        resetAutoMeasurement: state.resetAutoMeasurement,
    })));

    if (!currentSession) return null;

    /**
     * 特定のカテゴリが既に完了しているかどうかを判定します。
     * measurements 履歴の中に status が 'completed' のエントリが1つでもあれば完了とみなします。
     */
    const isCategoryCompleted = (categoryId: string) => {
        return currentSession.settings.measurements.some(
            (m) => m.step_category === categoryId && m.status === 'completed'
        );
    };

    /**
     * カテゴリを選択して測定実行フェーズへ遷移します。
     */
    const handleSelectCategory = (categoryId: string) => {
        setSelectedCategory(categoryId);
        setAutoPhase('measuring');
    };

    /**
     * セッションを終了してセッション選択画面へ戻ります。
     */
    const handleExitSession = () => {
        resetAutoMeasurement();
    };

    // 履歴を新しい順（降順）に並び替えます
    const historyEntries = [...currentSession.settings.measurements].reverse();

    return (
        <TooltipProvider>
            <div className="space-y-6">
                {/* Section: Current Session Header */}
                <div className="flex items-center justify-between">
                    <div className="space-y-1">
                        <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                            Active Session
                        </Label>
                        <div className="flex items-center gap-2">
                            <Beaker className="size-4 text-amber-500" />
                            <span className="font-mono font-bold text-sm truncate max-w-[160px]">
                                {currentSession.sampleName}
                            </span>
                        </div>
                    </div>
                    <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={handleExitSession}
                        className="h-8 text-xs text-muted-foreground hover:text-destructive"
                    >
                        <ArrowLeft className="size-3 mr-1" />
                        Exit
                    </Button>
                </div>

                <Separator />

                {/* Section: Category Selection Grid */}
                <div className="space-y-3">
                    <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                        Select Category
                    </Label>
                    <div className="grid grid-cols-1 gap-2">
                        {MEASUREMENT_CATEGORIES.map((cat) => {
                            const completed = isCategoryCompleted(cat.id);
                            return (
                                <Card 
                                    key={cat.id}
                                    className={`relative p-3 cursor-pointer transition-all hover:ring-2 hover:ring-amber-500/50 group overflow-hidden ${
                                        completed ? 'bg-secondary/5' : 'bg-background'
                                    }`}
                                    onClick={() => handleSelectCategory(cat.id)}
                                >
                                    <div className="flex items-center justify-between relative z-10">
                                        <div className="space-y-0.5">
                                            <div className="flex items-center gap-2">
                                                <span className="font-bold text-xs group-hover:text-amber-600 transition-colors">
                                                    {cat.label}
                                                </span>
                                                {completed && (
                                                    <CheckCircle2 className="size-3.5 text-green-500" />
                                                )}
                                            </div>
                                            <p className="text-[10px] text-muted-foreground leading-tight">
                                                {cat.description}
                                            </p>
                                        </div>
                                        <ChevronRight className="size-4 text-muted-foreground/30 group-hover:translate-x-0.5 group-hover:text-amber-500 transition-all" />
                                    </div>
                                    
                                    {/* 進捗を示す背景アクセント */}
                                    {completed && (
                                        <div className="absolute top-0 right-0 p-1 opacity-10">
                                            <CheckCircle2 className="size-12 -mr-4 -mt-4" />
                                        </div>
                                    )}
                                </Card>
                            );
                        })}
                    </div>
                </div>

                <Separator />

                {/* Section: Measurement History */}
                <div className="space-y-3 pb-4">
                    <div className="flex items-center gap-2">
                        <History className="size-3.5 text-muted-foreground" />
                        <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                            Session History
                        </Label>
                    </div>

                    <div className="rounded-md border bg-background overflow-hidden">
                        <div className="max-h-[200px] overflow-y-auto">
                            <Table>
                                <TableHeader className="bg-muted/30 sticky top-0 z-10">
                                    <TableRow className="hover:bg-transparent border-b">
                                        <TableHead className="h-7 px-3 text-[9px] font-bold uppercase">ID / Time</TableHead>
                                        <TableHead className="h-7 px-3 text-[9px] font-bold uppercase text-right">Status</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {historyEntries.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={2} className="text-center py-6 text-[10px] text-muted-foreground italic">
                                                No measurements yet
                                            </TableCell>
                                        </TableRow>
                                    ) : (
                                        historyEntries.map((entry) => (
                                            <TableRow key={entry.id} className="group text-[10px]">
                                                <TableCell className="py-2 px-3">
                                                    <div className="font-mono font-bold leading-tight">
                                                        {entry.id}
                                                    </div>
                                                    <div className="text-[9px] text-muted-foreground mt-0.5">
                                                        {entry.timestamp_start 
                                                            ? format(new Date(entry.timestamp_start), 'HH:mm:ss')
                                                            : '---'}
                                                    </div>
                                                </TableCell>
                                                <TableCell className="py-2 px-3 text-right align-top">
                                                    <Badge 
                                                        variant="outline" 
                                                        className={`text-[8px] h-4 px-1.5 font-bold uppercase ${
                                                            entry.status === 'completed' 
                                                                ? 'border-green-500/50 text-green-600 bg-green-500/5' 
                                                                : entry.status === 'aborted'
                                                                ? 'border-amber-500/50 text-amber-600 bg-amber-500/5'
                                                                : 'border-destructive/50 text-destructive bg-destructive/5'
                                                        }`}
                                                    >
                                                        {entry.status}
                                                    </Badge>
                                                </TableCell>
                                            </TableRow>
                                        ))
                                    )}
                                </TableBody>
                            </Table>
                        </div>
                    </div>
                </div>
            </div>
        </TooltipProvider>
    );
}
