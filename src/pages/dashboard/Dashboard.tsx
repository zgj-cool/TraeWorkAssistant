import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Globe, RefreshCw } from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import { Badge, SegmentedTabs, Spinner } from '../../components/ui';
import { MultiSelectDropdown } from '../../components/MultiSelectDropdown';
import { api } from '../../lib/tauri';
import { useAppStore, type BoardTab } from '../../store';
import { withMinDelay } from '../../lib/delay';
import { fmtCredits, dateStrToEndTs } from '../../lib/format';
import KpiRow, { type PlatformKpi, type PlatformScope } from './KpiRow';
// D2/D3（审查修复清单 v1.4.9）：KPI「今日新增」按账号筛选推导
import { aggregateQoderWebAccounts, qoderEarnedByDateFiltered, traeEarnedByDateFiltered, wbEarnedByDateFiltered } from './adapters';
import { syncQoderWebAccounts } from '../../lib/qoderWebSync';
import ExpiryTab from './ExpiryTab';
import CreditsTab from './CreditsTab';
import QoderWebCollectDialog from './QoderWebCollectDialog';
import TokensTab, { type GatewayDays } from './TokensTab';
import SessionsTab from './SessionsTab';
import type {
  AccountView,
  GroupView,
  QoderCheckinRecord,
  QoderCreditsResult,
  QoderCreditsSnapshot,
  QoderWebUsage,
  TraeExpiredEntsResult,
  UsageDayView,
  UsageHistoryResult,
  WbCheckinRecord,
  WbCreditsResult,
  WbCreditsSnapshot,
  WbUsageOfficialAll,
} from '../../types';

/** 多选下拉已抽至 components/MultiSelectDropdown.tsx（豆包额度看板复用） */

/**
 * 积分看板（credits-dashboard-plan.md；平台拆分调整）：
 * 同一套看板组件按 platform 参数分别渲染 Trae / Buddy / Qoder 三个独立页面——
 * Trae 页挂在 `credits` 视图，Buddy 页挂在 `buddy-credits` 视图，
 * Qoder 页挂在 `qoder-credits` 视图（替换旧 pages/qoder/QoderCredits.tsx），互不混装。
 * 布局：PageHeader（标题+概述）→ KPI 7 卡 → Tab 工具行（Tab 切换 + 刷新）→ Tab 内容。
 */

const TABS: { key: BoardTab; label: string }[] = [
  { key: 'credits', label: '积分统计' },
  { key: 'tokens', label: 'Token 统计' },
  { key: 'expiry', label: '积分到期' },
  { key: 'sessions', label: '会话明细' },
];

/** 页面标题/概述（三页同一结构：积分余额 · 积分明细 · Token 统计 · 到期日历 · 会话明细） */
const PAGE_META: Record<'trae' | 'buddy' | 'qoder', { title: string; desc: string }> = {
  trae: { title: 'Trae · 积分看板', desc: '积分余额 · 积分明细 · Token 统计 · 到期日历 · 会话明细' },
  buddy: { title: 'Buddy · 积分看板', desc: '积分余额 · 积分明细 · Token 统计 · 到期日历 · 会话明细' },
  qoder: { title: 'Qoder · 积分看板', desc: '积分余额 · 积分明细 · Token 统计 · 到期日历 · 会话明细' },
};

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function CreditsDashboard({ platform }: { platform: 'trae' | 'buddy' | 'qoder' }) {
  const pushToast = useAppStore((s) => s.pushToast);
  const consumePendingBoardNav = useAppStore((s) => s.consumePendingBoardNav);
  const accounts = useAppStore((s) => s.accounts);
  const creditsDaily = useAppStore((s) => s.creditsDaily);
  const creditsHistory = useAppStore((s) => s.creditsHistory);
  const refreshRemainingCredits = useAppStore((s) => s.refreshRemainingCredits);
  const refreshCreditsDaily = useAppStore((s) => s.refreshCreditsDaily);
  const refreshCreditsHistory = useAppStore((s) => s.refreshCreditsHistory);

  const isTrae = platform === 'trae';
  const isQoder = platform === 'qoder';

  const [tab, setTab] = useState<BoardTab>('credits');
  const [loading, setLoading] = useState(false);

  // Trae 侧数据（官网源消耗明细 + store 快照/签到历史；Buddy/Qoder 页不加载）
  const [usage, setUsage] = useState<UsageHistoryResult | null>(null);
  // Trae 逐包到期（issue #82 T5.1：expired_ents 实时查询，含已过期包——credit_packs 缓存只含未过期可用包）
  const [expiredEnts, setExpiredEnts] = useState<TraeExpiredEntsResult | null>(null);
  // Buddy 侧数据（Trae/Qoder 页不加载）
  const [wbCredits, setWbCredits] = useState<WbCreditsResult | null>(null);
  // 签到日志取 90 天窗口：KPI 今日新增 + 积分统计 Tab「区间总获得」共用
  const [wbCheckin, setWbCheckin] = useState<WbCheckinRecord[]>([]);
  const [wbOfficial, setWbOfficial] = useState<WbUsageOfficialAll | null>(null);
  // 快照时序（§2.2 方案 B：earned 已落库；null 日期回退方案 A 签到聚合）
  const [wbSnapshots, setWbSnapshots] = useState<WbCreditsSnapshot[]>([]);
  // Qoder 侧数据（官网积分查询 + 本地快照时序 + 签到日志今日新增回退口径；其他页不加载）
  const [qoderCredits, setQoderCredits] = useState<QoderCreditsResult | null>(null);
  const [qoderSnapshots, setQoderSnapshots] = useState<QoderCreditsSnapshot[]>([]);
  const [qoderCheckin, setQoderCheckin] = useState<QoderCheckinRecord[]>([]);
  // Qoder 官网采集聚合（Webview 同源 fetch；null = 未采集过）；collectingId = 正在采集的账号
  const [qoderWeb, setQoderWeb] = useState<QoderWebUsage | null>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [collectOpen, setCollectOpen] = useState(false);
  // 静默刷新桥：refresh 定义在采集逻辑之前，经 ref 调用最新实现
  const syncOfficialRef = useRef<() => Promise<number>>(async () => 0);
  // 数据源口径已统一收敛：积分统计固定官网源（本地快照/网关与官网差异大）；
  // Token 统计固定 API 网关（本地会话扫描 / 官网 token 两个口径已下线）

  // 总览页直达指定 Tab（如 Token 消耗 → Token 统计）：
  // 挂载时一次性消费，避免下次进入看板仍停留在上次跳转的 Tab
  useEffect(() => {
    const nav = consumePendingBoardNav();
    if (!nav) return;
    setTab(nav.tab);
  }, [consumePendingBoardNav]);
  // 会话明细 Tab 联动刷新键（refresh 完成后 +1 触发重查缓存，issue #82）
  const [sessionsRefreshKey, setSessionsRefreshKey] = useState(0);

  // ---- 顶部分组/账号筛选（P1 需求②）：平台视图内全局生效（KPI/积分/到期/Token 联动）----
  // 分组下拉数据源 = 本池 groups_list().GroupView{id,name,uids}（共享分组生效后自动
  // 包含其他应用创建的分组）；账号候选随分组筛选联动。筛选状态内存态（P1 不做持久化）。
  const [poolGroups, setPoolGroups] = useState<GroupView[]>([]);
  const [groupFilter, setGroupFilter] = useState<string[]>([]);
  const [accountFilter, setAccountFilter] = useState<string[]>([]);
  // 分组成员可能在他处（账号页/其他池）变更，下拉打开时重拉（失败保留旧值）
  const reloadPoolGroups = useCallback(() => {
    const loader =
      platform === 'trae'
        ? api.groups.list()
        : platform === 'buddy'
          ? api.workbuddy.groups.list()
          : api.qoder.groups.list();
    loader.then(setPoolGroups).catch(() => {});
  }, [platform]);
  useEffect(() => {
    reloadPoolGroups();
    // 平台切换时重置筛选（三实例共享组件，状态按平台语义独立）
    setGroupFilter([]);
    setAccountFilter([]);
  }, [platform, reloadPoolGroups]);
  // 生效 uid 集 = 组筛选成员集 ∩ 账号筛选集（均空 = 不限，null）
  const visibleUids = useMemo<Set<string> | null>(() => {
    let set: Set<string> | null = null;
    if (groupFilter.length > 0) {
      set = new Set();
      for (const g of poolGroups) {
        if (groupFilter.includes(g.id)) g.uids.forEach((u) => set!.add(u));
      }
    }
    if (accountFilter.length > 0) {
      const f = new Set(accountFilter);
      set = set ? new Set([...set].filter((u) => f.has(u))) : f;
    }
    return set;
  }, [poolGroups, groupFilter, accountFilter]);
  // 有筛选时可见账号 uid 集合（空集 = 筛选结果为空，各面板如实展示零数据）
  const filterByUid = useCallback(
    <T extends { user_id: string }>(arr: T[]): T[] =>
      visibleUids ? arr.filter((x) => visibleUids.has(x.user_id)) : arr,
    [visibleUids],
  );
  const visibleAccounts = useMemo<AccountView[]>(() => filterByUid(accounts), [accounts, filterByUid]);
  const visibleWbCredits = useMemo<WbCreditsResult | null>(
    () => (wbCredits ? { ...wbCredits, accounts: filterByUid(wbCredits.accounts) } : wbCredits),
    [wbCredits, filterByUid],
  );
  const visibleQoderCredits = useMemo<QoderCreditsResult | null>(
    () => (qoderCredits ? { ...qoderCredits, accounts: filterByUid(qoderCredits.accounts) } : qoderCredits),
    [qoderCredits, filterByUid],
  );
  // 消耗明细/Token 明细的账号级过滤（按明细携带的 user_id 过滤；无 uid 维度的
  // 数据源不静默截断，工具行显示「不支持账号级筛选」徽标）
  const visibleUsage = useMemo<UsageHistoryResult | null>(
    () => (usage ? { ...usage, accounts: filterByUid(usage.accounts) } : usage),
    [usage, filterByUid],
  );
  // 分组筛选生效 uid 集（仅分组，不含账号筛选；issue #82 问题4-2）
  const groupUids = useMemo<Set<string> | null>(() => {
    if (groupFilter.length === 0) return null;
    const set = new Set<string>();
    for (const g of poolGroups) {
      if (groupFilter.includes(g.id)) g.uids.forEach((u) => set.add(u));
    }
    return set;
  }, [poolGroups, groupFilter]);
  // 账号多选候选（随分组筛选联动：勾选分组后仅列组内账号）。
  // 审查修复（issue #82 问题4-2）：候选集必须只随分组收窄，不能取已按 accountFilter
  // 过滤后的 visible* 集合——否则勾选任一账号后其余候选立即从下拉消失，多选无法叠加。
  const accountCandidates = useMemo<{ id: string; name: string }[]>(() => {
    const base =
      platform === 'trae'
        ? accounts.map((a) => ({ id: a.user_id, name: a.name }))
        : platform === 'buddy'
          ? (wbCredits?.accounts ?? []).map((a) => ({ id: a.user_id, name: a.name }))
          : (qoderCredits?.accounts ?? []).map((a) => ({ id: a.user_id, name: a.name }));
    return base.filter((a) => a.id && (!groupUids || groupUids.has(a.id)));
  }, [platform, accounts, wbCredits, qoderCredits, groupUids]);
  // 会话明细账号下拉按平台切换（Trae=vault 账号；Buddy/Qoder=积分接口账号清单；
  // Qoder 数据源=网关请求级本地流水，issue #82 问题5）。
  // 跟随顶部分组/账号筛选（shared-groups-tags 合并集成：平台视图内全局生效契约）。
  const sessionAccountOptions = useMemo(
    () =>
      platform === 'buddy'
        ? filterByUid(wbCredits?.accounts ?? []).map((a) => ({ user_id: a.user_id, name: a.name }))
        : platform === 'qoder'
          ? filterByUid(qoderCredits?.accounts ?? []).map((a) => ({ user_id: a.user_id, name: a.name }))
          : filterByUid(accounts).map((a) => ({ user_id: a.user_id, name: a.name })),
    [platform, wbCredits, qoderCredits, accounts, filterByUid],
  );
  const filtersActive = groupFilter.length > 0 || accountFilter.length > 0;
  // 官网采集按当前账号筛选重算（无筛选 = 全池已采集汇总；筛选后无已采集账号 = null → 空态，不回退其他源）
  const qoderWebScoped = useMemo(
    () => aggregateQoderWebAccounts(qoderWeb, visibleUids),
    [qoderWeb, visibleUids],
  );
  const qoderCollected = useMemo(() => {
    const m = new Map<string, NonNullable<QoderWebUsage['accounts']>[number]>();
    for (const a of qoderWeb?.accounts ?? []) m.set(a.account_id, a);
    return m;
  }, [qoderWeb]);

  // Token 统计 Tab 数据（API 网关 90 天用量；懒加载：首次切到 Token Tab 才拉取，§3.4）
  const [gateway, setGateway] = useState<GatewayDays | null>(null);
  // 网关数据仅 Token 统计 Tab 需要（积分统计固定官网源）
  const gatewayLoadedRef = useRef(false);

  const loadUsage = useCallback(
    // 返回是否成功，供 refresh 判定是否弹「看板数据已刷新」（失败已有专属 error toast）
    async (fresh: boolean): Promise<boolean> => {
      try {
        setUsage(await api.accounts.usageHistory(fresh));
        return true;
      } catch (err) {
        pushToast('error', `Trae 消耗明细查询失败：${String(err)}`);
        return false;
      }
    },
    [pushToast],
  );

  // Trae 逐包到期（issue #82 T5.1）：expired_ents 实时轻请求；失败保留旧数据展示 + toast
  // （stale-on-error 惯例，不置 null 清空既有到期条目）
  const loadExpiredEnts = useCallback(async (): Promise<boolean> => {
    try {
      setExpiredEnts(await api.accounts.traeExpiredEnts());
      return true;
    } catch (err) {
      pushToast('error', `Trae 逐包到期查询失败：${String(err)}`);
      return false;
    }
  }, [pushToast]);

  const loadBuddy = useCallback(
    // 返回 credits 主链路是否真实成功（辅助源 allSettled 优雅回退不计失败），
    // 供 refresh 决定是否弹「看板数据已刷新」，避免失败提示与成功提示并存
    async (fresh: boolean): Promise<boolean> => {
      let ok = true;
      await Promise.allSettled([
        api.workbuddy
          .creditsFetch(undefined, fresh)
          .then((r) => {
            setWbCredits(r);
            if (fresh && r.stale) {
              ok = false;
              pushToast('warn', 'Buddy 积分刷新失败，已回退展示历史缓存数据');
            }
          })
          .catch((err) => {
            ok = false;
            pushToast('error', `Buddy 积分查询失败：${String(err)}`);
          }),
        // 今日新增（§2.2 方案 A）+ 积分统计「区间总获得」：签到日志 reward 聚合（90 天）
        api.workbuddy
          .checkinResults(90)
          .then(setWbCheckin)
          .catch(() => setWbCheckin([])),
        // 官网用量聚合（31 天零填充；今日消耗 + 积分统计官网源）。
        // fresh=true（「刷新数据」）强制上游拉取：此前本命令恒 force=false，已用积分
        // 要等 10min 缓存过期 + 后台 SWR 完成后再刷一次才变，用户感知为「延迟几分钟才同步」
        api.workbuddy
          .usageOfficialAll(fresh)
          .then(setWbOfficial)
          .catch(() => setWbOfficial(null)),
        // 快照时序（方案 B：Buddy 获得积分优先口径；失败回退签到聚合）
        api.workbuddy
          .creditsHistoryList()
          .then((r) => setWbSnapshots(r.snapshots ?? []))
          .catch(() => setWbSnapshots([])),
      ]);
      return ok;
    },
    [pushToast],
  );

  // ---- Qoder 页数据装载 ----
  // 先查积分（后端全量查询且全部成功时落当日快照，同日覆盖），完成后再读快照时序，
  // 保证「今日快照」在首次装载即可见；签到日志 2 天窗口仅作今日新增的回退口径
  const loadQoder = useCallback(
    // 返回 credits 主链路是否真实成功（辅助源 allSettled 优雅回退不计失败），同 loadBuddy
    async (fresh: boolean): Promise<boolean> => {
      let ok = true;
      await api.qoder
        .creditsFetch(undefined, fresh)
        .then((r) => {
          setQoderCredits(r);
          if (fresh && r.stale) {
            ok = false;
            pushToast('warn', 'Qoder 积分刷新失败，已回退展示历史缓存数据');
          }
        })
        .catch((err) => {
          ok = false;
          pushToast('error', `Qoder 积分查询失败：${String(err)}`);
        });
      await Promise.allSettled([
        api.qoder
          .creditsHistoryList()
          .then((r) => setQoderSnapshots(r.snapshots ?? []))
          .catch(() => setQoderSnapshots([])),
        // D1（审查修复清单 v1.4.9）：窗口 2 天 → 90 天，与 Buddy 签到日志同口径
        //（KPI 今日新增 + 积分统计「区间总获得」共用，窗口过短统计少计）
        api.qoder
          .checkinResults(90)
          .then(setQoderCheckin)
          .catch(() => setQoderCheckin([])),
        // 官网采集聚合（Webview 同源 fetch 落地；纯读本地缓存零网络，未采集过为 null）
        api.qoder
          .webUsageGet()
          .then(setQoderWeb)
          .catch(() => {}),
      ]);
      return ok;
    },
    [pushToast],
  );

  // ---- Token 统计 Tab 数据源：API 网关（SQLite 直查，90 天保留窗口）----
  const loadGateway = useCallback(async (): Promise<boolean> => {
    // 看板按单平台展示，拉取 Trae/Buddy/Qoder 三池（custom 池仅 API 服务页 UsageStatsPanel 使用）。
    // 三个统计命令为 Tauri 直读盘（API 服务未运行也可查），失败仅来自读盘/序列化异常——
    // 用 allSettled 区分「真实失败」与「正常零数据」，避免零用量/新装用户每次刷新误报
    const results = await Promise.allSettled([
      api.apiServer.usageStats(90),
      api.apiServer.wbUsageStats(90),
      api.apiServer.qoderUsageStats(90),
    ]);
    const empty: UsageDayView[] = [];
    const trae = results[0].status === 'fulfilled' ? results[0].value : empty;
    const buddy = results[1].status === 'fulfilled' ? results[1].value : empty;
    const qoder = results[2].status === 'fulfilled' ? results[2].value : empty;
    setGateway({ trae, buddy, qoder });
    // 仅存在真实查询失败时明示，不静默显示为「无数据」；正常空数据（零用量/
    // Qoder 上游未接入）不提示
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      pushToast('warn', `网关用量查询失败（${failed}/3 个数据源异常），对应来源将显示为空`);
      return false;
    }
    return true;
  }, [pushToast]);

  // 懒加载（§3.4）：网关用量在 Token Tab 首次激活时拉取（SQLite 直查，轻）
  useEffect(() => {
    if (tab === 'tokens' && !gatewayLoadedRef.current) {
      gatewayLoadedRef.current = true;
      void loadGateway();
    }
  }, [tab, loadGateway]);

  const refresh = useCallback(
    async (fresh = false, silent = false) => {
      // silent：调度器联动（board-data-synced）静默重读缓存——不置全局 loading、
      // 不强制最短展示时长，避免看板每次同步后闪烁并瞬时禁用刷新按钮
      if (!silent) setLoading(true);
      // 汇总各真实数据源装载结果（失败方均已弹专属 toast），供末尾判定是否弹成功提示——
      // 避免「已刷新」与失败提示并存造成语义矛盾
      let ok = true;
      const work = async (): Promise<boolean> => {
        // Qoder 官网静默同步（仅「刷新数据」触发；调度器静默同步不触发）：
        // 已保存登录态的账号用隐藏窗口重采，无需用户重新登录
        if (isQoder && fresh && (qoderWeb?.accounts?.length ?? 0) > 0) {
          pushToast('info', `正在后台同步官网用量（${qoderWeb?.accounts?.length ?? 0} 个账号）…`);
          await syncOfficialRef.current();
        }
        // Trae fresh 时先串行刷新剩余积分：后端逐账号网络查询并落盘 credits_daily.json 快照
        // （旧页即串行保证此顺序），完成后再并行读取；否则日快照竞速先返回旧值，今日 KPI 滞后
        if (isTrae && fresh) ok = (await refreshRemainingCredits()) && ok;
        await Promise.all([
          // 按平台只加载本侧数据源
          isTrae ? refreshCreditsDaily() : Promise.resolve(),
          isTrae ? refreshCreditsHistory().then((v) => void (ok = ok && v)) : Promise.resolve(),
          isTrae ? loadUsage(fresh).then((v) => void (ok = ok && v)) : Promise.resolve(),
          // 逐包到期实时查询（issue #82 T5.1）：仅「刷新数据」联动重拉；
          // 进入页面由独立 effect 拉取、调度器静默同步不触发（避免后台静默网络请求）
          isTrae && fresh ? loadExpiredEnts().then((v) => void (ok = ok && v)) : Promise.resolve(),
          (isTrae || isQoder
            ? Promise.resolve()
            : loadBuddy(fresh).then((v) => void (ok = ok && v))),
          isQoder ? loadQoder(fresh).then((v) => void (ok = ok && v)) : Promise.resolve(),
          // 已加载过的 Token 网关数据随全局刷新联动（SQLite 直查）
          gatewayLoadedRef.current && fresh
            ? loadGateway().then((v) => void (ok = ok && v))
            : Promise.resolve(),
        ]);
        // 会话明细 Tab 纯读缓存：随看板刷新联动重查（含调度器静默同步）
        setSessionsRefreshKey((k) => k + 1);
        return ok;
      };
      // Buddy 页「刷新数据」会强制重拉官网用量（全量 7 账号×31 天分页，20-53s），
      // 先给预期提示，避免用户误以为卡住（issue #188 感知同类）
      if (fresh && !silent && platform === 'buddy') {
        pushToast('info', '已用积分正从官网重拉（全量聚合需数十秒）…');
      }
      try {
        const allOk = silent ? await work() : await withMinDelay(work(), 600);
        if (fresh && allOk) {
          pushToast('success', '看板数据已刷新');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [isTrae, isQoder, platform, qoderWeb, refreshRemainingCredits, refreshCreditsDaily, refreshCreditsHistory, loadUsage, loadExpiredEnts, loadBuddy, loadQoder, loadGateway, pushToast],
  );

  // refresh 引用最新闭包（依赖链深，listen effect 只随 platform 注册一次，
  // 经 ref 调用避免重注册，也保证读到最新 store 状态）
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    void refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trae 逐包到期（issue #82 T5.1）：进入页面实时查询一次；「刷新数据」经 refresh(fresh=true)
  // 联动重拉，调度器静默同步不触发（实时轻请求，避免后台静默网络请求）
  useEffect(() => {
    if (isTrae) void loadExpiredEnts();
  }, [isTrae, loadExpiredEnts]);

  // 已用积分 SWR 补取：后端缓存过期时先回旧值并转后台全量刷新（refreshing=true），
  // 这里延迟重取——单轮全量拉取（7 账号×31 天分页）20-53s，间隔 10s/20s/30s 递增覆盖慢网络；
  // 命中新缓存（refreshing 消失）即停。stale-on-error（刷新失败回退）不轮询，避免死循环。
  const officialPollRef = useRef(0);
  useEffect(() => {
    if (!wbOfficial?.refreshing) {
      officialPollRef.current = 0;
      return;
    }
    if (officialPollRef.current >= 3) {
      // 轮询用尽仍未拿到新值（后台轮可能被 300s 节流挡掉）：本地清掉 refreshing，
      // 避免顶部徽标常驻假象；下次手动刷新/重进页面仍会重新判定
      setWbOfficial((v) => (v?.refreshing ? { ...v, refreshing: false } : v));
      return;
    }
    const timer = window.setTimeout(() => {
      officialPollRef.current += 1;
      api.workbuddy
        .usageOfficialAll()
        .then(setWbOfficial)
        .catch(() => {});
    }, 10_000 * (officialPollRef.current + 1));
    return () => window.clearTimeout(timer);
  }, [wbOfficial]);

  // 调度器看板数据同步成功后联动重读缓存（issue #61：页面常驻时数据不再滞后）；
  // payload.platform 与本视图平台匹配才刷新，静默走 refresh(false, true)（纯读缓存、零网络、无 loading 闪烁）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<{ platform: string }>('board-data-synced', (e) => {
      if (e.payload.platform === platform) void refreshRef.current(false, true);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [platform]);

  // Qoder 官网采集（Webview 同源 fetch）：按账号独立数据目录登录，结果按账号归档
  const startCollect = useCallback(
    async (accountId: string) => {
      setCollectingId(accountId);
      setCollectOpen(false);
      try {
        await api.qoder.webCollect(accountId, false);
        pushToast('info', '已打开采集窗口：请登录该账号（独立目录），登录后自动获取并关闭');
      } catch (err) {
        pushToast('error', `官网采集启动失败：${String(err)}`);
      } finally {
        setCollectingId(null);
      }
    },
    [pushToast],
  );
  // 已采集账号逐个静默刷新（与总览页共用 lib/qoderWebSync，登录态已持久化无需重登）
  const syncOfficial = useCallback(async (): Promise<number> => {
    const collected = qoderWeb?.accounts ?? [];
    if (!isQoder || collected.length === 0) return 0;
    setCollectingId(collected[0].account_id);
    try {
      const r = await syncQoderWebAccounts(collected);
      if (r.ok > 0) {
        pushToast('success', `官网用量已同步 ${r.ok}/${r.total} 个账号`);
      }
      if (r.failed.length > 0) {
        pushToast(
          'warn',
          `${r.failed.length} 个账号同步失败，请点「官网采集」重新登录：${r.failed.map((f) => f.name).join('、')}`,
        );
      }
      return r.ok;
    } finally {
      setCollectingId(null);
    }
  }, [isQoder, qoderWeb, pushToast]);
  useEffect(() => {
    syncOfficialRef.current = syncOfficial;
  }, [syncOfficial]);
  // 入口：已筛选单账号/池内仅一个账号时直采，否则弹账号选择
  const openCollect = useCallback(() => {
    const pool = qoderCredits?.accounts ?? [];
    if (pool.length === 0) {
      pushToast('warn', 'Qoder 池暂无账号，请先在账号管理导入');
      return;
    }
    if (accountFilter.length === 1) {
      void startCollect(accountFilter[0]);
      return;
    }
    if (pool.length === 1) {
      void startCollect(pool[0].user_id);
      return;
    }
    setCollectOpen(true);
  }, [qoderCredits, accountFilter, startCollect, pushToast]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<{ ok: boolean; silent?: boolean; account_id?: string; account_name?: string; records_total?: number; message?: string }>(
      'qoder-web-collect-done',
      (e) => {
        setCollectingId(null);
        // 静默刷新由 syncOfficial 汇总提示，避免逐账号刷屏
        if (!e.payload.silent) {
          if (e.payload.ok) {
            const who = e.payload.account_name ? `账号「${e.payload.account_name}」` : 'Qoder';
            pushToast('success', `${who}官网用量已采集（${e.payload.records_total ?? 0} 条）`);
          } else {
            pushToast('warn', e.payload.message ?? 'Qoder 官网采集未完成');
          }
        }
        // 无论成败都重读聚合（失败时保留旧桶，仅刷新视图）
        api.qoder.webUsageGet().then(setQoderWeb).catch(() => {});
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [pushToast]);

  const today = localDate(new Date());

  // Trae 筛选态「今日新增」按账号明细推导结果（skippedDates = 老快照行缺 accounts
  // 明细被跳过的日数，仅历史迁移前行会命中，今日恒有明细）。提升为独立 memo 供
  // KPI 数值与 earnedHint 口径标注共用，避免为取标注重复推导
  const traeFilteredEarned = useMemo(
    () => (visibleUids ? traeEarnedByDateFiltered(creditsDaily, visibleUids) : null),
    [creditsDaily, visibleUids],
  );

  // ---- Trae KPI（口径对齐原积分看板）----
  const traeKpi = useMemo<PlatformKpi>(() => {
    const nowSec = Date.now() / 1000;
    const horizon = nowSec + 7 * 86400;
    let totalCredits = 0;
    let packages = 0;
    let expiring = 0;
    for (const a of visibleAccounts) {
      totalCredits += a.remaining_credits ?? 0;
      // 积分包总数 + 7 天内到期：有包明细 → 包级口径（逐包过滤 + 累计，
      // 与 Buddy buddyKpi 循环同构）；无明细（老缓存）→ 回退账号级汇总（原实现）
      if (a.credit_packs != null) {
        for (const p of a.credit_packs ?? []) {
          // 包计数与到期日历对齐：remaining > 0 才计（已用完不计，Buddy 同款口径）
          if (p.remaining <= 0) continue;
          packages += 1;
          // 长期有效哨兵（2100-01-01）远大于 horizon 自然排除；下限 now 排除已过期包
          if (p.expire_time > nowSec && p.expire_time <= horizon) {
            expiring += p.remaining;
          }
        }
      } else if (a.credits_expire_at != null) {
        packages += 1;
        if (a.credits_expire_at > nowSec && a.credits_expire_at <= horizon) {
          expiring += a.remaining_credits ?? 0;
        }
      }
      if (a.membership_expire != null) packages += 1;
    }
    // 今日新增（D2）：有筛选时改走按账号明细推导（traeFilteredEarned，skippedDates
    // 口径标注见 earnedHint），与其他 KPI「筛选作用于数值」口径一致；无筛选维持
    // 快照 earned 优先（积分包 CycleStartTime 归日口径）回退签到 history delta。
    const snap = creditsDaily.find((s) => s.date === today);
    const todayEarned = traeFilteredEarned
      ? (traeFilteredEarned.byDate.get(today) ?? 0)
      : (() => {
          const histDelta = creditsHistory
            .filter((r) => r.date === today)
            .reduce((s, r) => s + (r.delta || 0), 0);
          return snap && snap.earned > 0 ? snap.earned : Math.max(0, histDelta);
        })();
    // 今日消耗：只取官网接口明细（credits_float 实际口径），按当前筛选口径取数
    // （visibleUsage），与「筛选作用于 KPI」语义一致；
    // 官网明细缺失时返回 null（KPI 显示「—」），不回退本地快照
    const todayConsumed =
      visibleUsage == null
        ? null
        : visibleUsage.accounts.reduce(
            (s, a) => s + (a.daily.find((d) => d.date === today)?.credits ?? 0),
            0,
          );
    return {
      accounts: visibleAccounts.length,
      totalCredits,
      packages,
      todayEarned,
      todayConsumed,
      expiring7d: expiring,
    };
  }, [visibleAccounts, creditsDaily, creditsHistory, visibleUsage, traeFilteredEarned, today]);

  // Trae「可用积分总数」卡细分（对齐原积分看板 totalHint）；账号无通用/Work 字段时回退通用文案
  const traeTotalHint = useMemo(() => {
    if (!isTrae) return undefined;
    if (!visibleAccounts.some((a) => a.general_credits != null || a.work_credits != null)) {
      return '总剩余可用积分';
    }
    const generalTotal = visibleAccounts.reduce((s, a) => s + (a.general_credits ?? 0), 0);
    const workTotal = visibleAccounts.reduce((s, a) => s + (a.work_credits ?? 0), 0);
    return `通用 ${fmtCredits(generalTotal)} 积分 · Work ${fmtCredits(workTotal)} 积分`;
  }, [isTrae, visibleAccounts]);

  // ---- Buddy KPI（§2.1/§2.2）----
  const buddyKpi = useMemo<PlatformKpi>(() => {
    const nowSec = Date.now() / 1000;
    const horizon = nowSec + 7 * 86400;
    const accs = visibleWbCredits?.accounts ?? [];
    let totalCredits = 0;
    let packages = 0;
    let expiring = 0;
    for (const a of accs) {
      totalCredits += a.balance ?? 0;
      for (const p of a.packages ?? []) {
        // 包计数与到期日历对齐：remaining > 0 才计
        if (p.remaining <= 0) continue;
        packages += 1;
        if (p.expire_ts != null && p.expire_ts > nowSec && p.expire_ts <= horizon) {
          expiring += p.remaining;
        }
      }
    }
    // 今日新增（D3）：有筛选时改走按账号推导（wbEarnedByDateFiltered，快照全局
    // earned 无账号维度不可拆 → 前端逐账号差分），无筛选维持原口径
    const todayEarned = visibleUids
      ? (wbEarnedByDateFiltered(wbSnapshots, wbCheckin, visibleUids).get(today) ?? 0)
      : (() => {
          const snapEarned = wbSnapshots.find((s) => s.date === today)?.earned;
          const checkinEarned = wbCheckin
            .filter((r) => r.date === today)
            .reduce((s, r) => s + (r.reward ?? 0), 0);
          return snapEarned != null ? Math.max(0, snapEarned) : checkinEarned;
        })();
    // 今日消耗：只取官网用量（31 天窗口）；缺失显示「—」，不回退本地快照
    const todayConsumed = wbOfficial?.summary.usage_today ?? null;
    return {
      accounts: accs.length,
      totalCredits,
      packages,
      todayEarned,
      todayConsumed,
      expiring7d: expiring,
    };
  }, [visibleWbCredits, wbCheckin, wbSnapshots, wbOfficial, visibleUids, today]);

  // ---- Qoder KPI（官网采集消耗 + 快照/签到获得）----
  const qoderKpi = useMemo<PlatformKpi>(() => {
    const nowSec = Date.now() / 1000;
    const horizon = nowSec + 7 * 86400;
    const accs = visibleQoderCredits?.accounts ?? [];
    let totalCredits = 0;
    let packages = 0;
    let expiring = 0;
    for (const a of accs) {
      totalCredits += a.total ?? 0;
      // 包明细已含 plan 订阅配额包（R-11 逐包口径）→ 独立 Plan 条目不重复计入；
      // 判定与到期日历同款（some 不过滤 amount）：plan 包已用完也视为「明细已含」
      const hasPlanPkg = (a.packages ?? []).some((p) => p.source === 'plan');
      for (const p of a.packages ?? []) {
        // 包计数与到期日历对齐：剩余未知或 > 0 计入，已用完不计
        if (p.amount != null && p.amount <= 0) continue;
        packages += 1;
        const endTs = dateStrToEndTs(p.expire_at);
        if (endTs != null && endTs > nowSec && endTs <= horizon) expiring += p.amount ?? 0;
      }
      // 7 天内到期含 Plan 订阅重置额度：订阅周期在窗口内到期，plan 剩余全额计入
      if (!hasPlanPkg) {
        const planEnd = dateStrToEndTs(a.plan_expires_at);
        if (planEnd != null && (a.plan_credits ?? 0) > 0) {
          // 包计数与到期日历口径对齐：包明细缺 plan 包（明细接口失败/老缓存回退
          // 聚合口径）时，日历会补一条「Plan 订阅重置」独立条目 → 此处同步 +1
          packages += 1;
          if (planEnd > nowSec && planEnd <= horizon) expiring += a.plan_credits ?? 0;
        }
      }
    }
    // 今日新增（D3）：有筛选时改走按账号过滤的签到口径（快照 earned 全账号合并
    // 不可拆，其源头即逐账号签到合计，同源同口径），无筛选维持原口径
    const todaySnap = qoderSnapshots.find((s) => s.date === today);
    const todayEarned = visibleUids
      ? (qoderEarnedByDateFiltered(qoderCheckin, visibleUids).get(today) ?? 0)
      : (() => {
          const checkinEarned = qoderCheckin
            .filter((r) => r.date === today)
            .reduce((s, r) => s + (r.reward ?? 0), 0);
          return todaySnap?.earned != null ? Math.max(0, todaySnap.earned) : checkinEarned;
        })();
    // 今日消耗：只取官网采集（官方接口，口径最准）。已按当前账号筛选重算
    // （无筛选 = 全池已采集账号汇总）；未采集/无值显示「—」，不回退网关或快照
    const todayConsumed = qoderWebScoped?.summary.usage_today ?? null;
    return {
      accounts: accs.length,
      totalCredits,
      packages,
      todayEarned,
      todayConsumed,
      expiring7d: expiring,
    };
  }, [visibleQoderCredits, qoderSnapshots, qoderCheckin, qoderWebScoped, visibleUids, today]);

  const kpi = isTrae ? traeKpi : isQoder ? qoderKpi : buddyKpi;

  // 可用积分总数卡 hint：Buddy/Qoder 缓存/stale 状态说明；无数据时不给失真提示
  const creditsResult = platform === 'trae' ? null : platform === 'buddy' ? wbCredits : qoderCredits;
  const creditsHint = !creditsResult
    ? undefined
    : creditsResult.stale
      ? '历史缓存回退（本次查询失败）'
      : creditsResult.cached
        ? '缓存数据（≥10 分钟）'
        : '实时数据';
  // 今日新增口径诚实标注（§8.4）：快照 earned 已统计 vs 回退签到口径；Trae 筛选态
  // 按账号明细推导，老快照日缺 accounts 明细被跳过时如实标注（adapters 契约：
  // skippedDates>0 时调用方必须说明，不静默少计）
  const todaySnapEarned = wbSnapshots.find((s) => s.date === today)?.earned;
  const qoderTodaySnap = qoderSnapshots.find((s) => s.date === today);
  const earnedHint = isTrae
    ? filtersActive && traeFilteredEarned && traeFilteredEarned.skippedDates > 0
      ? '筛选口径 · 部分老快照日缺账号明细未计入推导'
      : undefined
    : isQoder
      ? qoderTodaySnap?.earned != null
        ? '口径：当日签到奖励合计'
        : qoderCheckin.length > 0
          ? '仅含签到新增'
          : undefined
      : todaySnapEarned != null
        ? '口径：余额差分+签到归并'
        : wbCheckin.length > 0
          ? '仅含签到新增'
          : undefined;
  // 今日消耗口径标注：只认官网源，官网失效时如实留空（不回退本地/网关）
  const consumedHint = isTrae
    ? undefined
    : isQoder
      ? qoderWebScoped == null
        ? '官网未采集 · 消耗无数据'
        : `官网采集 · 已采集 ${qoderWebScoped.accounts_total ?? 0}/${qoderCredits?.accounts.length ?? 0} 账号`
      : wbOfficial == null
        ? '官网用量未加载'
        : wbOfficial.stale
          ? 'Buddy 官网缓存 · 本次拉取失败'
          : undefined;

  // D3：consumed 为聚合口径无法按账号拆分时有筛选需诚实标注（数值-徽标一致性）。
  // Trae 取按 uid 过滤的官网明细、Qoder 官网采集已按筛选重算，均无需该标注；仅 Buddy 官网页为聚合口径
  const consumedHintShown =
    filtersActive && platform === 'buddy'
      ? consumedHint
        ? `${consumedHint} · 聚合口径，未按账号筛选`
        : '聚合口径，未按账号筛选'
      : consumedHint;

  const scope: PlatformScope = platform;

  return (
    <div className="animate-fade-in">
      <PageHeader title={PAGE_META[platform].title} desc={PAGE_META[platform].desc} />

      {/* KPI 统计面板（7 卡，§2；单平台口径） */}
      <div className="mb-5">
        <KpiRow
          kpi={kpi}
          platform={platform}
          today={today}
          creditsHint={creditsHint}
          totalHint={traeTotalHint}
          earnedHint={earnedHint}
          consumedHint={consumedHintShown}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SegmentedTabs
          value={tab}
          onChange={(k) => setTab(k as BoardTab)}
          options={TABS.map((t) => ({ key: t.key, label: t.label }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          {/* 顶部分组/账号筛选（P1 需求②）：平台视图内全局生效 */}
          <MultiSelectDropdown
            label="分组"
            onOpen={reloadPoolGroups}
            options={poolGroups.map((g) => ({ id: g.id, name: `${g.name} (${g.count})`, color: g.color }))}
            selected={groupFilter}
            onChange={(ids) => {
              setGroupFilter(ids);
              // 分组变化后账号候选联动收窄；已选账号若不在新候选内则清空账号筛选
              setAccountFilter((prev) => prev.filter((id) => {
                if (ids.length === 0) return true;
                return poolGroups.some((g) => ids.includes(g.id) && g.uids.includes(id));
              }));
            }}
          />
          <MultiSelectDropdown
            label="账号"
            options={accountCandidates}
            selected={accountFilter}
            onChange={setAccountFilter}
          />
          {filtersActive &&
            tab !== 'expiry' &&
            tab !== 'sessions' &&
            (tab === 'credits' ? platform === 'buddy' : true) && (
            <Badge
              tone="amber"
              title="当前数据源为聚合口径（无账号维度），筛选仅作用于 KPI 与到期日历；消耗/Token 明细不做静默截断"
            >
              该数据源不支持账号级筛选
            </Badge>
          )}
          {/* 会话明细 Tab：顶部筛选仅收窄账号候选下拉、不进查询参数（后端 user_id 单值）——
              此前徽标豁免会话 Tab，用户误以为已按组过滤。明示语义断层（2026-10-12 审查） */}
          {filtersActive && tab === 'sessions' && (
            <Badge
              tone="amber"
              title="顶部分组/账号筛选仅收窄会话页的账号候选下拉，不直接过滤查询结果；请使用会话页内的筛选行（时间/账号/模型）过滤"
            >
              顶部筛选仅收窄账号候选，会话结果按页内筛选过滤
            </Badge>
          )}
          {platform === 'buddy' && wbOfficial?.refreshing && (
            <Badge tone="blue" title="后端缓存已过期，正在后台重拉官网用量（全量聚合需数十秒），完成后自动更新">
              <Spinner className="mr-1 h-3 w-3" /> 已用积分刷新中
            </Badge>
          )}
          {isQoder && (
            <button className="btn-outline" onClick={openCollect} disabled={collectingId != null}>
              <Globe size={15} className={collectingId ? 'animate-pulse' : ''} />{' '}
              {collectingId ? '等待登录/采集…' : '官网采集'}
            </button>
          )}
          <button className="btn-outline" onClick={() => void refresh(true)} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> 刷新数据
          </button>
        </div>
      </div>

      {tab === 'expiry' ? (
        <ExpiryTab scope={scope} accounts={visibleAccounts} wbCredits={visibleWbCredits} qoderCredits={visibleQoderCredits} expiredEnts={expiredEnts} />
      ) : tab === 'sessions' ? (
        <SessionsTab scope={scope} accountOptions={sessionAccountOptions} refreshKey={sessionsRefreshKey} />
      ) : tab === 'credits' ? (
        <CreditsTab
          scope={scope}
          usage={visibleUsage}
          creditsDaily={creditsDaily}
          wbOfficial={wbOfficial}
          wbSnapshots={wbSnapshots}
          wbCheckin={wbCheckin}
          qoderSnapshots={qoderSnapshots}
          qoderCheckin={qoderCheckin}
          qoderWeb={qoderWebScoped}
          uidSet={visibleUids}
        />
      ) : (
        <TokensTab
          scope={scope}
          usage={visibleUsage}
          gateway={gateway}
        />
      )}

      {/* 多账号采集账号选择（每个账号独立 Webview 数据目录） */}
      <QoderWebCollectDialog
        open={collectOpen}
        targets={(qoderCredits?.accounts ?? []).map((a) => ({ id: a.user_id, name: a.name || a.user_id }))}
        collected={qoderCollected}
        collectingId={collectingId}
        onClose={() => setCollectOpen(false)}
        onPick={(id) => void startCollect(id)}
      />
    </div>
  );
}
