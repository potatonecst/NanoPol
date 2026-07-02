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
import { MeasurementManager } from './auto/MeasurementManager';
import { GraphPanel } from '../shared/GraphPanel';

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
            <div className="w-full md:w-80 border-r bg-card flex flex-col h-full z-10 overflow-hidden">
                <div className="p-8 pb-5 shrink-0">
                    <h2 className="text-2xl font-bold tracking-tight">Auto Measurement</h2>
                    <p className="text-xs text-muted-foreground mt-2">Guided measurement workflow.</p>
                </div>

                {/* フェーズごとのコンテンツ表示 */}
                <div className="flex-1 overflow-hidden pb-8">
                    {autoPhase === 'select_session' && (
                        <div className="space-y-5 h-full overflow-y-auto pl-8 pr-6 animate-in fade-in slide-in-from-left-4 duration-500">
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
                        <div className="space-y-6 h-full overflow-y-auto pl-8 pr-6 animate-in fade-in slide-in-from-left-4 duration-500">
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
                        <div className="h-full pl-8 pr-6 animate-in fade-in slide-in-from-left-4 duration-500">
                            <MeasurementManager />
                        </div>
                    )}
                </div>
            </div>

            {/* 
                右側: ビュー領域 
                上下分割構造。 orientation="vertical" を使用します。

                【重要：Windows実機環境（WebView2）における描画乱れ対策とGPU隔離】
                可変の分割パネル（ResizablePanelGroup）の中で高頻度に再描画される要素（カメラ映像、グラフSVG）が
                同居した際、Windows実機環境（WebView2/Chromium）の描画エンジンの部分描画フリーズ（Partial Paint）
                により、画面全体が乱れたりポインタの動きに合わせて要素が見え隠れする不具合が発生していました。
                これを防ぐため、親コンテナおよび各パネルのラッパー要素に対して transform: translate3d(0,0,0) と
                backface-visibility: hidden を適用し、GPU上で個別の独立した合成レイヤーとして強制隔離します。

                ※なお、標準プロパティの will-change: transform は、カメラ画像拡大時に荒い初期テクスチャをGPUにキャッシュ固定
                させてしまい「ぼやけバグ」を引き起こすため使用せず、あえてこの無変形3Dハック（translate3d）を採用しています。
            */}
            <div 
                className="flex-1 h-full overflow-hidden bg-secondary/20 relative"
                style={{
                    transform: 'translate3d(0, 0, 0)',
                    backfaceVisibility: 'hidden'
                }}
            >
                <ResizablePanelGroup orientation="vertical">
                    {/* 上段: カメラ映像パネル */}
                    <ResizablePanel defaultSize={65} minSize={30}>
                        {/* 
                            CameraPanel が正しく表示されるよう、flex コンテナで包みます。
                            これにより、ManualView と同じ表示ロジックが働きます。
                        */}
                        <div 
                            className="flex flex-col h-full w-full overflow-hidden"
                            style={{
                                transform: 'translate3d(0, 0, 0)',
                                backfaceVisibility: 'hidden'
                            }}
                        >
                            <CameraPanel showAngle={true} />
                        </div>
                    </ResizablePanel>

                    {/* リサイズ用ハンドル */}
                    <ResizableHandle withHandle />

                    {/* 下段: グラフ表示パネル */}
                    {/* minSize を少し増やして、ヘッダーが埋もれないように調整 */}
                    <ResizablePanel defaultSize={35} minSize={32}>
                        <div 
                            className="h-full w-full overflow-hidden"
                            style={{
                                transform: 'translate3d(0, 0, 0)',
                                backfaceVisibility: 'hidden'
                            }}
                        >
                            <GraphPanel />
                        </div>
                    </ResizablePanel>
                </ResizablePanelGroup>
            </div>
        </div>
    );
}
