import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/useAppStore';
import { CameraPanel } from '../shared/CameraPanel';
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
import { SessionManager } from './auto/SessionManager';
import { CategorySelector } from './auto/CategorySelector';

/**
 * 自動測定画面 (Auto View) コンポーネント
 * 
 * ManualView のレイアウトをベースに、右側パネルを上下に分割して
 * カメラ映像とグラフを同時に表示できるようにしています。
 */
export function AutoView() {
    // Zustandストアから現在のフェーズを取得
    const { autoPhase } = useAppStore(useShallow((state) => ({
        autoPhase: state.autoPhase,
    })));

    return (
        <div className="flex h-full w-full flex-col md:flex-row overflow-hidden bg-background">
            {/* 
                左側: 操作パネル領域 (ManualView と同一の md:w-80)
            */}
            <div className="w-full md:w-80 border-r bg-card flex flex-col h-full z-10 overflow-y-auto p-8">
                <div className="pb-5">
                    {/* 他のViewと統一するため text-2xl に修正 */}
                    <h2 className="text-2xl font-bold tracking-tight">Auto Measurement</h2>
                    <p className="text-sm text-muted-foreground mt-2">Guided measurement workflow.</p>
                </div>

                {/* フェーズごとのコンテンツ表示 */}
                <div className="flex-1">
                    {autoPhase === 'select_session' && (
                        <div className="space-y-5 animate-in fade-in slide-in-from-left-4 duration-500">
                            <div>
                                <h3 className="text-lg font-semibold italic">1. Session Management</h3>
                                <p className="text-xs text-muted-foreground text-pretty leading-relaxed">
                                    Initialize a new sample or resume from existing experiment data.
                                </p>
                            </div>
                            <SessionManager />
                        </div>
                    )}

                    {autoPhase === 'select_category' && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-left-4 duration-500">
                            <div>
                                <h3 className="text-lg font-semibold italic">2. Category Selection</h3>
                                <p className="text-xs text-muted-foreground text-pretty leading-relaxed">
                                    Choose the specific measurement condition (e.g., Left-Front) to perform.
                                </p>
                            </div>
                            <CategorySelector />
                        </div>
                    )}

                    {autoPhase === 'measuring' && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-left-4 duration-500">
                            <div>
                                <h3 className="text-lg font-semibold italic">3. Measurement Run</h3>
                                <p className="text-xs text-muted-foreground text-pretty leading-relaxed">
                                    Execute the automated sequence including alignment and data acquisition.
                                </p>
                            </div>
                            {/* TODO: MeasurementManager コンポーネント */}
                            <div className="p-8 border-2 border-dashed rounded-xl bg-secondary/10 text-center text-xs text-muted-foreground">
                                Execution Controls
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* 
                右側: ビュー領域 
                上下分割構造。 orientation="vertical" を使用します。
            */}
            <div className="flex-1 h-full overflow-hidden bg-secondary/20 relative">
                <ResizablePanelGroup orientation="vertical">
                    {/* 上段: カメラ映像パネル */}
                    <ResizablePanel defaultSize={65} minSize={30}>
                        {/* 
                            CameraPanel が正しく表示されるよう、flex コンテナで包みます。
                            これにより、ManualView と同じ表示ロジックが働きます。
                        */}
                        <div className="flex flex-col h-full w-full overflow-hidden">
                            <CameraPanel showAngle={true} />
                        </div>
                    </ResizablePanel>

                    {/* リサイズ用ハンドル */}
                    <ResizableHandle withHandle />

                    {/* 下段: グラフ表示パネル */}
                    {/* minSize を少し増やして、ヘッダーが埋もれないように調整 */}
                    <ResizablePanel defaultSize={35} minSize={32}>
                        <div className="h-full w-full bg-background flex flex-col border-t overflow-hidden">
                            {/* グラフのタイトルヘッダー */}
                            <div className="shrink-0 px-4 py-2 border-b bg-muted/30 flex justify-between items-center">
                                <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-widest">
                                    Scattering Intensity Profile
                                </span>
                            </div>

                            {/* グラフ描画エリア */}
                            <div className="flex-1 flex items-center justify-center bg-card">
                                {/* TODO: GraphPanel (recharts) の実装 */}
                                <div className="text-muted-foreground/30 text-[10px] font-medium uppercase tracking-[0.3em]">
                                    Graph Area
                                </div>
                            </div>
                        </div>
                    </ResizablePanel>
                </ResizablePanelGroup>
            </div>
        </div>
    );
}
