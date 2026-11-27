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

/**
 * 三源视图统一适配层（credits-dashboard-plan.md §4.4）：
 * 各数据命令返回 → BoardPoint[] 的纯函数适配器，可单测。
 * 页内不做静默口径合并——各源覆盖窗口/粒度差异由调用方明示（§8）。
 */

/** 看板统一数据点（date = 本地自然日 YYYY-MM-DD） */
export interface BoardPoint {
  date: string;
  credits?: number;
  tokens?: number;
  calls?: number;
  models: Record<string, { credits?: number; tokens?: number; calls?: number }>;
}

/** Trae 官网消耗明细（usage_history_fetch，日 × 模型，365 天） */
export function traeUsageToPoints(usage: UsageHistoryResult | null): BoardPoint[] {
  if (!usage) return [];
  const byDate = new Map<string, BoardPoint>();
  for (const a of usage.accounts) {
    for (const d of a.daily) {
      const date = d.date.slice(0, 10);
      let p = byDate.get(date);
      if (!p) {
        p = { date, models: {} };
        byDate.set(date, p);
      }
      p.credits = (p.credits ?? 0) + d.credits;
      p.calls = (p.calls ?? 0) + d.sessions;
      for (const [model, credits] of Object.entries(d.models)) {
        const m = (p.models[model] ??= {});
        m.credits = (m.credits ?? 0) + credits;
      }
    }
  }
  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
}

/** Buddy 官网用量聚合（workbuddy_usage_official_all，日合计，31 天零填充） */
export function wbOfficialAllToPoints(r: WbUsageOfficialAll | null): BoardPoint[] {
  if (!r) return [];
  return r.daily.map((d) => ({ date: d.date.slice(0, 10), credits: d.usage, models: {} }));
}

/**
 * 按账号筛选重算官网采集视图（uidSet = 池账号 id 集；null/空 = 直接用全池汇总）。
 * 筛选后无任何已采集账号 → null（调用方展示「无官网采集数据」空态，不回退其他源），
 * 避免全 0 视图冒充真实消耗。
 */
export function aggregateQoderWebAccounts(
  r: QoderWebUsage | null,
  uids: Set<string> | null,
): QoderWebUsage | null {
  if (!r) return null;
  if (!uids || uids.size === 0 || !r.accounts) return r;
  const picked = r.accounts.filter((a) => uids.has(a.account_id));
  if (picked.length === 0) return null;
  // 以顶层 daily 的日期轴为准（31 天零填充），逐账号相加
  const slots = new Map<
    string,
    { usage: number; models: Map<string, { request_count: number; credit: number }> }
  >();
  for (const d of r.daily) slots.set(d.date, { usage: 0, models: new Map() });
  let records = 0;
  let billed = 0;
  for (const a of picked) {
    records += a.records_total;
    billed += a.billed_total;
    for (const d of a.daily ?? []) {
      const slot = slots.get(d.date);
      if (!slot) continue;
      slot.usage += d.usage;
      for (const m of d.models) {
        const e = slot.models.get(m.model) ?? { request_count: 0, credit: 0 };
        e.request_count += m.request_count;
        e.credit += m.credit;
        slot.models.set(m.model, e);
      }
    }
  }
  const daily = r.daily.map((d) => {
    const slot = slots.get(d.date)!;
    return {
      date: d.date,
      usage: slot.usage,
      models: [...slot.models.entries()]
        .map(([model, v]) => ({ model, request_count: v.request_count, credit: v.credit }))
        .sort((x, y) => y.credit - x.credit),
    };
  });
  const monthPrefix = (daily[daily.length - 1]?.date ?? '').slice(0, 7);
  const modelTotals = new Map<string, { request_count: number; credit: number }>();
  for (const d of daily) {
    for (const m of d.models) {
      const e = modelTotals.get(m.model) ?? { request_count: 0, credit: 0 };
      e.request_count += m.request_count;
      e.credit += m.credit;
      modelTotals.set(m.model, e);
    }
  }
  return {
    ...r,
    records_total: records,
    billed_total: billed,
    summary: {
      usage_today: daily[daily.length - 1]?.usage ?? 0,
      usage_7days: daily.slice(-7).reduce((s, d) => s + d.usage, 0),
      usage_this_month: daily
        .filter((d) => d.date.slice(0, 7) === monthPrefix)
        .reduce((s, d) => s + d.usage, 0),
    },
    daily,
    models: [...modelTotals.entries()]
      .map(([model, v]) => ({ model, request_count: v.request_count, credit: v.credit }))
      .sort((x, y) => y.credit - x.credit),
    accounts_total: picked.length,
    accounts: picked,
  };
}

/**
 * Qoder 官网采集聚合（Webview 同源 fetch，日 × 模型，31 天零填充）。
 * 口径：名义消耗 original_credits；仅覆盖已采集账号。
 */
export function qoderWebToPoints(r: QoderWebUsage | null): BoardPoint[] {
  if (!r) return [];
  return r.daily.map((d) => {
    const models: BoardPoint['models'] = {};
    for (const m of d.models) models[m.model] = { credits: m.credit, calls: m.request_count };
    return { date: d.date.slice(0, 10), credits: d.usage, models };
  });
}

/** Qoder 区间「获得积分」：快照 earned（签到合计口径，与积分统计 Tab 同源） */
export function qoderEarnedByDate(snaps: QoderCreditsSnapshot[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of snaps) {
    if (s.earned != null && s.earned > 0) m.set(s.date, (m.get(s.date) ?? 0) + s.earned);
  }
  return m;
}

/** Trae 区间「获得积分」：每日快照 earned（积分包 CycleStartTime 归日口径） */
export function traeEarnedByDate(snaps: CreditsDailySnapshot[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of snaps) {
    if (s.earned > 0) m.set(s.date, (m.get(s.date) ?? 0) + s.earned);
  }
  return m;
}

/**
 * Trae 区间「获得积分」按账号筛选（issue #82 问题4-1）：用快照 accounts 维度
 * （uid → 当日获得）对 uid 集求和。老快照行无 accounts 明细 → 该日跳过并计数
 * （skippedDates），调用方在 KPI 口径标注中如实说明，不静默混入全局 earned。
 */
export function traeEarnedByDateFiltered(
  snaps: CreditsDailySnapshot[],
  uids: Set<string>,
): { byDate: Map<string, number>; skippedDates: number } {
  const byDate = new Map<string, number>();
  let skippedDates = 0;
  for (const s of snaps) {
    const acc = s.accounts;
    if (!acc || Object.keys(acc).length === 0) {
      if (s.earned > 0) skippedDates++;
      continue;
    }
    let sum = 0;
    for (const uid of uids) sum += acc[uid] ?? 0;
    if (sum > 0) byDate.set(s.date, (byDate.get(s.date) ?? 0) + sum);
  }
  return { byDate, skippedDates };
}

/** Buddy 区间「获得积分」：签到日志 reward 聚合（§2.2 方案 A 口径，仅含签到新增） */
export function wbCheckinEarnedByDate(recs: WbCheckinRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of recs) {
    const reward = r.reward ?? 0;
    if (reward > 0) m.set(r.date, (m.get(r.date) ?? 0) + reward);
  }
  return m;
}

/**
 * Buddy 区间「获得积分」（§2.2 方案 B 优先口径）：快照 earned（余额差分 + 签到归并）。
 * earned 为 null/缺省（老快照行/未统计）的日期不出现在结果中，由调用方回退方案 A。
 */
export function wbSnapshotEarnedByDate(snaps: WbCreditsSnapshot[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of snaps) {
    if (s.earned != null && s.earned > 0) m.set(s.date, (m.get(s.date) ?? 0) + s.earned);
  }
  return m;
}

/** 两张 earned 映射归并：优先取 b（快照口径），缺失日期回落 a（签到口径） */
export function mergeEarned(
  fallback: Map<string, number>,
  preferred: Map<string, number>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const [d, v] of fallback) m.set(d, v);
  for (const [d, v] of preferred) m.set(d, v);
  return m;
}

/**
 * Buddy 区间「获得积分」按账号筛选（issue #82 问题4-1）：
 * 快照全局 earned 无账号维度不可拆，改为前端逐账号推导——
 * 相邻快照对 uid 集取 balance 正向差分（沿用后端「uid 集在两侧快照不完整/余额缺失
 * 不采信差分」守卫语义），可比日取 max(差分, uid 集签到 reward 合计)（同后端归并），
 * 不可比日回退 uid 集签到口径。
 */
export function wbEarnedByDateFiltered(
  snaps: WbCreditsSnapshot[],
  recs: WbCheckinRecord[],
  uids: Set<string>,
): Map<string, number> {
  const checkinByDate = wbCheckinEarnedByDate(recs.filter((r) => uids.has(r.user_id)));
  const sorted = [...snaps].sort((a, b) => a.date.localeCompare(b.date));
  const balanceOf = (s: WbCreditsSnapshot, uid: string): number | null | undefined => {
    const hit = s.accounts.find((a) => a.user_id === uid);
    return hit ? hit.balance : undefined;
  };
  const m = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    let diff = 0;
    let comparable = true;
    for (const uid of uids) {
      const p = balanceOf(prev, uid);
      const c = balanceOf(cur, uid);
      if (p == null || c == null) {
        comparable = false;
        break;
      }
      diff += c - p;
    }
    if (!comparable) continue;
    const day = cur.date.slice(0, 10);
    const chk = checkinByDate.get(day) ?? 0;
    const earned = Math.max(diff > 0 ? diff : 0, chk);
    if (earned > 0) m.set(day, (m.get(day) ?? 0) + earned);
  }
  // 首日/无前置快照的日期：差分不可得，回退签到口径
  for (const [d, v] of checkinByDate) {
    if (!m.has(d)) m.set(d, v);
  }
  return m;
}

/**
 * Qoder 区间「获得积分」按账号筛选（issue #82 问题4-1）：
 * 快照 earned 全账号合并不可拆，但其源头 = 逐账号签到 reward 合计
 * （tasks/qoder_credits.rs checkin_recharge_today 按 reward 求和）→
 * 直接过滤 qoderCheckin 的 uid 集求 reward，与全局快照同源口径。
 */
export function qoderEarnedByDateFiltered(
  recs: QoderCheckinRecord[],
  uids: Set<string>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of recs) {
    if (!uids.has(r.user_id)) continue;
    const reward = r.reward ?? 0;
    if (reward > 0) m.set(r.date, (m.get(r.date) ?? 0) + reward);
  }
  return m;
}
