import { useMemo, useState, useEffect } from 'react';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Label
} from 'recharts';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/useAppStore';
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from '@/components/ui/badge';
import { Activity, LineChart as LineChartIcon } from 'lucide-react';

/**
 * グラフ表示パネル (Graph Panel) コンポーネント
 * 
 * 自動測定中のデータをリアルタイムに可視化します。
 * recharts を使用し、ROIごとのデータを色分けして表示します。
 */
export function GraphPanel() {
    // --- ストアからデータを取得 ---
    const { plotData, rois, isMeasuring, isPrescan } = useAppStore(useShallow((state) => ({
        plotData: state.plotData,
        rois: state.rois,
        isMeasuring: state.isMeasuring,
        isPrescan: state.isPrescan
    })));

    // グラフの表示モード
    type DisplayMode = 'sum' | 'max' | 'center' | 'drift';
    const [mode, setMode] = useState<DisplayMode>('sum');

    // Pre-Scan が始まったら自動的に 'max' モードに切り替える
    useEffect(() => {
        if (isPrescan) {
            setMode('max');
        } else if (isMeasuring) {
            setMode('sum');
        }
    }, [isPrescan, isMeasuring]);

    // --- データの変換 (recharts 用) ---
    /**
     * バックエンドから届くデータを recharts が解釈できる形式に変換・統合します。
     * 
     * 【技術的解説】
     * バックエンドからは ROI ごとにバラバラの配列（Record<string, PlotDataPoint[]>）が届きます。
     * しかし、recharts の LineChart は「1つのオブジェクトに複数の ROI の値が入っている」形式
     * (例: [{ angle: 0, roi_1_val: 100, roi_2_val: 150 }, ...]) を好みます。
     * この useMemo では、全 ROI のデータを走査し、同じ角度のデータを1つのエントリにマージしています。
     * これにより、複数の線が1つのグラフ上に正しく重なって表示されるようになります。
     */
    const chartData = useMemo(() => {
        // 角度をキーとしたマップを作成
        const angleMap = new Map<number, any>();

        Object.entries(plotData).forEach(([roiKey, points]) => {
            const roiIndex = roiKey.replace('roi_', '');
            
            points.forEach((p) => {
                if (!angleMap.has(p.angle)) {
                    angleMap.set(p.angle, { angle: p.angle });
                }
                const entry = angleMap.get(p.angle);
                
                // モードに応じて格納する値を変える
                if (mode === 'sum') {
                    entry[`${roiKey}_val`] = p.sum;
                } else if (mode === 'max') {
                    entry[`${roiKey}_val`] = p.max;
                } else if (mode === 'center') {
                    entry[`${roiKey}_val`] = p.center_val;
                } else if (mode === 'drift') {
                    /**
                     * ドリフト（重心ズレ）の算出:
                     * ROI の幾何学的中心 (roi.x, roi.y) を基準点とし、現在の輝度重心 (p.cx, p.cy) 
                     * がそこからどれだけ離れているかをピクセル単位の距離（ユークリッド距離）で求めます。
                     * 式: sqrt((cx - base_x)^2 + (cy - base_y)^2)
                     * このグラフが平坦であれば、粒子が測定中に物理的に安定していることを証明できます。
                     */
                    const roi = rois.find(r => r.index === parseInt(roiIndex));
                    if (roi) {
                        const dx = p.cx - roi.x;
                        const dy = p.cy - roi.y;
                        entry[`${roiKey}_val`] = Math.sqrt(dx * dx + dy * dy);
                    } else {
                        entry[`${roiKey}_val`] = 0;
                    }
                }
            });
        });

        // 角度順にソートして配列に戻す
        return Array.from(angleMap.values()).sort((a, b) => a.angle - b.angle);
    }, [plotData, mode, rois]);

    // モードに応じたラベルと単位
    const modeInfo = {
        sum: { label: 'Intensity (Sum)', unit: 'counts', color: 'text-blue-400' },
        max: { label: 'Saturation (Max)', unit: 'counts', color: 'text-amber-400' },
        center: { label: 'Center Pixel', unit: 'counts', color: 'text-emerald-400' },
        drift: { label: 'Stability (Drift)', unit: 'px', color: 'text-purple-400' },
    };

    return (
        <div className="h-full w-full flex flex-col overflow-hidden">
            {/* ヘッダー: モード切り替え */}
            <div className="shrink-0 px-4 py-2 border-b bg-muted/30 flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-widest flex items-center">
                        <Activity className="size-3 mr-1.5 opacity-50" />
                        Real-time Profile
                    </span>
                    <Badge variant="outline" className={`text-[9px] font-bold h-5 px-2 bg-background border-none shadow-sm ${modeInfo[mode].color}`}>
                        {modeInfo[mode].label}
                    </Badge>
                </div>

                <Tabs value={mode} onValueChange={(v) => setMode(v as DisplayMode)} className="h-7">
                    <TabsList className="h-7 p-0.5 bg-background/50 border">
                        <TabsTrigger value="sum" className="text-[9px] h-6 px-2.5">Sum</TabsTrigger>
                        <TabsTrigger value="max" className="text-[9px] h-6 px-2.5">Max</TabsTrigger>
                        <TabsTrigger value="center" className="text-[9px] h-6 px-2.5">Center</TabsTrigger>
                        <TabsTrigger value="drift" className="text-[9px] h-6 px-2.5">Drift</TabsTrigger>
                    </TabsList>
                </Tabs>
            </div>

            {/* グラフ描画エリア */}
            <div className="flex-1 min-h-0 p-4 pt-6 bg-zinc-800 relative">
                {chartData.length === 0 ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center space-y-3 opacity-20">
                        <LineChartIcon className="size-8 text-muted-foreground animate-pulse" />
                        <span className="text-[10px] font-medium uppercase tracking-[0.3em] text-zinc-100">Waiting for measurement data...</span>
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 5, right: 30, left: 10, bottom: 20 }}>
                            {/* 罫線: 背景より少し明るい色にしてガイドとして機能させる */}
                            <CartesianGrid strokeDasharray="3 3" stroke="#444" vertical={true} opacity={0.3} />
                            
                            <XAxis 
                                dataKey="angle" 
                                type="number" 
                                domain={['auto', 'auto']}
                                tick={{ fontSize: 10, fill: '#888' }}
                                stroke="#666"
                                tickLine={{ stroke: '#666' }}
                            >
                                <Label value="QWP Angle [deg]" offset={-15} position="insideBottom" style={{ fontSize: '10px', fill: '#aaa', fontWeight: 'bold' }} />
                            </XAxis>
                            
                            <YAxis 
                                tick={{ fontSize: 10, fill: '#888' }}
                                stroke="#666"
                                tickLine={{ stroke: '#666' }}
                                domain={mode === 'max' || mode === 'center' ? [0, 255] : ['auto', 'auto']}
                            >
                                <Label value={`[${modeInfo[mode].unit}]`} angle={-90} position="insideLeft" style={{ fontSize: '10px', fill: '#aaa', fontWeight: 'bold', textAnchor: 'middle' }} />
                            </YAxis>

                            <Tooltip 
                                contentStyle={{ 
                                    backgroundColor: 'rgba(0, 0, 0, 0.5)', 
                                    backdropFilter: 'blur(12px)',
                                    WebkitBackdropFilter: 'blur(12px)',
                                    border: '1px solid #3f3f46', 
                                    fontSize: '11px', 
                                    borderRadius: '8px', 
                                    color: '#fff',
                                    padding: '8px 12px',
                                    boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4)'
                                }}
                                itemStyle={{ padding: '2px 0' }}
                                labelStyle={{ color: '#aaa', marginBottom: '4px', fontWeight: 'bold' }}
                                labelFormatter={(v) => `${v}°`}
                                cursor={{ stroke: '#555', strokeWidth: 1 }}
                                // ツールチップ内の表示順を ROI インデックス数値順にする
                                itemSorter={(item) => {
                                    // dataKey が "roi_1_val" のような形式なので、数値部分を抽出
                                    const match = String(item.dataKey).match(/roi_(\d+)/);
                                    return match ? parseInt(match[1], 10) : 0;
                                }}
                            />

                            {/* ROIごとに線を引く */}
                            {rois.map((roi) => (
                                <Line
                                    key={roi.id}
                                    // 測定機器として誠実な直線結び（monotone だと架空の極値が見えてしまうため）
                                    type="linear" 
                                    dataKey={`roi_${roi.index}_val`}
                                    name={`ROI ${roi.index}`}
                                    // ROIの枠の色と同期させることで、どの粒子か一目で判別可能にします
                                    stroke={roi.color || '#8884d8'}
                                    strokeWidth={1.5}
                                    dot={{ r: 2, fill: roi.color, strokeWidth: 0 }}
                                    activeDot={{ r: 4, strokeWidth: 0 }}
                                    // リアルタイム性を優先し、点が増える際のアニメーションを無効化
                                    animationDuration={0} 
                                    isAnimationActive={false}
                                />
                            ))}
                        </LineChart>
                    </ResponsiveContainer>
                )}
            </div>
            
            {/* 凡例・メタデータ領域 */}
            <div className="shrink-0 px-4 py-1.5 border-t bg-muted/10 flex gap-4 overflow-x-auto no-scrollbar">
                {rois.map((roi) => (
                    <div key={roi.id} className="flex items-center gap-1.5 shrink-0">
                        <div className="size-1.5 rounded-full" style={{ backgroundColor: roi.color }}></div>
                        <span className="text-[9px] font-bold text-muted-foreground whitespace-nowrap">ROI {roi.index}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
