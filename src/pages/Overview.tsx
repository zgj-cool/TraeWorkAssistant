import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { Badge, Spinner, StatCard } from '../components/ui';
import { api } from '../lib/tauri';
import { syncQoderWebAccounts } from '../lib/qoderWebSync';
import { fmtCredits, fmtTokens } from '../lib/format';
import { withMinDelay } from '../lib/delay';
import { useAppStore, type BoardNavIntent } from '../store';
import type {
  QoderCreditsResult,
  QoderWebUsage,
  UsageDayView,
  UsageHistoryResult,
  ViewKey,
  WbCreditsResult,
  WbUsageOfficialAll,
} from '../types';
import { buildOverview, type OverviewData } from './overview/overviewModel';
import { PlatformCard, PLATFORMS } from './overview/OverviewCards';

type Data = Omit<OverviewData, 'nowMs'>;
/** 局部刷新可单独覆盖的 Qoder 字段（采集完成 → 只重拉这几项并合并） */
type QoderPatch = Partial<
  Pick<Data, 'qoderAccounts' | 'qoderCredits' | 'qoderWeb' | 'qoderCheckin' | 'qoderSnapshots'>
>;

export default function Overview() {
  const openPlatformView = useAppStore((s) => s.openPlatformView);
  const pushToast = useAppStore((s) => s.pushToast);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  // Qoder 官网采集单独计时：与全量拉取并发，按钮不必等采集跑完
  const [qoderSyncing, setQoderSyncing] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const swrRetries = useRef(0);
  const loadingRef = useRef(false);
  const qoderSyncingRef = useRef(false);
  const qoderPatch = useRef<{ at: number; patch: QoderPatch } | null>(null);

  const load = useCallback(async (resetSwr = false, freshOfficial = false): Promise<string[]> => {
    if (loadingRef.current) return [];
    loadingRef.current = true;
    // 发起时刻：期间落地的 Qoder 局部刷新比本次读到的缓存新时才允许覆盖
    const startedAt = Date.now();
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
        qoderAccounts, qoderCredits, qoderWebCollect, qoderCheckin, qoderHistory,
        gwTrae, gwBuddy, gwBuddyAi, gwCustom, gwQoder,
      ] = await Promise.all([
        take(api.accounts.usageHistory(freshOfficial), null as UsageHistoryResult | null, 'Trae 官网消耗明细'),
        take(api.workbuddy.accountsList(), [], 'Buddy 账号'),
        take(api.workbuddy.creditsFetch(undefined, false), null as WbCreditsResult | null, 'Buddy 积分'),
        take(api.workbuddy.checkinResults(1), [], 'Buddy 签到记录'),
        take(api.workbuddy.usageOfficialAll(freshOfficial), null as WbUsageOfficialAll | null, 'Buddy 官网用量'),
        take(api.workbuddy.usageFallback(), null, 'Buddy 本地用量回退'),
        take(api.qoder.accountsList(), [], 'Qoder 账号'),
        take(api.qoder.creditsFetch(undefined, false), null as QoderCreditsResult | null, 'Qoder 积分'),
        // 旧官网会话 cookie 通道已废弃（依赖客户端 cookie 库，实测不可用），
        // 改由「官网采集（Webview 同源 fetch）」提供的 qoderWeb 数据源
        take(api.qoder.webUsageGet(), null as QoderWebUsage | null, 'Qoder 官网采集'),
        take(api.qoder.checkinResults(1), [], 'Qoder 签到记录'),
        take(api.qoder.creditsHistoryList(), { snapshots: [] }, 'Qoder 积分快照'),
        take(api.apiServer.usageStats(1), null as UsageDayView[] | null, '网关 Trae 用量'),
        take(api.apiServer.wbUsageStats(1), null as UsageDayView[] | null, '网关 Buddy 用量'),
        take(api.apiServer.buddyAiUsageStats(1), null as UsageDayView[] | null, '网关 BuddyAI 用量'),
        take(api.apiServer.customUsageStats(1), null as UsageDayView[] | null, '网关自定义用量'),
        take(api.apiServer.qoderUsageStats(1), null as UsageDayView[] | null, '网关 Qoder 用量'),
      ]);
      const next: Data = {
        traeAccounts: useAppStore.getState().accounts,
        traeUsage,
        wbAccounts,
        wbCredits,
        wbCheckin,
        wbOfficial,
        wbUsage,
        qoderAccounts,
        qoderCredits,
        qoderWebUsage: null, // 旧 cookie 通道已废弃（页面不再调用，避免无效日志）
        qoderWeb: qoderWebCollect,
        qoderCheckin,
        qoderSnapshots: qoderHistory.snapshots,
        gwUsage: {
          trae: gwTrae,
          buddy: gwBuddy,
          'buddy-ai': gwBuddyAi,
          custom: gwCustom,
          qoder: gwQoder,
        },
      };
      // 本次全量拉取期间落地的 Qoder 局部刷新优先覆盖：
      // 全量 load 的 Qoder 各项在读缓存时，官网采集可能尚未落盘。
      const pending = qoderPatch.current;
      qoderPatch.current = null;
      setData(pending && pending.at > startedAt ? { ...next, ...pending.patch } : next);
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

  // 已用积分 SWR 补取（同 Dashboard）：后端过期缓存先回旧值并转后台全量刷新
  //（refreshing=true）；全量拉取 20-53s，间隔 10s/20s/30s 递增，命中新缓存即停。
  // stale-on-error（刷新失败回退）不轮询，避免死循环。
  const officialRefreshing = !!data?.wbOfficial?.refreshing;
  const officialRetries = useRef(0);
  useEffect(() => {
    if (!officialRefreshing) {
      officialRetries.current = 0;
      return;
    }
    if (officialRetries.current >= 3) {
      // 轮询用尽仍未拿到新值：本地清掉 refreshing，避免顶部徽标常驻假象
      setData((d) =>
        d?.wbOfficial?.refreshing ? { ...d, wbOfficial: { ...d.wbOfficial, refreshing: false } } : d,
      );
      return;
    }
    const timer = window.setTimeout(() => {
      officialRetries.current += 1;
      void load();
    }, 10_000 * (officialRetries.current + 1));
    return () => window.clearTimeout(timer);
  }, [officialRefreshing, load]);

  const view = useMemo(() => (data ? buildOverview({ ...data, nowMs: Date.now() }) : null), [data]);
  const kpis = view?.kpis;

  // Qoder 采集完成后的局部刷新：只重拉 Qoder 五项并合并进当前快照。
  // 不重跑全量 load，避免二次强制拉取 Trae/Buddy 官网用量（全量聚合 20-53s）。
  const reloadQoder = useCallback(async () => {
    const [accounts, credits, web, checkin, history] = await Promise.all([
      api.qoder.accountsList().catch(() => null),
      api.qoder.creditsFetch(undefined, false).catch(() => null),
      api.qoder.webUsageGet().catch(() => null),
      api.qoder.checkinResults(1).catch(() => null),
      api.qoder.creditsHistoryList().catch(() => null),
    ]);
    const patch: QoderPatch = {};
    if (accounts) patch.qoderAccounts = accounts;
    if (credits) patch.qoderCredits = credits;
    if (web) patch.qoderWeb = web;
    if (checkin) patch.qoderCheckin = checkin;
    if (history) patch.qoderSnapshots = history.snapshots;
    if (Object.keys(patch).length === 0) return;
    const at = Date.now();
    // 页面数据尚未就绪时先存下，由 load 完成时合并
    qoderPatch.current = { at, patch };
    setData((d) => (d ? { ...d, ...patch } : d));
  }, []);

  const refresh = () => {
    // Qoder 官网采集（逐账号串行、后端采集窗口互斥）与其余平台全量拉取互不依赖：
    // 并发启动，避免「先等 Qoder 采完再刷其他平台」把两段耗时串成加法。
    const qoderTask = (async () => {
      if (qoderSyncingRef.current) return;
      // 页面数据未就绪时向本地缓存取一次，避免首次加载完前点刷新不相步。
      const current = data?.qoderWeb ?? (await api.qoder.webUsageGet().catch(() => null));
      const collected = current?.accounts ?? [];
      if (collected.length === 0) return;
      qoderSyncingRef.current = true;
      setQoderSyncing(true);
      pushToast('info', `正在后台同步 Qoder 官网用量（${collected.length} 个账号）…`);
      try {
        const r = await syncQoderWebAccounts(collected);
        if (r.ok > 0) {
          pushToast('success', `Qoder 官网用量已同步 ${r.ok}/${r.total} 个账号`);
        }
        if (r.failed.length > 0) {
          pushToast(
            'warn',
            `${r.failed.length} 个账号同步失败（登录态可能已过期），请到 Qoder 积分看板重新采集`,
          );
        }
        await reloadQoder();
      } finally {
        qoderSyncingRef.current = false;
        setQoderSyncing(false);
      }
    })();
    void qoderTask.catch((err) => {
      pushToast('warn', `Qoder 官网同步失败：${String(err)}`);
    });

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
            {qoderSyncing && <Badge tone="blue"><Spinner className="mr-1 h-3 w-3" /> Qoder 官网同步中</Badge>}
            {officialRefreshing && <Badge tone="blue"><Spinner className="mr-1 h-3 w-3" /> 已用积分后台刷新中</Badge>}
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
        统计口径：Trae 今日已用取官网消耗明细（usage_history_fetch，缓存命中时标注）；Buddy 取官网用量聚合（workbuddy_usage_official_all），官网不可用时回退本地快照；Qoder 优先取官网采集（Webview 同源 fetch，每个账号独立登录、按账号归档并做 uid 校验），不可用时依次回退 API 网关 Qoder 池实测积分、官网会话消耗明细与本地积分快照差分。Token 消耗取 API 网关按落日用量（Trae / Buddy / Qoder 三池，按账号归入对应平台卡片；BuddyAI / 自定义池见 API 管理页用量统计）。刷新会强制重拉 Trae/Buddy 官网用量（跳过 10min 缓存，全量聚合需数十秒），并与 Qoder 官网采集（已采集账号逐账号静默重采）并发执行，互不阻塞；Qoder 官网采集首次需在积分看板点「官网采集」并登录。
      </p>
    </div>
  );
}
