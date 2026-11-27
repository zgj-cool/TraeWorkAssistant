import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  Line,
  XAxis,
  YAxis,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { Activity } from 'lucide-react';
import ChartFilterBar from '../../components/ChartFilterBar';
import ActivityHeatmap from '../../components/charts/ActivityHeatmap';
import ModelTrendChart from '../../components/charts/ModelTrendChart';
import { Badge, EmptyState, StatCard } from '../../components/ui';
import { useDateRange } from '../../hooks/useDateRange';
import { axisPropsOf, useChartTheme } from '../../lib/chartTheme';
import type { UsageDayView, UsageHistoryResult } from '../../types';
import type { PlatformScope } from './KpiRow';
import { buildModelTrend } from './modelTrend';

/**
 * Token 统计 Tab（credits-dashboard-plan.md §3.2/§5.2，批次 3 = issue #35 Bug2 用户可见修复）：
 * ① 总 Token 统计卡（总/输入/输出/缓存命中率；Trae 追加「账单口径缓存」对账卡，issue #169）
 * ② Token 与调用趋势（双轴堆叠柱 + 调用虚线）
 * ③ 各模型消耗趋势（issue #160）④ 年度活动热力图。
 * 数据源固定为 API 网关（api_usage_stats / api_wb_usage_stats / qoder 池，90 天代理转发口径）；
 * 本地会话扫描（workbuddy_token_stats）与官网 token 字段两个口径已下线——与网关实测差异大，
 * 统一以网关转发口径为准。仅覆盖走本地网关的流量，直连官方的流量不在内（页面明示）。
 * 统一口径：总 Token = input + output（网关 cache_write 恒 0）。
 * issue #169：Trae 上游 2026-10-28 起 token_usage 事件显式下发 cached_tokens=0（账单侧
 * cache_read 正常计费），网关转发口径单请求无法恢复真实缓存值（不伪造，出站保持 0）。
 * Trae 平台并列展示官网账单口径 cache_read 作对账参照（数据独立不混合）。
 * 缓存命中率：缓存读取 / 输入总量；网关有真实 cached_tokens 入账即出比率，
 * 仅「确实无下发」时显示「—」，避免把可用数据一并隐藏。
 */

const SEG_LABELS: Record<string, string> = {
  cache_read: '缓存读取',
  new_input: '新增输入',
  output: '输出',
  cache_write: '缓存写入',
  input: '输入',
};

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return n.toLocaleString('zh-CN');
}

/** 网关源按平台维度选取（Trae 池 / Buddy 池 / Qoder 池；custom 池仅 API 服务页 UsageStatsPanel 展示） */
function gwPoolsFor(gw: GatewayDays | null, scope: PlatformScope): UsageDayView[] {
  if (!gw) return [];
  return scope === 'trae' ? gw.trae : scope === 'buddy' ? gw.buddy : gw.qoder;
}

export interface GatewayDays {
  trae: UsageDayView[];
  buddy: UsageDayView[];
  qoder: UsageDayView[];
}

type DayAgg = { input: number; output: number; cache_read: number; cache_write: number; calls: number };
const emptyAgg = (): DayAgg => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, calls: 0 });

export default function TokensTab({
  scope,
  usage,
  gateway,
}: {
  scope: PlatformScope;
  /** Trae 官网消耗明细（仅用于「账单口径缓存」对账卡，issue #169） */
  usage: UsageHistoryResult | null;
  /** API 网关 Trae/Buddy/Qoder 池用量（90 天，唯一数据源） */
  gateway: GatewayDays | null;
}) {
  const chart = useChartTheme();
  // 统计周期默认「今日」（与积分统计 Tab 一致）
  const { range, setRange, startStr, todayStr, dateList } = useDateRange('today');
  const [modelFilter, setModelFilter] = useState('');
  // 切平台时清空模型筛选：旧平台模型在新平台列表中不存在，残留会让趋势静默归零
  useEffect(() => setModelFilter(''), [scope]);

  // 精确等值（三平台扩展）：二元取反会让 qoder 页同时命中 trae/buddy 分支
  const traeActive = scope === 'trae';
  const inRange = (date: string) => date >= startStr && date <= todayStr;

  // ---- 范围 × 模型 × 平台 聚合（API 网关） ----
  const agg = useMemo(() => {
    const byDate = new Map<string, DayAgg>();
    // 各模型消耗趋势（issue #160）：模型 → 日期 → 数值（恒为全模型，不随模型筛选联动）
    const modelByDate = new Map<string, Map<string, number>>();
    const addModelDay = (date: string, model: string, v: number) => {
      let m = modelByDate.get(model);
      if (!m) {
        m = new Map();
        modelByDate.set(model, m);
      }
      m.set(date, (m.get(date) ?? 0) + v);
    };
    const addDay = (date: string, p: DayAgg) => {
      const cur = byDate.get(date) ?? emptyAgg();
      cur.input += p.input;
      cur.output += p.output;
      cur.cache_read += p.cache_read;
      cur.cache_write += p.cache_write;
      cur.calls += p.calls;
      byDate.set(date, cur);
    };

    for (const day of gwPoolsFor(gateway, scope)) {
      if (!inRange(day.date)) continue;
      // issue #169 审查修复：缓存读取数据驱动（UsageDayView.cached_tokens），不再硬编码 0；
      // Trae 池当前上游显式下发 0（展示如实为 0），WB/Qoder 池有真实入账
      addDay(day.date, {
        input: day.prompt_tokens,
        output: day.completion_tokens,
        cache_read: day.cached_tokens ?? 0,
        cache_write: 0,
        calls: day.total_requests,
      });
      for (const m of day.models) {
        // 趋势图恒为全模型；网关源无按模型 token 明细，趋势口径 = 请求数（§3.1 同款诚实声明）
        addModelDay(day.date, m.name, m.requests);
      }
    }
    // Trae 网关源的账单口径缓存对账（issue #169）：官网 usage_history 的 cache_read
    // 是官方计费的真实缓存值；网关转发口径 cached_tokens 恒 0（上游事件层不携带）。
    // 独立维度累计（不混入 agg.cache_read 的堆叠/命中率计算），仅对账卡展示；
    // 命中率分母同源取官网 input（供应商语义已含缓存读取）。
    // days 按自然日去重：accounts × daily 双层循环下多账号同日有缓存会重复计数
    const billingCacheRead = { total: 0, input: 0, days: 0 };
    const billingCacheDays = new Set<string>();
    if (traeActive && usage) {
      for (const a of usage.accounts) {
        for (const d of a.daily) {
          if (!inRange(d.date)) continue;
          billingCacheRead.total += d.cache_read_tokens;
          billingCacheRead.input += d.input_tokens;
          if (d.cache_read_tokens > 0) billingCacheDays.add(d.date);
        }
      }
      billingCacheRead.days = billingCacheDays.size;
    }
    let input = 0, output = 0, cache_read = 0, cache_write = 0, calls = 0;
    for (const v of byDate.values()) {
      input += v.input;
      output += v.output;
      cache_read += v.cache_read;
      cache_write += v.cache_write;
      calls += v.calls;
    }
    return { byDate, modelByDate, input, output, cache_read, cache_write, calls, billingCacheRead };
  }, [traeActive, gateway, scope, usage, modelFilter, startStr, todayStr]);

  // ---- 口径派生：总 Token / 缓存命中率 / 堆叠段 ----
  // 统一口径：总 Token = input + output（网关 cache_write 恒 0）
  const totalTokens = agg.input + agg.output + agg.cache_write;
  // 数据驱动：网关源有缓存测量即出比率，确实无下发时如实显示「—」（不伪造 0%）
  const hitRate = agg.input > 0 && agg.cache_read > 0 ? agg.cache_read / agg.input : null;
  // Trae 账单口径缓存命中率（issue #169 对账）：官方账单 cache_read / 官网 input
  // （官网 input 按供应商语义已含缓存读取，与官网口径同分母）。转发口径恒 0
  // 时用户在此直接看到真实命中率
  const billingHitRate =
    traeActive && agg.billingCacheRead.total > 0 && agg.billingCacheRead.input > 0
      ? agg.billingCacheRead.total / agg.billingCacheRead.input
      : null;
  // 网关源按「缓存读取 + 新增输入 + 输出」堆叠：WB/Qoder 池有真实缓存入账时
  // 才出现缓存段（Trae 池上游恒 0 时该段自然为空，柱形与旧「输入/输出」一致）
  const segments = ['cache_read', 'new_input', 'output'] as const;

  // ---- 趋势数据（堆叠柱 + 调用虚线）----
  const trend = useMemo(
    () =>
      dateList.map((date) => {
        const a = agg.byDate.get(date) ?? emptyAgg();
        return {
          label:
            range === 'year'
              ? `${+date.slice(0, 4)}/${+date.slice(5, 7)}/${+date.slice(8, 10)}`
              : `${+date.slice(5, 7)}/${+date.slice(8, 10)}`,
          calls: a.calls,
          // 统一口径：input 按供应商语义含缓存读取，拆分为 缓存读取 + 新增输入
          //（柱总高 = input + output，与总卡一致；网关源缓存恒 0 时新增输入 = 输入）
          cache_read: a.cache_read,
          new_input: Math.max(0, a.input - a.cache_read),
          output: a.output,
        };
      }),
    [dateList, range, agg],
  );
  const chartEmpty = trend.every((d) => d.calls === 0 && segments.every((k) => !d[k]));
  const showDots = range === 'today' || range === '7d';

  // ---- 各模型消耗趋势（issue #160：日 × 模型折线，Top8 + 其他聚合）----
  // 网关源无按模型 token 明细，趋势口径 = 请求数（诚实声明）。恒为全模型，不随模型筛选联动。
  const modelTrend = useMemo(
    () => buildModelTrend(agg.modelByDate, dateList, range),
    [agg.modelByDate, dateList, range],
  );

  // ---- 会话总数（§3.3：范围内请求合计）----
  const sessions = useMemo(
    () => gwPoolsFor(gateway, scope).reduce((s, d) => s + d.total_requests, 0),
    [gateway, scope],
  );

  // ---- 年度热力图（全量历史，不受区间筛选影响）----
  const heatValues = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of gwPoolsFor(gateway, scope)) {
      m.set(d.date, (m.get(d.date) ?? 0) + d.prompt_tokens + d.completion_tokens);
    }
    return m;
  }, [gateway, scope]);

  // ---- 覆盖窗口标注（§8.1）----
  const coverage = '网关 90 天';

  // Token 分项用中性墨阶（缓存写/读 → 新输入 → 输出逐级加深），保持「单强调色」基调；
  // 「调用次数」虚线用强调色，避免再引入第四种色相。
  const stackColors: Record<string, string> = {
    cache_write: chart.stack.cache_write,
    cache_read: chart.stack.cache_read,
    new_input: chart.stack.new_input,
    input: chart.stack.new_input,
    output: chart.stack.output,
  };
  const tooltipStyle = chart.tooltip;
  const axisProps = axisPropsOf(chart);

  return (
    <div className="card p-5">
      <ChartFilterBar
        title="Token 统计"
        icon={<Activity size={16} className="text-indigo-500" />}
        badges={
          <>
            <Badge tone="slate">API 网关源</Badge>
            <Badge tone="amber" title="本地会话扫描与官网 token 字段两个口径已下线；网关转发实测为准，直连官方的流量不在统计内。">
              仅覆盖走网关流量
            </Badge>
            <Badge tone="slate">
              {scope === 'trae' ? 'Trae 池' : scope === 'buddy' ? 'Buddy 池' : 'Qoder 池'} · {gwPoolsFor(gateway, scope).length} 个日桶
            </Badge>
          </>
        }
        sessions={sessions}
        models={[...new Set(gwPoolsFor(gateway, scope).flatMap((d) => d.models.map((m) => m.name)))].sort()}
        modelFilter={modelFilter}
        onModelFilter={setModelFilter}
        range={range}
        onRange={setRange}
        extra={coverage ? <span className="hidden text-xs text-slate-400 lg:inline">{coverage}</span> : undefined}
      />

      {/* ① 总 Token 统计卡（4 卡；Trae 追加「账单口径缓存」对账卡 = 5 卡） */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label="总 Token"
          value={fmtTokens(totalTokens)}
          hint={`${agg.calls.toLocaleString()} 次请求`}
          tone="brand"
        />
        <StatCard
          label="输入 Token"
          value={fmtTokens(agg.input)}
          hint={agg.cache_read > 0 ? `其中缓存读取 ${fmtTokens(agg.cache_read)}` : undefined}
          tone="violet"
        />
        <StatCard label="输出 Token" value={fmtTokens(agg.output)} tone="green" />
        <StatCard
          label="缓存命中率"
          value={hitRate != null ? `${(hitRate * 100).toFixed(1)}%` : '—'}
          hint={
            // 数据驱动：有缓存测量即出命中率；确实无下发时如实提示（不伪造 0%）
            (hitRate != null ? '转发口径 · 缓存读取 / 输入总量' : '转发口径无缓存测量（上游未下发缓存字段）') +
            (agg.billingCacheRead.total > 0 ? ` · 账单口径 ${fmtTokens(agg.billingCacheRead.total)}` : '')
          }
          tone="amber"
        />
        {/* Trae 账单口径缓存对账卡（issue #169）：转发口径恒 0，官方账单
            cache_read 真实计费；独立卡片并列展示，不混入转发口径统计 */}
        {traeActive && (
          <StatCard
            label="账单口径缓存"
            value={fmtTokens(agg.billingCacheRead.total)}
            hint={
              agg.billingCacheRead.total > 0
                ? `Trae 官网计费 cache_read · ${agg.billingCacheRead.days} 天有缓存 · 命中率 ${billingHitRate != null ? `${(billingHitRate * 100).toFixed(1)}%` : '—'}`
                : '官网明细暂无缓存记录（点「刷新数据」拉取消耗明细）'
            }
            tone="violet"
          />
        )}
      </div>

      {/* ② Token 与调用趋势（双轴：堆叠柱 + 调用虚线） */}
      <div className="mt-5">
        <div className="mb-2 text-sm font-medium">Token 与调用趋势</div>
        {chartEmpty ? (
          <EmptyState
            icon={<Activity size={22} />}
            title="暂无趋势数据"
            hint="网关代理转发产生用量后展示（保留 90 天）；仅覆盖走网关流量，可在 API 服务页查看实时用量。"
          />
        ) : (
          <div className="h-64">
            <ResponsiveContainer>
              <ComposedChart data={trend} margin={{ top: 12, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} opacity={0.25} vertical={false} />
                <XAxis dataKey="label" {...axisProps} minTickGap={24} />
                <YAxis yAxisId="tokens" {...axisProps} axisLine={false} width={56} tickFormatter={(v: number) => fmtTokens(v)} />
                <YAxis yAxisId="calls" orientation="right" {...axisProps} axisLine={false} width={40} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number, name: string) => [
                    name === 'calls' ? String(v) : fmtTokens(v),
                    SEG_LABELS[name] ?? (name === 'calls' ? '调用次数' : name),
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {segments.map((k) => (
                  <Bar
                    key={k}
                    yAxisId="tokens"
                    dataKey={k}
                    stackId="t"
                    name={SEG_LABELS[k]}
                    fill={stackColors[k]}
                    maxBarSize={22}
                  />
                ))}
                <Line yAxisId="calls" type="monotone" dataKey="calls" name="调用次数" stroke={chart.accent} strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* ③ 各模型消耗趋势（issue #160：日 × 模型折线；网关无按模型 token 明细 → 请求数口径） */}
      <div className="mt-5 border-t border-slate-100 pt-4 dark:border-zinc-800">
        <div className="mb-2 flex items-center gap-2">
          <h4 className="text-sm font-medium">各模型消耗趋势</h4>
          {modelTrend.series.length > 0 && (
            <span className="text-xs text-slate-400">所选区间 · Top8 + 其他 · 口径 = 请求数</span>
          )}
          <Badge tone="amber">网关源无按模型 token 明细，口径 = 请求数</Badge>
        </div>
        {modelTrend.series.length === 0 ? (
          <EmptyState icon={<Activity size={22} />} title="暂无模型趋势数据" hint="该区间暂无网关请求记录。" />
        ) : (
          <ModelTrendChart
            rows={modelTrend.rows}
            series={modelTrend.series}
            showDots={showDots}
            fmtValue={(n: number) => n.toLocaleString('zh-CN')}
          />
        )}
      </div>

      {/* ④ 年度活动热力图 */}
      <div className="mt-5 border-t border-slate-100 pt-4 dark:border-zinc-800">
        <div className="mb-2">
          <h4 className="text-sm font-medium">年度活动热力图</h4>
        </div>
        <ActivityHeatmap
          values={heatValues}
          unit="tokens"
          fmtValue={fmtTokens}
          emptyHint="网关用量仅保留 90 天，热力图仅覆盖该窗口。"
        />
      </div>
    </div>
  );
}