import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { axisPropsOf, useChartTheme } from '../../lib/chartTheme';
import { REST_SERIES_KEY, type TrendSeries } from '../../pages/dashboard/modelTrend';

/**
 * 各模型消耗趋势折线图（issue #160）：每个模型一条折线，逐日展示消耗
 * （积分 / 请求数口径由调用方决定并标注）。系列 = Top8 +「其他」聚合（buildModelTrend 生成）。
 * 组件不做空态兜底——空态文案与数据源口径强相关，由调用方展示（§8 诚实标注约定）。
 */

export default function ModelTrendChart({
  rows,
  series,
  showDots,
  fmtValue,
}: {
  /** 逐日行：label + 各系列数值（缺失日补 0 由调用方负责） */
  rows: Record<string, number | string>[];
  /** 折线系列（按区间累计降序，「其他」在末位） */
  series: TrendSeries[];
  /** 短区间显示数据点 */
  showDots: boolean;
  /** Tooltip 数值格式化 */
  fmtValue: (n: number) => string;
}) {
  const chart = useChartTheme();
  const axisProps = axisPropsOf(chart);

  return (
    <div className="h-64">
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} opacity={0.25} vertical={false} />
          <XAxis dataKey="label" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} axisLine={false} width={56} />
          <Tooltip contentStyle={chart.tooltip} formatter={(v: number, name: string) => [fmtValue(v), name]} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={
                s.key === REST_SERIES_KEY ? chart.rest : chart.ramp[i % chart.ramp.length]
              }
              strokeWidth={1.5}
              dot={showDots ? { r: 2, strokeWidth: 0 } : false}
              activeDot={{ r: 4 }}
              connectNulls
              // 年区间 365 点 × 9 线关闭入场动画，避免切区间卡顿
              isAnimationActive={rows.length > 60 ? false : undefined}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
