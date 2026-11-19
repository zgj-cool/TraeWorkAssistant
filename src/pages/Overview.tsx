import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Clock3, RefreshCw } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { Badge, Spinner, StatCard } from '../components/ui';
import { api } from '../lib/tauri';
import { fmtCredits } from '../lib/format';
import { withMinDelay } from '../lib/delay';
import { useAppStore } from '../store';
import type {
  AppKey,
  QoderCreditsResult,
  UsageHistoryResult,
  ViewKey,
  WbCreditsResult,
  WbUsageOfficialAll,
} from '../types';
import { buildOverview, type OverviewData } from './overview/overviewModel';
import { AlertRow, PlatformCard, PLATFORMS } from './overview/OverviewCards';

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
  const allAlerts = useMemo(() => view?.platforms.flatMap((p) => p.alerts) ?? [], [view]);
  const expiringGroups = useMemo(
    () => (view?.platforms ?? []).filter((p) => p.expiringDetails.length > 0),
    [view],
  );
  const expiringAccounts = expiringGroups.reduce((n, p) => n + p.expiringDetails.length, 0);

  const refresh = () => {
    void withMinDelay(load(true, true), 600).then((errors) =>
      pushToast(errors.length ? 'warn' : 'success', errors.length ? '部分数据源加载失败，已保留其余平台数据' : '已刷新'),
    );
  };

  const go = (app: AppKey, target: ViewKey) => openPlatformView(app, target);
  const goPlatform = (key: keyof typeof PLATFORMS, target: ViewKey) => go(PLATFORMS[key].app, target);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="全平台总览"
        desc="Trae · Buddy · Qoder 账号与积分一屏掌握 · 点击指标直达对应明细"
        actions={
          <div className="flex items-center gap-2">
            {updatedAt && <span className="text-xs text-slate-400">更新于 {new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>}
            {refreshing && <Badge tone="blue"><Spinner className="mr-1 h-3 w-3" /> 积分后台刷新中</Badge>}
            {data?.wbOfficial?.stale && <Badge tone="amber" title={data.wbOfficial.stale_reason}>Buddy 官网用量过期缓存</Badge>}
            {failed.length > 0 && <Badge tone="amber" title={failed.join('、')}>{failed.length} 项数据源未加载</Badge>}
            <button onClick={refresh} className="btn-outline" disabled={loading}>
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> 刷新
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="账号总数" value={kpis?.accounts ?? '—'} hint="三平台账号池合计" tone="brand" />
        <StatCard label="可用总积分" value={kpis?.available != null ? fmtCredits(kpis.available) : '—'} hint="Trae + Buddy + Qoder 账号余额合计" tone="amber" />
        <StatCard label="今日已用积分" value={kpis?.usedToday != null ? fmtCredits(kpis.usedToday) : '—'} hint="Trae / Buddy / Qoder 官网口径，失败回退快照" tone="cyan" />
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
          ? view.platforms.map((p) => <PlatformCard key={p.key} summary={p} onGo={(target) => goPlatform(p.key, target)} />)
          : [0, 1, 2].map((i) => <div key={i} className="card h-80 animate-pulse bg-slate-200/40 dark:bg-zinc-900" />)}
      </div>

      <div className="mt-5 card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <Clock3 size={16} className="text-amber-500" />
            <h3 className="font-medium">凭证告警清单</h3>
            <Badge tone={allAlerts.length ? 'red' : 'green'}>{allAlerts.length} 项</Badge>
          </div>
          <span className="text-xs text-slate-400">仅凭证临期 / 需重登，点击行直达账号页</span>
        </div>
        {allAlerts.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-slate-400">暂无凭证告警，各平台登录状态正常。</div>
        ) : (
          <div className="max-h-72 divide-y divide-slate-50 overflow-auto p-1 dark:divide-zinc-900">
            {allAlerts.map((a) => <AlertRow key={a.id} alert={a} onGo={go} />)}
          </div>
        )}
      </div>

      <div className="mt-5 card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <CalendarClock size={16} className="text-amber-500" />
            <h3 className="font-medium">积分到期明细</h3>
            <Badge tone={expiringAccounts ? 'amber' : 'green'}>{expiringAccounts} 个账号</Badge>
          </div>
          <span className="text-xs text-slate-400">按平台汇总 7 日内到期积分 · 点击行查看包明细</span>
        </div>
        {expiringGroups.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-slate-400">7 日内没有即将到期的积分。</div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-zinc-800">
            {expiringGroups.map((p) => (
              <div key={p.key}>
                <div className="flex items-center justify-between gap-3 bg-slate-50/80 px-4 py-2 dark:bg-zinc-900/60">
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    {PLATFORMS[p.key].label}
                    <span className="text-xs font-normal text-slate-400">{p.expiringDetails.length} 个账号</span>
                  </span>
                  <span className="text-base font-bold tabular-nums text-amber-600 dark:text-amber-400">
                    7 日内到期 {p.expiringIn7d == null ? '—' : fmtCredits(p.expiringIn7d)} 积分
                  </span>
                </div>
                <div className="divide-y divide-slate-50 dark:divide-zinc-900">
                  {p.expiringDetails.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => go(PLATFORMS[p.key].app, d.view)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left transition hover:bg-slate-50 dark:hover:bg-zinc-800/70"
                    >
                      <span className="min-w-0 truncate text-sm text-slate-700 dark:text-zinc-200">
                        {d.name || d.user_id}
                        <span className="ml-2 text-xs text-slate-400">{d.reason}</span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                        {d.credits == null ? '金额未刷新' : `${fmtCredits(d.credits)} 积分`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        统计口径：Trae 今日已用取官网消耗明细（usage_history_fetch，缓存命中时标注）；Buddy 取官网用量聚合（workbuddy_usage_official_all），官网不可用时回退本地快照；Qoder 自动读取客户端登录会话后拉取官网消耗明细（按 begin_at 聚合名义消耗），会话不可用回退本地积分快照差分。刷新仅重载缓存/本地数据，强制上游积分刷新请进入对应平台积分看板。
      </p>
    </div>
  );
}
