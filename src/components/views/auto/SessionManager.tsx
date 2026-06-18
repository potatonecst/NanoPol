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
    // Zustandストアからグローバル状態を取得
    // useShallow: 必要なパラメータだけを取り出し、不要な再レンダリングを防止するためのReact用最適化フック
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
    // カレンダーで選択されている日付 (初期値は今日)
    const [selectedDate, setSelectedDate] = useState<Date>(new Date());
    // サンプル名入力ボックスの文字列
    const [sampleNameInput, setSampleNameInput] = useState('');
    // 取得したセッション履歴のリスト (作成日時や進捗情報を含む)
    const [sessions, setSessions] = useState<Array<{ name: string; created_at: string; progress: string; }>>([]);
    // ローディング中フラグ
    const [isLoading, setIsLoading] = useState(false);
    // 自動測定データの保存起点ディレクトリ (バックエンドから取得)
    const [baseDir, setBaseDir] = useState('');

    /**
     * 指定された日付のセッション一覧をバックエンドから非同期で取得します。
     * バックエンド側で各フォルダの settings.json から作成日時と進捗（例: 2/4）を集約して返します。
     */
    const fetchSessions = async (date: Date) => {
        setIsLoading(true);
        try {
            // YYYYMMDD形式にフォーマットしてバックエンドAPIに送信
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

    // 選択された日付が変わるたびにセッション履歴を再取得する
    useEffect(() => {
        fetchSessions(selectedDate);
    }, [selectedDate]);

    /**
     * 新規セッション（サンプル）を作成します。
     * 安全規則: カレンダーの選択日付に関わらず、新規作成は必ず「実行した当日（今日）」のフォルダに作成されます。
     */
    const handleCreateSession = async () => {
        if (isSystemBusy) return;
        
        setIsSystemBusy(true);
        try {
            const res = await autoApi.createSession(sampleNameInput);
            // 新規作成されたフォルダ内の settings.json をロード
            const settings = await autoApi.getSessionSettings(res.folder_path);
            
            // ストアに現在のセッション情報を格納
            setCurrentSession({
                folderPath: res.folder_path,
                sampleName: res.sample_name,
                settings: settings
            });
            
            toast.success(`Session created: ${res.sample_name}`);
            systemApi.postLogs('INFO', `New session created: ${res.sample_name}`);
            // UIフェーズを「測定カテゴリ選択」に進める
            setAutoPhase('select_category');
        } catch (error) {
            console.error('Failed to create session:', error);
            toast.error('Failed to create new session');
        } finally {
            setIsSystemBusy(false);
        }
    };

    /**
     * 既存のセッションを選択して再開します。
     */
    const handleResumeSession = async (folderName: string) => {
        if (isSystemBusy) return;

        setIsSystemBusy(true);
        try {
            const dateDirName = format(selectedDate, 'yyyyMMdd');
            // 大元のベースディレクトリ、日付、フォルダ名を結合してフルパスを構築
            const fullPath = `${baseDir}/${dateDirName}/${folderName}`;
            // 選択されたフォルダ内の settings.json（進行状況やROI情報を含む）を読み込む
            const settings = await autoApi.getSessionSettings(fullPath);

            setCurrentSession({
                folderPath: fullPath,
                sampleName: folderName,
                settings: settings
            });

            toast.success(`Session loaded: ${folderName}`);
            // UIフェーズを「測定カテゴリ選択」に進める
            setAutoPhase('select_category');
        } catch (error) {
            console.error('Failed to resume session:', error);
            toast.error('Failed to load session settings');
        } finally {
            setIsSystemBusy(false);
        }
    };

    /**
     * 外部フォルダをダイアログからブラウズしてセッションをロードします。
     */
    const handleBrowseFolder = async () => {
        try {
            // Tauriのダイアログプラグインを呼び出し、OSネイティブのフォルダ選択画面を表示
            const selected = await open({
                directory: true, // フォルダ選択モード
                multiple: false, // 複数選択不可
                title: 'Select Sample Folder'
            });

            if (selected && typeof selected === 'string') {
                // 選択されたフォルダ内の設定ファイルを読み込む
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
            {/* 全体レイアウト: 垂直方向の間隔6 (space-y-6) */}
            <div className="space-y-6">
                
                {/* 1. 新規サンプル作成セクション */}
                <div className="space-y-3">
                    <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                        New Sample
                    </Label>
                    <div className="space-y-2">
                        <div className="space-y-1">
                            {/* ラベルと注釈を左右端に配置 */}
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
                        {/* [Create & Start] ボタン: 入力されたサンプル名をもとに新規セッションを生成して開始します */}
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

                {/* 2. 既存セッションの履歴読み込みセクション */}
                <div className="space-y-3">
                    <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block">
                        Load History
                    </Label>
                    
                    {/* 日付選択(Date Picker)・ブラウズ・更新を一行にまとめた操作エリア */}
                    {/* flex: 横並び配置。gap-1.5: ボタン間隔。items-center: 垂直方向の中央揃え */}
                    <div className="flex gap-1.5 items-center w-full">
                        
                        {/* 日付選択 Popover と Calendar */}
                        {/* Popover はクリックで浮かび上がるメニューを表示するコンポーネントです */}
                        <Popover>
                            {/* PopoverTrigger: クリック対象となるトリガーボタン */}
                            {/* asChild を指定することで、内部のButtonに開閉動作を付与します */}
                            <PopoverTrigger asChild>
                                <Button 
                                    variant="outline" 
                                    size="sm" 
                                    className="flex-1 justify-start font-mono text-xs h-8 px-2.5"
                                    disabled={isSystemBusy} // システムが動作中は誤操作防止のため無効化
                                >
                                    <CalendarIcon className="size-3.5 mr-2 text-muted-foreground" />
                                    {/* 選択されたDateオブジェクトを 'YYYY-MM-DD' 形式の文字列に変換してボタンに表示します */}
                                    {format(selectedDate, 'yyyy-MM-dd')}
                                </Button>
                            </PopoverTrigger>
                            {/* PopoverContent: ポップオーバーで浮かび上がるカレンダー本体 */}
                            {/* align="start": ボタンの左端に合わせて表示を開始します */}
                            <PopoverContent className="w-auto p-0" align="start">
                                <Calendar
                                    mode="single" // 単一日付の選択モード
                                    selected={selectedDate}
                                    onSelect={(date) => date && setSelectedDate(date)} // 日付選択時に内部の状態を更新して再ポーリングを走らせる
                                />
                            </PopoverContent>
                        </Popover>

                        {/* OSダイアログ経由の任意フォルダ選択ボタン */}
                        {/* Tooltip: ホバー時に説明文を表示するアクセシビリティコンポーネント */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button 
                                    variant="outline" 
                                    size="icon" 
                                    className="h-8 w-8 shrink-0" 
                                    onClick={handleBrowseFolder} // Tauri のダイアログを開いて既存の実験フォルダを手動指定
                                    disabled={isSystemBusy}
                                >
                                    <FolderOpen className="size-3.5" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Browse folder</TooltipContent>
                        </Tooltip>

                        {/* リスト手動更新ボタン */}
                        {/* サーバー側の日付フォルダに変更があった場合に手動で一覧を同期させます */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button 
                                    variant="outline" 
                                    size="icon" 
                                    className="h-8 w-8 shrink-0" 
                                    onClick={() => fetchSessions(selectedDate)} // 現在選択中の日付で再読み込み
                                    disabled={isSystemBusy || isLoading} // ローディング中やシステム動作中は無効化
                                >
                                    {/* isLoading が true の間だけ、ローダーアイコンがくるくると回転（animate-spin）します */}
                                    <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Refresh list</TooltipContent>
                        </Tooltip>
                    </div>

                    {/* セッション履歴一覧テーブル */}
                    {/* border, rounded-md, bg-background で角丸の枠線を定義し、中身がはみ出た場合は隠す（overflow-hidden） */}
                    <div className="rounded-md border bg-background overflow-hidden">
                        {/* max-h-[300px]: 履歴が増えすぎた場合に画面を圧迫しないよう高さを最大300pxに制限し、縦スクロール（overflow-y-auto）を許可 */}
                        <div className="max-h-[300px] overflow-y-auto">
                            <Table>
                                <TableBody>
                                    {/* 1. 読み込み中 (isLoading === true) の表示 */}
                                    {isLoading ? (
                                        <TableRow>
                                            <TableCell className="text-center py-8">
                                                <RefreshCw className="size-4 animate-spin mx-auto text-muted-foreground" />
                                            </TableCell>
                                        </TableRow>
                                    ) : /* 2. 該当日にセッションフォルダが存在しない場合の表示 */
                                    sessions.length === 0 ? (
                                        <TableRow>
                                            <TableCell className="text-center py-8 text-xs text-muted-foreground italic">
                                                No sessions found
                                            </TableCell>
                                        </TableRow>
                                    ) : (
                                        /* 3. 取得したセッション配列を展開してテーブル表示 */
                                        sessions.map((session) => (
                                            <TableRow 
                                                key={session.name} 
                                                className="group hover:bg-muted/50 cursor-pointer" 
                                                onClick={() => handleResumeSession(session.name)} // 行をクリックした際にそのセッションを再開する
                                            >
                                                {/* 左側セル: サンプル名と作成時刻を表示 */}
                                                <TableCell className="py-2.5 px-3">
                                                    {/* truncate max-w-[150px]: 文字数が長すぎる場合は末尾を「...」に省略 */}
                                                    <div className="font-mono text-xs font-bold truncate max-w-[150px]">
                                                        {session.name}
                                                    </div>
                                                    {/* ISOタイムスタンプ文字列から時間を抽出し、HH:mm:ss 形式に整形して表示 */}
                                                    <div className="text-[10px] text-muted-foreground mt-0.5">
                                                        {session.created_at ? (() => {
                                                            try {
                                                                // new Date(ISOString) で日付にパースし、format() を使用
                                                                return format(new Date(session.created_at), 'HH:mm:ss');
                                                            } catch (e) {
                                                                // パースに失敗した場合は予期せぬ形式とみなしプレースホルダーを返す
                                                                return '---';
                                                            }
                                                        })() : '---'}
                                                    </div>
                                                </TableCell>
                                                {/* 右側セル: 測定進捗状況（4つの入射条件のうちいくつ完了したか）と遷移矢印を表示 */}
                                                <TableCell className="py-2.5 px-3 text-right">
                                                    {/* flex: 右寄せと並び順を制御。gap-2: バッジと矢印の間隔 */}
                                                    <div className="flex items-center justify-end gap-2">
                                                        {/* 進捗バッジ: 2/4 のように、設定ファイルから集約した完了済みの測定数を表示 */}
                                                        <span className="text-[10px] font-bold bg-secondary/80 px-1.5 py-0.5 rounded text-secondary-foreground font-mono">
                                                            {session.progress}
                                                        </span>
                                                        {/* テーブル行にホバーした時だけ矢印アイコンが表示（opacity-100）される group ホバー演出 */}
                                                        <ChevronRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                                                    </div>
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
