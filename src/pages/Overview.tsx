import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { Badge, Spinner, StatCard } from '../components/ui';
import { api } from '../lib/tauri';
import { fmtCredits, fmtTokens } from '../lib/format';
import { withMinDelay } from '../lib/delay';
import { useAppStore, type BoardNavIntent } from '../store';
import type {
  QoderCreditsResult,
  UsageDayView,
  UsageHistoryResult,
  ViewKey,
  WbCreditsResult,
  WbUsageOfficialAll,
} from '../types';
import { buildOverview, type OverviewData } from './overview/overviewModel';
import { PlatformCard, PLATFORMS } from './overview/OverviewCards';

type Data = Omit<OverviewData, 'nowMs'>;

export default function Overview() {
  const openPlatformView = useAppStore((s) => s.openPlatformView);
  const pushToast = useAppStore((s) => s.pushToast);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const swrRetries = useRef(0);
  const loadingRef = useRef(false);

  const load = useCallback(async (resetSwr = false, freshOfficial = false): Promise<string[]> => {
    if (loadingRef.current) return [];
    loadingRef.current = true;
    if (resetSwr) swrRetries.current = 0;
    setLoading(true);
    const errors: string[] = [];
    const take = <T,>(promise: Promise<T>, fallback: T, label: string): Promise<T> =>
      promise.catch(() => {
        errors.push(label);
        return fallback;
      });
    try {
      const [
        traeUsage,
        wbAccounts, wbCredits, wbCheckin, wbOfficial, wbUsage,
        qoderAccounts, qoderCredits, qoderWebUsage, qoderCheckin, qoderHistory,
        gwTrae, gwBuddy, gwBuddyAi, gwCustom, gwQoder,
      ] = await Promise.all([
        take(api.accounts.usageHistory(freshOfficial), null as UsageHistoryResult | null, 'Trae 官网消耗明细'),
        take(api.workbuddy.accountsList(), [], 'Buddy 账号'),
        take(api.workbuddy.creditsFetch(undefined, false), null as WbCreditsResult | null, 'Buddy 积分'),
        take(api.workbuddy.checkinResults(1), [], 'Buddy 签到记录'),
        take(api.workbuddy.usageOfficialAll(), null as WbUsageOfficialAll | null, 'Buddy 官网用量'),
        take(api.workbuddy.usageFallback(), null, 'Buddy 本地用量回退'),
        take(api.qoder.accountsList(), [], 'Qoder 账号'),
        take(api.qoder.creditsFetch(undefined, false), null as QoderCreditsResult | null, 'Qoder 积分'),
        take(api.qoder.webUsageToday(), null, 'Qoder 官网消耗明细'),
        take(api.qoder.checkinResults(1), [], 'Qoder 签到记录'),
        take(api.qoder.creditsHistoryList(), { snapshots: [] }, 'Qoder 积分快照'),
        take(api.apiServer.usageStats(1), null as UsageDayView[] | null, '网关 Trae 用量'),
        take(api.apiServer.wbUsageStats(1), null as UsageDayView[] | null, '网关 Buddy 用量'),
        take(api.apiServer.buddyAiUsageStats(1), null as UsageDayView[] | null, '网关 BuddyAI 用量'),
        take(api.apiServer.customUsageStats(1), null as UsageDayView[] | null, '网关自定义用量'),
        take(api.apiServer.qoderUsageStats(1), null as UsageDayView[] | null, '网关 Qoder 用量'),
      ]);
      setData({
        traeAccounts: useAppStore.getState().accounts,
        traeUsage,
        wbAccounts,
        wbCredits,
        wbCheckin,
        wbOfficial,
        wbUsage,
        qoderAccounts,
        qoderCredits,
        qoderWebUsage,
        qoderCheckin,
        qoderSnapshots: qoderHistory.snapshots,
        gwUsage: {
          trae: gwTrae,
          buddy: gwBuddy,
          'buddy-ai': gwBuddyAi,
          custom: gwCustom,
          qoder: gwQoder,
        },
      });
      setFailed(errors);
      setUpdatedAt(Date.now());
      return errors;
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const refreshing = !!data?.wbCredits?.refreshing;
  useEffect(() => {
    if (!refreshing || swrRetries.current >= 2) return;
    const timer = window.setTimeout(() => {
      swrRetries.current += 1;
      void load();
    }, 1500 * (swrRetries.current + 1));
    return () => window.clearTimeout(timer);
  }, [refreshing, load]);

  const view = useMemo(() => (data ? buildOverview({ ...data, nowMs: Date.now() }) : null), [data]);
  const kpis = view?.kpis;

  const refresh = () => {
    void withMinDelay(load(true, true), 600).then((errors) =>
      pushToast(errors.length ? 'warn' : 'success', errors.length ? '部分数据源加载失败，已保留其余平台数据' : '已刷新'),
    );
  };

  const goPlatform = (key: keyof typeof PLATFORMS, target: ViewKey, nav?: BoardNavIntent) =>
    openPlatformView(PLATFORMS[key].app, target, nav);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="全平台总览"
        desc="Trae · Buddy · Qoder 账号与积分一屏掌握 · 网关 Token 消耗分账号可见 · 点击指标直达对应明细"
        actions={
          <div className="flex items-center gap-2">
            {updatedAt && <span className="text-[12px] text-slate-400 dark:text-zinc-500">更新于 {new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>}
            {refreshing && <Badge tone="blue"><Spinner className="mr-1 h-3 w-3" /> 积分后台刷新中</Badge>}
            {data?.wbOfficial?.stale && <Badge tone="amber" title={data.wbOfficial.stale_reason}>Buddy 官网用量过期缓存</Badge>}
            {failed.length > 0 && <Badge tone="amber" title={failed.join('、')}>{failed.length} 项数据源未加载</Badge>}
            <button onClick={refresh} className="btn-outline" disabled={loading}>
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> 刷新
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="账号总数" value={kpis?.accounts ?? '—'} hint="三平台账号池合计" tone="brand" />
        <StatCard label="可用总积分" value={kpis?.available != null ? fmtCredits(kpis.available) : '—'} hint="Trae + Buddy + Qoder 账号余额合计" tone="amber" />
        <StatCard
          label="今日已用积分"
          value={kpis?.usedToday != null ? fmtCredits(kpis.usedToday) : '—'}
          hint="官网口径，失败回退快照"
          tone="cyan"
        />
        <StatCard
          label="今日 Token 消耗"
          value={view?.tokens.total != null ? fmtTokens(view.tokens.total) : '—'}
          hint={
            view?.tokens.prompt != null
              ? `输入 ${fmtTokens(view.tokens.prompt)} / 输出 ${fmtTokens(view.tokens.completion ?? 0)}`
              : 'API 网关三平台池暂无数据'
          }
          tone="violet"
        />
        <StatCard label="7 天内到期积分" value={kpis?.expiringIn7d != null ? fmtCredits(kpis.expiringIn7d) : '—'} hint="仅统计剩余 > 0 的积分包" tone={(kpis?.expiringIn7d ?? 0) > 0 ? 'amber' : 'slate'} />
        <StatCard
          label="账号告警"
          value={kpis?.alerts ?? '—'}
          hint="仅统计凭证临期 / 需重新登录"
          tone={(kpis?.alerts ?? 0) > 0 ? 'red' : 'green'}
        />
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {view
          ? view.platforms.map((p) => (
              <PlatformCard
                key={p.key}
                summary={p}
                creditRows={view.credits.rows.filter((r) => r.platform === p.key)}
                poolTokens={view.tokens.byPlatform[p.key]}
                onGo={(target, nav) => goPlatform(p.key, target, nav)}
              />
            ))
          : [0, 1, 2].map((i) => (
              <div
                key={i}
                className="card h-80 animate-pulse bg-slate-100/60 dark:bg-zinc-900/40"
              />
            ))}
      </div>

      <p className="mt-5 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">
        统计口径：Trae 今日已用取官网消耗明细（usage_history_fetch，缓存命中时标注）；Buddy 取官网用量聚合（workbuddy_usage_official_all），官网不可用时回退本地快照；Qoder 自动读取客户端登录会话后拉取官网消耗明细（按 begin_at 聚合名义消耗），会话不可用回退本地积分快照差分。Token 消耗取 API 网关按落日用量（Trae / Buddy / Qoder 三池，按账号归入对应平台卡片，与官网积分口径独立；BuddyAI / 自定义池见 API 管理页用量统计）。刷新仅重载缓存/本地数据，强制上游积分刷新请进入对应平台积分看板。
      </p>
    </div>
  );
}
