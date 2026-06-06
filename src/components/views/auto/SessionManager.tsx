import { useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { format } from 'date-fns';
import { 
    Plus, 
    FolderOpen, 
    Calendar as CalendarIcon, 
    ChevronRight,
    RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAppStore } from '@/store/useAppStore';
import { autoApi, systemApi } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Calendar } from '@/components/ui/calendar';
import { Separator } from '@/components/ui/separator';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import {
    Table,
    TableBody,
    TableCell,
    TableRow,
} from '@/components/ui/table';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { open } from '@tauri-apps/plugin-dialog';

/**
 * セッション管理 (Session Manager) コンポーネント
 * 
 * ManualView のセクション（Step Control等）と同じトーンのデザインを採用しています。
 * 各種操作ボタンにはツールチップを追加し、利便性を向上させています。
 */
export function SessionManager() {
    const { 
        setCurrentSession, 
        setAutoPhase,
        isSystemBusy,
        setIsSystemBusy
    } = useAppStore(useShallow((state) => ({
        setCurrentSession: state.setCurrentSession,
        setAutoPhase: state.setAutoPhase,
        isSystemBusy: state.isSystemBusy,
        setIsSystemBusy: state.setIsSystemBusy,
    })));

    // --- ローカル状態管理 ---
    const [selectedDate, setSelectedDate] = useState<Date>(new Date());
    const [sampleNameInput, setSampleNameInput] = useState('');
    const [sessions, setSessions] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [baseDir, setBaseDir] = useState('');

    /**
     * 指定された日付のセッション一覧を取得します。
     */
    const fetchSessions = async (date: Date) => {
        setIsLoading(true);
        try {
            const dateDir = format(date, 'yyyyMMdd');
            const res = await autoApi.getSessions(dateDir);
            setSessions(res.sessions);
            setBaseDir(res.base_dir);
        } catch (error) {
            console.error('Failed to fetch sessions:', error);
            toast.error('Failed to load session list');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchSessions(selectedDate);
    }, [selectedDate]);

    /**
     * 新規セッション（サンプル）を作成します。
     * 安全規則: カレンダーの選択に関わらず、常に「今日」のフォルダに作成されます。
     */
    const handleCreateSession = async () => {
        if (isSystemBusy) return;
        
        setIsSystemBusy(true);
        try {
            const res = await autoApi.createSession(sampleNameInput);
            const settings = await autoApi.getSessionSettings(res.folder_path);
            
            setCurrentSession({
                folderPath: res.folder_path,
                sampleName: res.sample_name,
                settings: settings
            });
            
            toast.success(`Session created: ${res.sample_name}`);
            systemApi.postLogs('INFO', `New session created: ${res.sample_name}`);
            setAutoPhase('select_category');
        } catch (error) {
            console.error('Failed to create session:', error);
            toast.error('Failed to create new session');
        } finally {
            setIsSystemBusy(false);
        }
    };

    /**
     * 既存のセッションを再開します。
     */
    const handleResumeSession = async (folderName: string) => {
        if (isSystemBusy) return;

        setIsSystemBusy(true);
        try {
            const dateDirName = format(selectedDate, 'yyyyMMdd');
            const fullPath = `${baseDir}/${dateDirName}/${folderName}`;
            const settings = await autoApi.getSessionSettings(fullPath);

            setCurrentSession({
                folderPath: fullPath,
                sampleName: folderName,
                settings: settings
            });

            toast.success(`Session loaded: ${folderName}`);
            setAutoPhase('select_category');
        } catch (error) {
            console.error('Failed to resume session:', error);
            toast.error('Failed to load session settings');
        } finally {
            setIsSystemBusy(false);
        }
    };

    /**
     * 外部フォルダをブラウズしてロードします。
     */
    const handleBrowseFolder = async () => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: 'Select Sample Folder'
            });

            if (selected && typeof selected === 'string') {
                const settings = await autoApi.getSessionSettings(selected);
                setCurrentSession({
                    folderPath: selected,
                    sampleName: settings.sample_name || 'Unknown',
                    settings: settings
                });
                toast.success('Session loaded from folder');
                setAutoPhase('select_category');
            }
        } catch (error) {
            console.error('Browse error:', error);
            toast.error('Could not load from selected folder');
        }
    };

    return (
        <TooltipProvider>
            <div className="space-y-6">
                {/* Section: New Sample */}
                <div className="space-y-3">
                    <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                        New Sample
                    </Label>
                    <div className="space-y-2">
                        <div className="space-y-1">
                            <div className="flex items-center justify-between ml-1">
                                <span className="text-[10px] font-medium text-muted-foreground">
                                    Sample Name
                                </span>
                                <span className="text-[10px] text-muted-foreground/60 italic">
                                    Optional (Auto-generated if empty)
                                </span>
                            </div>
                            <Input
                                placeholder="Enter name or leave blank..."
                                value={sampleNameInput}
                                onChange={(e) => setSampleNameInput(e.target.value)}
                                className="font-mono h-9"
                                disabled={isSystemBusy}
                            />
                        </div>
                        <Button 
                            onClick={handleCreateSession}
                            disabled={isSystemBusy}
                            className="w-full h-9 font-bold"
                        >
                            <Plus className="size-4 mr-2" />
                            Create & Start
                        </Button>
                    </div>
                </div>

                <Separator />

                {/* Section: History */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                            Load History
                        </Label>
                        
                        <div className="flex gap-1">
                            {/* 日付選択 */}
                            <Popover>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <PopoverTrigger asChild>
                                            <Button variant="ghost" size="icon" className="h-7 w-7">
                                                <CalendarIcon className="size-3.5" />
                                            </Button>
                                        </PopoverTrigger>
                                    </TooltipTrigger>
                                    <TooltipContent>Change date</TooltipContent>
                                </Tooltip>
                                <PopoverContent className="w-auto p-0" align="end">
                                    <Calendar
                                        mode="single"
                                        selected={selectedDate}
                                        onSelect={(date) => date && setSelectedDate(date)}
                                    />
                                </PopoverContent>
                            </Popover>

                            {/* 外部フォルダ参照 */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleBrowseFolder}>
                                        <FolderOpen className="size-3.5" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>Browse folder</TooltipContent>
                            </Tooltip>

                            {/* リスト更新 */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => fetchSessions(selectedDate)}>
                                        <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>Refresh list</TooltipContent>
                            </Tooltip>
                        </div>
                    </div>

                    <div className="rounded-md border bg-background overflow-hidden">
                        <div className="px-3 py-1.5 bg-muted/50 border-b text-[10px] font-bold text-muted-foreground">
                            {format(selectedDate, 'yyyy-MM-dd')}
                        </div>
                        
                        <div className="max-h-[300px] overflow-y-auto">
                            <Table>
                                <TableBody>
                                    {isLoading ? (
                                        <TableRow><TableCell className="text-center py-8"><RefreshCw className="size-4 animate-spin mx-auto text-muted-foreground" /></TableCell></TableRow>
                                    ) : sessions.length === 0 ? (
                                        <TableRow><TableCell className="text-center py-8 text-xs text-muted-foreground italic">No sessions</TableCell></TableRow>
                                    ) : (
                                        sessions.map((session) => (
                                            <TableRow key={session} className="group hover:bg-muted/50 cursor-pointer" onClick={() => handleResumeSession(session)}>
                                                <TableCell className="py-2.5 px-3 font-mono text-xs">
                                                    {session}
                                                </TableCell>
                                                <TableCell className="text-right py-2.5 px-3">
                                                    <ChevronRight className="size-3 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
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
