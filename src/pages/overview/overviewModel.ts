import { dateStrToEndTs } from '../../lib/format';
import type {
  AccountView,
  QoderAccountView,
  QoderCheckinRecord,
  QoderCreditsResult,
  QoderCreditsSnapshot,
  QoderWebUsageToday,
  UsageDayView,
  UsageHistoryResult,
  ViewKey,
  WbCheckinRecord,
  WbCreditsResult,
  WbUsageFallback,
  WbUsageOfficialAll,
  WorkBuddyAccountView,
} from '../../types';

/** 长期有效包哨兵（与 ExpiryTab / Rust pack_to_detail 同口径） */
export const PERPETUAL_TS = 4102444800;
const DAY_SEC = 86_400;
const ALERT_SEC = 24 * 3600;
const EXPIRY_SEC = 7 * DAY_SEC;

/** 总览只展示积分型平台（豆包为额度口径，不参与本页） */
export type PlatformKey = 'trae' | 'buddy' | 'qoder';

/** API 网关用量桶（Token 统计来源；与三平台分账口径一一对应 + 自定义/BuddyAI 独立桶） */
export type GatewayPoolKey = 'trae' | 'buddy' | 'buddy-ai' | 'custom' | 'qoder';

/** 网关账号 token 消耗行（分账号展示，随平台面板内嵌） */
export interface TokenAccountRow {
  id: string;
  pool: GatewayPoolKey;
  uid: string;
  /** 账号名；取不到时回落 uid / 固定标签 */
  name: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** 单平台池的今日 Token 小计 + 逐账号明细（平台卡片内嵌数据） */
export interface TokenPoolSummary {
  /** 该池数据源缺失/无当日条目时为 null（不与 0 混淆） */
  prompt: number | null;
  completion: number | null;
  total: number | null;
  rows: TokenAccountRow[];
}

/** API 网关今日 Token 消耗汇总（数据源：三平台池按日落盘用量，非官网积分口径） */
export interface TokenSummary {
  /** 任一平台池数据源缺失且无有效数据时为 null（不与 0 混淆） */
  prompt: number | null;
  completion: number | null;
  total: number | null;
  /** 有 token 消耗的账号数 */
  accounts: number;
  rows: TokenAccountRow[];
  /** 三平台池小计（平台卡片取用；与总量同口径） */
  byPlatform: Record<PlatformKey, TokenPoolSummary>;
}

/** 逐账号今日积分消耗（总览页「各账号积分消耗明细」） */
export interface CreditUsageRow {
  id: string;
  platform: PlatformKey;
  uid: string;
  name: string;
  /** 今日消耗积分；null = 该账号无账号级消耗数据 */
  credits: number | null;
  /** 数据来源 / 缺失原因（表格副文案） */
  source: string;
}

export interface CreditUsageSummary {
  /** 有账号级数据的账号合计消耗；全部缺失为 null */
  total: number | null;
  /** 有账号级数据的账号数 */
  withData: number;
  /** 三平台账号总数 */
  accounts: number;
  rows: CreditUsageRow[];
}

export interface PlatformAlert {
  id: string;
  platform: PlatformKey;
  user_id: string;
  name: string;
  reason: string;
  view: ViewKey;
}

/** 积分到期明细：不进「账号告警」，单独在底部列表展示 */
export interface ExpiringDetail {
  id: string;
  user_id: string;
  name: string;
  reason: string;
  /** 7 日内到期的积分；null = 仅有到期时间、无包级金额 */
  credits: number | null;
  view: ViewKey;
}

export interface PlatformSummary {
  key: PlatformKey;
  accounts: number;
  checkedToday: number;
  /** 可用积分；null = 数据源缺失，不与 0 混淆 */
  available: number | null;
  /** 今日已用积分；null = 数据源缺失，不与 0 混淆 */
  usedToday: number | null;
  /** 7 天内到期积分金额 */
  expiringIn7d: number | null;
  alertAccounts: number;
  /** 仅凭证类告警（临期 / 需重登） */
  alerts: PlatformAlert[];
  /** 7 日内积分到期明细（逐账号，金额可为 null） */
  expiringDetails: ExpiringDetail[];
  notes: string[];
}

export interface OverviewData {
  traeAccounts: AccountView[];
  /** Trae 官网消耗明细（usage_history_fetch） */
  traeUsage: UsageHistoryResult | null;
  wbAccounts: WorkBuddyAccountView[];
  wbCredits: WbCreditsResult | null;
  wbCheckin: WbCheckinRecord[];
  /** Buddy 官网用量聚合（优先） */
  wbOfficial: WbUsageOfficialAll | null;
  /** Buddy 本地快照回退（官网不可用时） */
  wbUsage: WbUsageFallback | null;
  qoderAccounts: QoderAccountView[];
  qoderCredits: QoderCreditsResult | null;
  qoderCheckin: QoderCheckinRecord[];
  /** Qoder 本地积分快照差分（官网会话不可用时回退） */
  qoderSnapshots: QoderCreditsSnapshot[];
  /** Qoder 官网会话今日消耗（优先） */
  qoderWebUsage: QoderWebUsageToday | null;
  /** API 网关五桶今日用量（Token 消耗统计来源；缺省 = 未接入/加载失败） */
  gwUsage?: Partial<Record<GatewayPoolKey, UsageDayView[] | null>>;
  nowMs?: number;
}

export interface OverviewKpis {
  accounts: number;
  available: number | null;
  usedToday: number | null;
  expiringIn7d: number | null;
  alerts: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function sumDefined(values: (number | null | undefined)[]): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  return nums.length ? round(nums.reduce((s, n) => s + n, 0)) : null;
}

function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function alert(
  out: PlatformAlert[],
  platform: PlatformKey,
  user_id: string,
  name: string,
  reason: string,
  view: ViewKey,
): void {
  out.push({ id: `${platform}-${user_id}-${reason}`, platform, user_id, name, reason, view });
}

function finish(
  key: PlatformKey,
  accounts: number,
  checkedToday: number,
  available: number | null,
  usedToday: number | null,
  expiringIn7d: number | null,
  alerts: PlatformAlert[],
  expiringDetails: ExpiringDetail[],
  notes: string[],
): PlatformSummary {
  return {
    key,
    accounts,
    checkedToday,
    available,
    usedToday,
    expiringIn7d,
    alertAccounts: new Set(alerts.map((a) => a.user_id)).size,
    alerts,
    expiringDetails,
    notes,
  };
}

/** Trae：账号池（含逐包明细）+ 官网消耗明细（今日已用） */
export function summarizeTrae(
  accounts: AccountView[],
  usage: UsageHistoryResult | null,
  nowMs = Date.now(),
): PlatformSummary {
  const nowSec = Math.floor(nowMs / 1000);
  const windowEnd = nowSec + EXPIRY_SEC;
  const today = localDate(nowMs);
  const todayValues = (usage?.accounts ?? [])
    .map((a) => a.daily.find((d) => d.date.slice(0, 10) === today)?.credits)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const usedToday = todayValues.length ? round(todayValues.reduce((s, n) => s + n, 0)) : null;
  const alerts: PlatformAlert[] = [];
  const expiringDetails: ExpiringDetail[] = [];
  let expiring = 0;
  let hasPacks = false;

  for (const a of accounts) {
    const packs = a.credit_packs ?? [];
    if (a.credit_packs != null) hasPacks = true;
    const soon = packs.filter(
      (p) => p.remaining > 0 && p.expire_time > 0 && p.expire_time < PERPETUAL_TS && p.expire_time <= windowEnd,
    );
    if (soon.length) {
      const amount = round(soon.reduce((s, p) => s + p.remaining, 0));
      expiring += amount;
      expiringDetails.push({
        id: `trae-exp-${a.user_id}`,
        user_id: a.user_id,
        name: a.name,
        reason: `${soon.length} 个积分包 7 天内到期`,
        credits: amount,
        view: 'credits',
      });
    } else if (
      a.credit_packs == null &&
      a.credits_expire_at != null &&
      a.credits_expire_at <= windowEnd &&
      (a.remaining_credits ?? 0) > 0
    ) {
      expiringDetails.push({
        id: `trae-exp-${a.user_id}`,
        user_id: a.user_id,
        name: a.name,
        reason: '积分 7 天内到期（未刷新明细）',
        credits: null,
        view: 'credits',
      });
    }
    if (a.jwt_exp_hours != null && a.jwt_exp_hours <= 24) {
      alert(alerts, 'trae', a.user_id, a.name, '凭证 24h 内到期', 'accounts');
    } else if (a.refresh_token_invalid) {
      alert(alerts, 'trae', a.user_id, a.name, '需重新 OAuth 登录', 'accounts');
    }
  }

  return finish(
    'trae',
    accounts.length,
    accounts.filter((a) => a.checked_today).length,
    sumDefined(accounts.map((a) => a.remaining_credits)),
    usedToday,
    hasPacks ? round(expiring) : null,
    alerts,
    expiringDetails,
    [
      usedToday == null ? '今日已用：官网明细暂无数据' : '今日已用：官网消耗明细',
      usage?.cached ? '官网明细缓存' : '',
    ].filter(Boolean),
  );
}

/** Buddy：账号池 + 积分查询（逐包）+ 官网用量优先/本地快照回退 + 签到记录 */
export function summarizeBuddy(
  accounts: WorkBuddyAccountView[],
  credits: WbCreditsResult | null,
  checkin: WbCheckinRecord[],
  official: WbUsageOfficialAll | null,
  fallback: WbUsageFallback | null,
  nowMs = Date.now(),
): PlatformSummary {
  const nowSec = Math.floor(nowMs / 1000);
  const windowEnd = nowSec + EXPIRY_SEC;
  const today = localDate(nowMs);
  const alerts: PlatformAlert[] = [];
  const expiringDetails: ExpiringDetail[] = [];
  const creditsAccounts = credits?.accounts ?? [];
  let expiring = 0;
  let hasCredits = creditsAccounts.length > 0;

  for (const a of accounts) {
    if (a.needs_relogin) alert(alerts, 'buddy', a.id, a.nickname, '需重新登录', 'buddy-accounts');
    else if (a.access_token_expires_at != null && a.access_token_expires_at <= nowSec + ALERT_SEC) {
      alert(alerts, 'buddy', a.id, a.nickname, '凭证 24h 内到期', 'buddy-accounts');
    }
  }
  for (const a of creditsAccounts) {
    const soon = (a.packages ?? []).filter(
      (p) =>
        p.remaining > 0 &&
        p.expire_ts != null &&
        p.expire_ts > 0 &&
        p.expire_ts < PERPETUAL_TS &&
        p.expire_ts <= windowEnd,
    );
    if (soon.length) {
      const amount = round(soon.reduce((s, p) => s + p.remaining, 0));
      expiring += amount;
      expiringDetails.push({
        id: `buddy-exp-${a.user_id}`,
        user_id: a.user_id,
        name: a.name,
        reason: `${soon.length} 个积分包 7 天内到期`,
        credits: amount,
        view: 'buddy-credits',
      });
    }
  }

  const officialToday = official?.summary?.usage_today;
  const fallbackToday = fallback?.summary?.usage_today;
  const usedToday = officialToday != null ? round(officialToday) : fallbackToday != null ? round(fallbackToday) : null;
  const sourceNote = officialToday != null
    ? official?.stale ? '今日已用：官网用量（过期缓存）' : '今日已用：官网用量'
    : fallbackToday != null ? '今日已用：官网不可用，回退本地快照' : '今日已用：官网与快照均无数据';

  return finish(
    'buddy',
    accounts.length,
    new Set(checkin.filter((r) => r.date === today && r.status !== 'fail').map((r) => r.user_id)).size,
    sumDefined(creditsAccounts.map((a) => a.balance)) ?? sumDefined(accounts.map((a) => a.credits_balance)),
    usedToday,
    hasCredits ? round(expiring) : null,
    alerts,
    expiringDetails,
    [sourceNote],
  );
}

/** Qoder：账号池 + 积分查询（逐包/订阅）+ 本地积分快照 + 签到记录（官网无消耗明细接口） */
export function summarizeQoder(
  accounts: QoderAccountView[],
  credits: QoderCreditsResult | null,
  checkin: QoderCheckinRecord[],
  snapshots: QoderCreditsSnapshot[],
  webUsage: QoderWebUsageToday | null,
  nowMs = Date.now(),
  /** API 网关 Qoder 池当日用量（积分测量口径，消耗统计首选数据源） */
  gatewayDay: UsageDayView | null = null,
): PlatformSummary {
  const nowSec = Math.floor(nowMs / 1000);
  const windowEnd = nowSec + EXPIRY_SEC;
  const today = localDate(nowMs);
  const alerts: PlatformAlert[] = [];
  const expiringDetails: ExpiringDetail[] = [];
  const creditsAccounts = credits?.accounts ?? [];
  let expiring = 0;
  let hasCredits = creditsAccounts.length > 0;

  for (const a of accounts) {
    if (a.needs_relogin) alert(alerts, 'qoder', a.id, a.nickname, '需重新登录', 'qoder-accounts');
    else if (a.token_expires_at != null && a.token_expires_at <= nowSec + ALERT_SEC) {
      alert(alerts, 'qoder', a.id, a.nickname, '凭证 24h 内到期', 'qoder-accounts');
    }
  }
  for (const a of creditsAccounts) {
    const pkgs = a.packages ?? [];
    // 明细已含 plan 订阅配额包（R-11 逐包口径）→ 不再按聚合口径补订阅额度，
    // 判定与积分看板 KPI / 到期日历同款（some 不过滤 amount）
    const hasPlanPkg = pkgs.some((p) => p.source === 'plan');
    const active = pkgs.filter((p) => p.amount == null || p.amount > 0);
    const soon = active.filter((p) => {
      const end = dateStrToEndTs(p.expire_at);
      return end != null && end > nowSec && end <= windowEnd;
    });
    if (soon.length) {
      const amount = round(soon.reduce((s, p) => s + (p.amount ?? 0), 0));
      expiring += amount;
      expiringDetails.push({
        id: `qoder-exp-${a.user_id}`,
        user_id: a.user_id,
        name: a.name,
        reason: `${soon.length} 个积分包 7 天内到期`,
        credits: amount,
        view: 'qoder-credits',
      });
    }
    // 订阅额度 7 天内重置：与积分看板同口径——明细未含 plan 包时按 plan_credits
    // 全额计入合计（原先仅在「无任何包明细」时补条目且漏加 expiring，
    // 有其它包在窗口内时订阅额度整体丢失，总览小于看板）
    const planEnd = dateStrToEndTs(a.plan_expires_at);
    if (
      !hasPlanPkg &&
      (a.plan_credits ?? 0) > 0 &&
      planEnd != null &&
      planEnd > nowSec &&
      planEnd <= windowEnd
    ) {
      const amount = round(a.plan_credits ?? 0);
      expiring += amount;
      expiringDetails.push({
        id: `qoder-exp-plan-${a.user_id}`,
        user_id: a.user_id,
        name: a.name,
        reason: '订阅积分 7 天内重置',
        credits: amount,
        view: 'qoder-credits',
      });
    }
  }

  const todaySnap = [...snapshots].reverse().find((s) => s.date.slice(0, 10) === today);
  // 消耗统计口径：API 网关 Qoder 池积分测量值优先（唯一覆盖全部走网关流量、
  // 且可逐账号/逐模型分账的权威源）；网关当日无条目时回退官网会话明细，
  // 再回退本地积分快照差分。三者覆盖范围不同，notes 如实标注当前生效口径。
  const gatewayUsed = gatewayDay ? round(gatewayDay.credits) : null;
  const officialUsed = webUsage?.ok ? webUsage.used_today : null;
  const usedToday =
    gatewayUsed != null
      ? gatewayUsed
      : officialUsed != null
        ? round(officialUsed)
        : todaySnap?.consumed != null
          ? round(todaySnap.consumed)
          : null;
  const sourceNote =
    gatewayUsed != null
      ? '今日已用：API 网关 Qoder 池实测积分'
      : officialUsed != null
        ? '今日已用：官网会话消耗明细（当前客户端登录账号）'
        : webUsage?.error
          ? '今日已用：官网会话不可用，回退本地快照'
          : '今日已用：本地积分快照差分';
  return finish(
    'qoder',
    accounts.length,
    new Set(checkin.filter((r) => r.date === today && r.status !== 'fail').map((r) => r.user_id)).size,
    sumDefined(creditsAccounts.map((a) => a.total)) ?? sumDefined(accounts.map((a) => a.credits_balance)),
    usedToday,
    hasCredits ? round(expiring) : null,
    alerts,
    expiringDetails,
    [sourceNote],
  );
}

/** 网关特殊 uid 的展示名（非真实账号：自定义池固定 uid / 无健康账号 / 工具代执行） */
const GW_SENTINEL_NAMES: Record<string, string> = {
  custom: '自定义模型',
  none: '未归属账号',
  'wb-toolexec': '工具代执行',
};

/** 桶内当日单日统计（后端按日历窗口返回；无当日条目返回 null，不用其它日期冒充） */
function todayUsage(days: UsageDayView[] | null | undefined, today: string): UsageDayView | null {
  return days?.find((d) => d.date.slice(0, 10) === today) ?? null;
}

/** 总览 Token 只取三平台池（自定义 / BuddyAI 为独立桶，见 API 管理页用量统计） */
const OVERVIEW_TOKEN_POOLS: PlatformKey[] = ['trae', 'buddy', 'qoder'];

function emptyPool(): TokenPoolSummary {
  return { prompt: null, completion: null, total: null, rows: [] };
}

/**
 * API 网关今日 Token 消耗（三平台池合计 + 分账号明细，按池归到平台卡片）。
 * 合计取单日统计的 prompt/completion（权威口径）；明细取 account_tokens（按账号分账）。
 * 账号名从各平台账号池解析，解析不到回落 uid / 固定标签。
 */
export function summarizeGatewayTokens(data: OverviewData, nowMs = Date.now()): TokenSummary {
  const today = localDate(nowMs);
  const names = new Map<string, string>();
  for (const a of data.traeAccounts) names.set(`trae:${a.user_id}`, a.name);
  for (const a of data.wbAccounts) names.set(`buddy:${a.id}`, a.nickname);
  for (const a of data.qoderAccounts) names.set(`qoder:${a.id}`, a.nickname);

  const byPlatform: Record<PlatformKey, TokenPoolSummary> = {
    trae: emptyPool(),
    buddy: emptyPool(),
    qoder: emptyPool(),
  };
  const rows: TokenAccountRow[] = [];
  let prompt = 0;
  let completion = 0;
  let hasData = false;

  for (const key of OVERVIEW_TOKEN_POOLS) {
    const day = todayUsage(data.gwUsage?.[key], today);
    if (!day) continue;
    hasData = true;
    prompt += day.prompt_tokens;
    completion += day.completion_tokens;
    const pool = byPlatform[key];
    pool.prompt = day.prompt_tokens;
    pool.completion = day.completion_tokens;
    pool.total = day.prompt_tokens + day.completion_tokens;
    for (const t of day.account_tokens ?? []) {
      const total = t.prompt_tokens + t.completion_tokens;
      if (total <= 0) continue;
      const row: TokenAccountRow = {
        id: `${key}-${t.name}`,
        pool: key,
        uid: t.name,
        name: names.get(`${key}:${t.name}`) || GW_SENTINEL_NAMES[t.name] || t.name,
        prompt_tokens: t.prompt_tokens,
        completion_tokens: t.completion_tokens,
        total_tokens: total,
      };
      pool.rows.push(row);
      rows.push(row);
    }
  }

  const byTotalDesc = (a: TokenAccountRow, b: TokenAccountRow) =>
    b.total_tokens - a.total_tokens || a.name.localeCompare(b.name);
  rows.sort(byTotalDesc);
  for (const key of OVERVIEW_TOKEN_POOLS) byPlatform[key].rows.sort(byTotalDesc);

  return {
    prompt: hasData ? prompt : null,
    completion: hasData ? completion : null,
    total: hasData ? prompt + completion : null,
    accounts: rows.length,
    rows,
    byPlatform,
  };
}

/**
 * 逐账号今日积分消耗明细。
 * 口径：Trae = 官网消耗明细逐账号当日 credits；Buddy = 官网全账号用量的逐账号
 * usage_today（本次新增字段，旧缓存缺省时标注仅合计口径）；Qoder = 本地积分快照
 * 前后两日余额差分（官网无逐账号按日消耗接口，含签到奖励时可能低估，负值记 0）。
 * 无账号级数据的账号仍列出（credits=null + 缺失原因），避免误以为账号缺失。
 */
export function summarizeCreditUsage(data: OverviewData, nowMs = Date.now()): CreditUsageSummary {
  const today = localDate(nowMs);
  const rows: CreditUsageRow[] = [];

  const traeUsageByUid = new Map((data.traeUsage?.accounts ?? []).map((a) => [a.user_id, a]));
  for (const a of data.traeAccounts) {
    const day = traeUsageByUid.get(a.user_id)?.daily.find((d) => d.date.slice(0, 10) === today);
    rows.push({
      id: `trae-${a.user_id}`,
      platform: 'trae',
      uid: a.user_id,
      name: a.name,
      credits: day?.credits != null ? round(day.credits) : null,
      source:
        day?.credits != null
          ? '官网消耗明细'
          : data.traeUsage
            ? '官网当日无明细'
            : '官网明细未加载',
    });
  }

  const wbByUid = new Map((data.wbOfficial?.accounts ?? []).map((a) => [a.user_id, a]));
  for (const a of data.wbAccounts) {
    const rec = wbByUid.get(a.id);
    rows.push({
      id: `buddy-${a.id}`,
      platform: 'buddy',
      uid: a.id,
      name: a.nickname,
      credits: rec ? round(rec.usage_today) : null,
      source: rec ? '官网用量（逐账号）' : data.wbOfficial ? '官网仅合计口径' : '官网用量未加载',
    });
  }

  const snaps = [...(data.qoderSnapshots ?? [])].sort((x, y) => x.date.localeCompare(y.date));
  const todaySnap = snaps.find((s) => s.date.slice(0, 10) === today) ?? null;
  const prevSnap = todaySnap
    ? ([...snaps].reverse().find((s) => s.date.slice(0, 10) < today) ?? null)
    : null;
  // 当日签到奖励按账号汇总（奖励口径与「获得积分」同源：campaigns 明细优先，
  // 无明细时回退 reward）。**必须参与差分**：Qoder 每日签到 +100 会让余额逆势上涨，
  // 只算「前日 − 当日」会把真实消耗钳成 0（线上表现为明细恒 0），
  // 正确公式与后端快照 consumed 一致：消耗 = 前日余额 + 当日获得 − 当日余额
  const earnedByUid = new Map<string, number>();
  for (const r of data.qoderCheckin ?? []) {
    if (r.date !== today || r.status === 'fail') continue;
    const reward = r.campaigns?.length
      ? r.campaigns.reduce((s, c) => s + (c.reward ?? 0), 0)
      : (r.reward ?? 0);
    if (reward > 0) earnedByUid.set(r.user_id, (earnedByUid.get(r.user_id) ?? 0) + reward);
  }
  // Qoder 逐账号消耗：API 网关 Qoder 池当日积分测量值优先（accounts[].credits，
  // uid 即账号 id 口径）；网关当日无该账号记录时回退本地快照差分
  // （消耗 = 前日余额 + 当日签到 − 当日余额，负值记 0）。
  const gwCreditsByUid = new Map<string, number>();
  for (const c of data.gwUsage?.qoder ? (todayUsage(data.gwUsage.qoder, today)?.accounts ?? []) : []) {
    if (c.credits > 0) gwCreditsByUid.set(c.name, c.credits);
  }
  for (const a of data.qoderAccounts) {
    const gwUsed = gwCreditsByUid.get(a.id);
    if (gwUsed != null) {
      rows.push({
        id: `qoder-${a.id}`,
        platform: 'qoder',
        uid: a.id,
        name: a.nickname,
        credits: round(gwUsed),
        source: 'API 网关实测积分',
      });
      continue;
    }
    const cur = todaySnap?.accounts?.find((x) => x.user_id === a.id)?.total ?? null;
    const prev = prevSnap?.accounts?.find((x) => x.user_id === a.id)?.total ?? null;
    const earned = earnedByUid.get(a.id) ?? 0;
    const used = cur != null && prev != null ? Math.max(0, round(prev + earned - cur)) : null;
    rows.push({
      id: `qoder-${a.id}`,
      platform: 'qoder',
      uid: a.id,
      name: a.nickname,
      credits: used,
      source:
        used != null
          ? earned > 0
            ? `快照差分（含当日签到 +${round(earned)} 补正）`
            : '快照差分'
          : todaySnap
            ? '快照无前一日对比'
            : '今日快照未更新',
    });
  }

  rows.sort(
    (a, b) => (b.credits ?? -1) - (a.credits ?? -1) || a.name.localeCompare(b.name),
  );
  const withData = rows.filter((r) => r.credits != null).length;
  const total = withData
    ? round(rows.reduce((n, r) => n + (r.credits ?? 0), 0))
    : null;
  return { total, withData, accounts: rows.length, rows };
}

/** 三平台汇总（今日已用：Trae/Buddy 官网，Qoder 官网会话优先、本地快照回退） */
export function aggregateKpis(summaries: PlatformSummary[]): OverviewKpis {
  return {
    accounts: summaries.reduce((n, s) => n + s.accounts, 0),
    available: sumDefined(summaries.map((s) => s.available)),
    usedToday: sumDefined(summaries.map((s) => s.usedToday)),
    expiringIn7d: sumDefined(summaries.map((s) => s.expiringIn7d)),
    alerts: new Set(summaries.flatMap((s) => s.alerts.map((a) => a.id))).size,
  };
}

/** 一次聚合全部平台（页面只用这一个入口，便于测试） */
export function buildOverview(data: OverviewData): {
  platforms: PlatformSummary[];
  kpis: OverviewKpis;
  tokens: TokenSummary;
  credits: CreditUsageSummary;
} {
  const now = data.nowMs ?? Date.now();
  const platforms = [
    summarizeTrae(data.traeAccounts, data.traeUsage, now),
    summarizeBuddy(data.wbAccounts, data.wbCredits, data.wbCheckin, data.wbOfficial, data.wbUsage, now),
    summarizeQoder(
      data.qoderAccounts,
      data.qoderCredits,
      data.qoderCheckin,
      data.qoderSnapshots,
      data.qoderWebUsage,
      now,
      todayUsage(data.gwUsage?.qoder, localDate(now)),
    ),
  ];
  return {
    platforms,
    kpis: aggregateKpis(platforms),
    tokens: summarizeGatewayTokens(data, now),
    credits: summarizeCreditUsage(data, now),
  };
}
