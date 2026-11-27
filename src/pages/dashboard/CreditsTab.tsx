import { useEffect, useMemo, useState } from 'react';
import { Line, XAxis, YAxis, ComposedChart, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts';
import { Coins } from 'lucide-react';
import ChartFilterBar from '../../components/ChartFilterBar';
import ActivityHeatmap from '../../components/charts/ActivityHeatmap';
import ModelTrendChart from '../../components/charts/ModelTrendChart';
import { Badge, EmptyState, StatCard } from '../../components/ui';
import { useDateRange } from '../../hooks/useDateRange';
import { axisPropsOf, useChartTheme } from '../../lib/chartTheme';
import { fmtCredits } from '../../lib/format';
import type {
  CreditsDailySnapshot,
  QoderCheckinRecord,
  QoderCreditsSnapshot,
  QoderWebUsage,
  UsageHistoryResult,
  WbCheckinRecord,
  WbCreditsSnapshot,
  WbUsageOfficialAll,
} from '../../types';
import type { PlatformScope } from './KpiRow';
import {
  mergeEarned,
  qoderEarnedByDate,
  qoderEarnedByDateFiltered,
  qoderWebToPoints,
  traeEarnedByDate,
  traeEarnedByDateFiltered,
  traeUsageToPoints,
  wbCheckinEarnedByDate,
  wbEarnedByDateFiltered,
  wbOfficialAllToPoints,
  wbSnapshotEarnedByDate,
} from './adapters';
import { buildModelTrend } from './modelTrend';

/**
 * 积分统计 Tab（credits-dashboard-plan.md §3.1/§5.1）：
 * ① 总积分统计卡（区间总获得/区间总消耗/净获得）② 积分趋势图 ③ 各模型消耗趋势（issue #160）④ 年度活动热力图。
 * 消耗口径固定为官网源（不做源切换、不回退）：
 * Trae = usage_history（365 天，日×模型）；Buddy = usage_official（31 天，日合计；无按日模型明细，各模型趋势走空态）；
 * Qoder = Webview 同源 fetch 官网采集（31 天，日×模型；未采集时展示采集引导空态）。
 * 本地快照差分与 API 网关测量均不再作为消耗口径（与官网差异大，容易误导）。
 * 获得积分仍取各平台快照/签到日志（官网未提供获得明细）。
 */

export default function CreditsTab({
  scope,
  usage,
  creditsDaily,
  wbOfficial,
  wbSnapshots,
  wbCheckin,
  qoderSnapshots,
  qoderCheckin,
  qoderWeb,
  uidSet,
}: {
  scope: PlatformScope;
  /** Trae 官网消耗明细（usage_history_fetch） */
  usage: UsageHistoryResult | null;
  /** Trae 每日积分快照（获得积分口径） */
  creditsDaily: CreditsDailySnapshot[];
  /** Buddy 官网用量聚合（31 天） */
  wbOfficial: WbUsageOfficialAll | null;
  /** Buddy 积分快照时序（方案 B：earned 优先口径） */
  wbSnapshots: WbCreditsSnapshot[];
  /** Buddy 签到日志（90 天，方案 A 回退口径） */
  wbCheckin: WbCheckinRecord[];
  /** Qoder 积分快照时序（earned 获得口径） */
  qoderSnapshots: QoderCreditsSnapshot[];
  /** Qoder 签到日志（账号筛选时 earned 按 uid 过滤 reward；与全局快照 earned 同源） */
  qoderCheckin: QoderCheckinRecord[];
  /** Qoder 官网采集聚合（Webview 同源 fetch，31 天，日×模型；null = 未采集） */
  qoderWeb: QoderWebUsage | null;
  /** 分组∩账号筛选生效 uid 集（null = 不限；issue #82 问题4-1：获得积分 KPI 跟随筛选） */
  uidSet: Set<string> | null;
}) {
  const chart = useChartTheme();
  // 统计周期默认「今日」（用户习惯先看当日消耗；需要跨日再手动切 7/30 天）
  const { range, setRange, startStr, todayStr, dateList } = useDateRange('today');
  const [modelFilter, setModelFilter] = useState('');
  // 切平台时清空模型筛选：旧平台模型在新平台列表中不存在，残留会让趋势静默归零
  useEffect(() => setModelFilter(''), [scope]);

  const traeActive = scope === 'trae';
  const buddyActive = scope === 'buddy';
  const qoderActive = scope === 'qoder';
  // 本地自然日 ISO 字符串可直接比较；作为 memo 依赖以 startStr/todayStr 表达
  const inRange = (date: string) => date >= startStr && date <= todayStr;

  // ---- 官网源 → BoardPoint ----
  const traePoints = useMemo(() => (traeActive ? traeUsageToPoints(usage) : []), [traeActive, usage]);
  const buddyPoints = useMemo(
    () => (buddyActive ? wbOfficialAllToPoints(wbOfficial) : []),
    [buddyActive, wbOfficial],
  );
  // Qoder 消耗只认官网采集（官方原始接口）；未采集为空，不回退快照/网关
  const qoderPoints = useMemo(
    () => (qoderActive ? qoderWebToPoints(qoderWeb) : []),
    [qoderActive, qoderWeb],
  );

  // ---- 模型清单（日×模型粒度按累计降序；Buddy 无按日模型明细 → 空） ----
  const allModels = useMemo(() => {
    if (!traeActive && !qoderActive) return [];
    const totals = new Map<string, number>();
    for (const p of traeActive ? traePoints : qoderPoints) {
      for (const [model, m] of Object.entries(p.models)) {
        totals.set(model, (totals.get(model) ?? 0) + (m.credits ?? 0));
      }
    }
    return [...totals.entries()].sort((x, y) => y[1] - x[1]).map(([m]) => m);
  }, [traeActive, qoderActive, traePoints, qoderPoints]);

  // ---- 范围 × 模型 × 平台 聚合 ----
  const agg = useMemo(() => {
    const consumeByDate = new Map<string, number>();
    const earnedByDate = new Map<string, number>();
    let sessions = 0;
    // Trae 账号筛选时，老快照行无 accounts 明细被跳过的天数（KPI hint 如实标注）
    let earnedSkippedDates = 0;
    const addConsume = (date: string, v: number) => {
      consumeByDate.set(date, (consumeByDate.get(date) ?? 0) + v);
    };
    // 各模型消耗趋势（issue #160）：模型 → 日期 → 数值（仅日×模型粒度可用的源累积）
    const modelByDate = new Map<string, Map<string, number>>();
    const addModelDay = (date: string, model: string, v: number) => {
      let m = modelByDate.get(model);
      if (!m) {
        m = new Map();
        modelByDate.set(model, m);
      }
      m.set(date, (m.get(date) ?? 0) + v);
    };
    const addEarned = (date: string, v: number) => {
      earnedByDate.set(date, (earnedByDate.get(date) ?? 0) + v);
    };

    // Trae 官网源：日 × 模型粒度（模型筛选仅作用于消耗合计线）
    if (traeActive) {
      for (const p of traePoints) {
        if (!inRange(p.date)) continue;
        sessions += p.calls ?? 0;
        addConsume(p.date, modelFilter ? (p.models[modelFilter]?.credits ?? 0) : (p.credits ?? 0));
        for (const [model, m] of Object.entries(p.models)) {
          addModelDay(p.date, model, m.credits ?? 0);
        }
      }
      // issue #82 问题4-1：uidSet 非空时按账号维度取值（Trae 快照 accounts 明细）
      if (uidSet) {
        const r = traeEarnedByDateFiltered(creditsDaily, uidSet);
        earnedSkippedDates = r.skippedDates;
        for (const [d, v] of r.byDate) {
          if (inRange(d)) addEarned(d, v);
        }
      } else {
        for (const [d, v] of traeEarnedByDate(creditsDaily)) {
          if (inRange(d)) addEarned(d, v);
        }
      }
    }

    // Buddy 官网源：仅日合计（31 天零填充）；模型筛选时不计入消耗合计，保持口径诚实
    if (buddyActive) {
      if (!modelFilter) {
        for (const p of buddyPoints) {
          if (!inRange(p.date)) continue;
          addConsume(p.date, p.credits ?? 0);
        }
      }
      // Buddy 获得（方案 B 快照 earned 优先，缺失日回退方案 A 签到）
      const earned = uidSet
        ? wbEarnedByDateFiltered(wbSnapshots, wbCheckin, uidSet)
        : mergeEarned(wbCheckinEarnedByDate(wbCheckin), wbSnapshotEarnedByDate(wbSnapshots));
      for (const [d, v] of earned) {
        if (inRange(d)) addEarned(d, v);
      }
    }

    // Qoder 官网采集源：日 × 模型粒度（模型筛选仅作用于消耗合计线）
    if (qoderActive) {
      for (const p of qoderPoints) {
        if (!inRange(p.date)) continue;
        addConsume(p.date, modelFilter ? (p.models[modelFilter]?.credits ?? 0) : (p.credits ?? 0));
        for (const [model, m] of Object.entries(p.models)) {
          addModelDay(p.date, model, m.credits ?? 0);
        }
      }
      // Qoder 获得（快照 earned = 当日签到奖励合计；与 KPI 今日新增同源）
      const earned = uidSet ? qoderEarnedByDateFiltered(qoderCheckin, uidSet) : qoderEarnedByDate(qoderSnapshots);
      for (const [d, v] of earned) {
        if (inRange(d)) addEarned(d, v);
      }
    }

    let consumed = 0;
    for (const v of consumeByDate.values()) consumed += v;
    let earned = 0;
    for (const v of earnedByDate.values()) earned += v;
    return { consumeByDate, earnedByDate, modelByDate, consumed, earned, sessions, earnedSkippedDates };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    traeActive, buddyActive, qoderActive, traePoints, buddyPoints, qoderPoints, modelFilter,
    creditsDaily, wbCheckin, wbSnapshots, qoderSnapshots, qoderCheckin, uidSet, startStr, todayStr,
  ]);

  // ---- 趋势数据（消耗柱 + 获得线）----
  const trend = useMemo(
    () =>
      dateList.map((date) => ({
        label:
          range === 'year'
            ? `${+date.slice(0, 4)}/${+date.slice(5, 7)}/${+date.slice(8, 10)}`
            : `${+date.slice(5, 7)}/${+date.slice(8, 10)}`,
        consumed: agg.consumeByDate.get(date) ?? null,
        earned: agg.earnedByDate.get(date) ?? null,
      })),
    [dateList, range, agg],
  );
  const hasTrend = trend.some((d) => d.consumed != null || d.earned != null);
  const showDots = range === 'today' || range === '7d';

  // ---- 各模型消耗趋势（issue #160：日 × 模型折线，Top8 + 其他聚合）----
  // 仅日×模型粒度可用的官网源渲染（Trae / Qoder 采集）；Buddy 官网仅 31 天全窗口汇总 → 诚实空态。
  // 恒为全模型，不随模型筛选联动。
  const hasModelDaily = traeActive || qoderActive;
  const modelTrend = useMemo(
    () => buildModelTrend(agg.modelByDate, dateList, range),
    [agg.modelByDate, dateList, range],
  );

  // ---- 年度热力图（全量历史，不受区间/模型筛选影响；按平台维度过滤）----
  const heatValues = useMemo(() => {
    const m = new Map<string, number>();
    const pts = [
      ...(traeActive ? traePoints : []),
      ...(buddyActive ? buddyPoints : []),
      ...(qoderActive ? qoderPoints : []),
    ];
    for (const p of pts) m.set(p.date, (m.get(p.date) ?? 0) + (p.credits ?? 0));
    return m;
  }, [traeActive, buddyActive, qoderActive, traePoints, buddyPoints, qoderPoints]);

  // ---- 覆盖窗口标注（§8.1）----
  const coverage = useMemo(() => {
    const parts: string[] = [];
    if (traeActive) parts.push('Trae 365 天');
    if (buddyActive) parts.push('Buddy 31 天');
    if (qoderActive) parts.push('Qoder 官网采集 31 天');
    return parts.length > 0 ? `覆盖窗口：${parts.join(' · ')} · 官网源` : '';
  }, [traeActive, buddyActive, qoderActive]);

  // Qoder 未采集过官网用量：整块统计无口径可言，展示采集引导空态（不回退快照/网关）
  const qoderNotCollected = qoderActive && !qoderWeb;

  const axisProps = axisPropsOf(chart);

  return (
    <div className="card p-5">
      <ChartFilterBar
        title="积分统计"
        icon={<Coins size={16} className="text-violet-500" />}
        badges={
          <>
            <Badge tone="slate">官网源</Badge>
            <Badge
              tone="amber"
              title="本地快照差分与 API 网关测量与官网差异大，已不作为消耗口径；官网源失效时如实留空，不回退。"
            >
              不回退本地/网关
            </Badge>
            {wbOfficial?.stale && buddyActive && (
              <Badge tone="amber" title={wbOfficial.stale_reason || '本次拉取失败，展示历史缓存数据'}>
                Buddy 官网缓存过期
              </Badge>
            )}
            {qoderActive && qoderWeb && (
              <Badge
                tone="green"
                title="Qoder 官网采集（Webview 同源 fetch，实际扣费 credits，免费模型为 0）；仅覆盖已采集账号。"
              >
                口径 = 官网采集
              </Badge>
            )}
          </>
        }
        sessions={traeActive ? agg.sessions : null}
        models={allModels}
        modelFilter={modelFilter}
        onModelFilter={setModelFilter}
        range={range}
        onRange={setRange}
        extra={
          usage && traeActive ? (
            <span
              className="hidden text-xs text-slate-400 lg:inline"
              title="Trae 消耗明细最近更新时间（接口口径）"
            >
              明细更新于 {new Date(usage.fetched_at * 1000).toLocaleString('zh-CN', { hour12: false })}
            </span>
          ) : undefined
        }
      />

      {qoderNotCollected ? (
        <EmptyState
          icon={<Coins size={22} />}
          title="尚未采集 Qoder 官网用量"
          hint="点击右上角「官网采集」并按账号登录，采集完成后展示近 31 天官网消耗明细；本地快照与网关测量不再作为消耗口径。"
        />
      ) : (
        <>
          {/* ① 统计卡：区间总获得 / 区间总消耗 / 净获得 */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <StatCard
              label="区间总获得"
              value={fmtCredits(agg.earned)}
              hint={[
                traeActive ? 'Trae 积分包归日' : null,
                buddyActive ? 'Buddy 快照 earned（缺失日回退签到口径）' : null,
                qoderActive ? 'Qoder 快照 earned（签到合计）' : null,
                // issue #82 问题4-1：分组/账号筛选生效时按账号维度取值并标注口径
                uidSet
                  ? `已按 ${uidSet.size} 个账号筛选` +
                    (traeActive && agg.earnedSkippedDates > 0
                      ? `（${agg.earnedSkippedDates} 天历史快照无账号明细，未计入）`
                      : '')
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              tone="green"
            />
            <StatCard
              label="区间总消耗"
              value={fmtCredits(agg.consumed)}
              hint={`官网源${modelFilter ? ` · ${modelFilter}` : ''}${traeActive ? ` · 会话 ${agg.sessions.toLocaleString()}` : ''}`}
              tone="amber"
            />
            <StatCard
              label="净获得"
              value={fmtCredits(agg.earned - agg.consumed)}
              hint="获得 − 消耗"
              tone={agg.earned - agg.consumed >= 0 ? 'green' : 'red'}
            />
          </div>

          {/* ② 积分趋势图（消耗柱 + 获得线） */}
          <div className="mt-5">
            <div className="mb-2 flex items-center gap-3">
              <h4 className="text-sm font-medium">积分趋势图</h4>
              <div className="flex items-center gap-3 text-[12px] text-slate-500 dark:text-zinc-400">
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: chart.accent }}
                  />
                  消耗积分
                  {modelFilter ? `（${modelFilter}）` : ''}
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: chart.accentSoft }}
                  />
                  获得积分
                </span>
              </div>
            </div>
            {!hasTrend ? (
              <EmptyState
                icon={<Coins size={22} />}
                title="暂无趋势数据"
                hint={
                  buddyActive
                    ? '官网用量暂无记录：点击右上角「刷新数据」拉取；Buddy 官网源仅覆盖近 31 天。'
                    : qoderActive
                      ? '官网采集暂无消耗记录：重新执行「官网采集」后展示近 31 天明细。'
                      : '点击右上角「刷新数据」拉取官网消耗明细。'
                }
              />
            ) : (
              <div className="h-56">
                <ResponsiveContainer>
                  <ComposedChart data={trend} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} opacity={0.25} vertical={false} />
                    <XAxis dataKey="label" {...axisProps} minTickGap={24} />
                    <YAxis {...axisProps} axisLine={false} width={56} />
                    <Tooltip
                      cursor={{ stroke: chart.cursor, strokeWidth: 1, strokeDasharray: '3 3' }}
                      contentStyle={chart.tooltip}
                      formatter={(v: number, name: string) => [fmtCredits(v), name]}
                    />
                    <Line
                      type="monotone"
                      dataKey="consumed"
                      name="消耗积分"
                      stroke={chart.accent}
                      strokeWidth={2}
                      dot={showDots ? { r: 3, fill: chart.accent, strokeWidth: 0 } : false}
                      activeDot={{ r: 5 }}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="earned"
                      name="获得积分"
                      stroke={chart.accentSoft}
                      strokeWidth={2}
                      dot={showDots ? { r: 3, fill: chart.accentSoft, strokeWidth: 0 } : false}
                      activeDot={{ r: 5 }}
                      connectNulls
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* ③ 各模型消耗趋势（issue #160：日 × 模型折线，Top8 + 其他聚合；
              Buddy 官网仅 31 天全窗口汇总 → 诚实空态） */}
          <div className="mt-5 border-t border-slate-100 pt-4 dark:border-zinc-800">
            <div className="mb-2 flex items-center gap-2">
              <h4 className="text-sm font-medium">各模型消耗趋势</h4>
              {hasModelDaily && modelTrend.series.length > 0 && (
                <span className="text-xs text-slate-400">所选区间 · Top8 + 其他 · 口径 = 积分</span>
              )}
            </div>
            {!hasModelDaily ? (
              <EmptyState
                icon={<Coins size={22} />}
                title="该数据源无按日模型明细"
                hint="Buddy 官网仅提供 31 天全窗口模型汇总（无按日明细），无法绘制各模型消耗趋势。"
              />
            ) : modelTrend.series.length === 0 ? (
              <EmptyState
                icon={<Coins size={22} />}
                title="暂无模型趋势数据"
                hint="该区间暂无官网模型粒度消耗记录。"
              />
            ) : (
              <ModelTrendChart rows={modelTrend.rows} series={modelTrend.series} showDots={showDots} fmtValue={fmtCredits} />
            )}
          </div>

          {/* ④ 年度活动热力图 */}
          <div className="mt-5 border-t border-slate-100 pt-4 dark:border-zinc-800">
            <div className="mb-2 flex items-center gap-2">
              <h4 className="text-sm font-medium">年度活动热力图</h4>
              {coverage && <span className="text-xs text-slate-400">{coverage}</span>}
            </div>
            <ActivityHeatmap
              values={heatValues}
              unit="积分"
              fmtValue={fmtCredits}
              emptyHint="暂无官网消耗记录：点击右上角「刷新数据」拉取后展示。"
            />
          </div>
        </>
      )}
    </div>
  );
}