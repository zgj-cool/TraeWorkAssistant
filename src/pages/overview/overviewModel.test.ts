import { describe, expect, it } from 'vitest';
import {
  aggregateKpis,
  buildOverview,
  summarizeBuddy,
  summarizeCreditUsage,
  summarizeGatewayTokens,
  qoderUsedByUid,
  summarizeQoder,
  summarizeTrae,
  type OverviewData,
} from './overviewModel';
import type {
  AccountView,
  QoderAccountView,
  QoderCreditsResult,
  QoderWebUsage,
  UsageDayView,
  UsageHistoryResult,
  WbCreditsResult,
  WbUsageOfficialAll,
  WorkBuddyAccountView,
} from '../../types';

const NOW = new Date('2026-11-19T12:00:00').getTime();
const NOW_SEC = Math.floor(NOW / 1000);
const DAY = 86_400;

function emptyData(): OverviewData {
  return {
    traeAccounts: [],
    traeUsage: null,
    wbAccounts: [],
    wbCredits: null,
    wbCheckin: [],
    wbOfficial: null,
    qoderAccounts: [],
    qoderCredits: null,
    qoderCheckin: [],
    nowMs: NOW,
  };
}

describe('summarizeTrae', () => {
  it('按逐包口径统计 7 天到期积分，今日已用取官网消耗明细', () => {
    const accounts = [
      {
        user_id: 'u1',
        name: '账号一',
        remaining_credits: 300,
        checked_today: true,
        jwt_exp_hours: 12,
        credit_packs: [
          { remaining: 100, expire_time: NOW_SEC + 2 * DAY, total: 100, kind: '通用', source: '签到' },
          { remaining: 200, expire_time: 4102444800, total: 200, kind: '通用', source: '长期' },
        ],
      },
      {
        user_id: 'u2',
        name: '账号二',
        remaining_credits: 50,
        checked_today: false,
        jwt_exp_hours: null,
        refresh_token_invalid: true,
        credit_packs: [],
      },
    ] as AccountView[];
    const usage = {
      cached: false,
      accounts: [
        {
          user_id: 'u1',
          daily: [
            { date: '2026-11-18', credits: 99 },
            { date: '2026-11-19', credits: 12.345 },
          ],
        },
        { user_id: 'u2', daily: [{ date: '2026-11-19', credits: 7.65 }] },
      ],
    } as UsageHistoryResult;

    const s = summarizeTrae(accounts, usage, NOW);
    expect(s.accounts).toBe(2);
    expect(s.checkedToday).toBe(1);
    expect(s.available).toBe(350);
    expect(s.usedToday).toBe(20);
    expect(s.expiringIn7d).toBe(100);
    expect(s.alertAccounts).toBe(2);
    expect(s.notes[0]).toContain('官网');
    expect(s.alerts.map((a) => a.reason)).toEqual(['凭证 24h 内到期', '需重新 OAuth 登录']);
    expect(s.expiringDetails).toHaveLength(1);
    expect(s.expiringDetails[0].credits).toBe(100);
  });

  it('官网明细缺失时今日已用为 null，不用本地快照兜底', () => {
    const accounts = [
      { user_id: 'u1', name: '老账号', remaining_credits: 80, credits_expire_at: NOW_SEC + DAY },
    ] as AccountView[];
    const s = summarizeTrae(accounts, null, NOW);
    expect(s.usedToday).toBeNull();
    expect(s.expiringIn7d).toBeNull();
    expect(s.notes[0]).toContain('暂无数据');
  });
});

describe('summarizeBuddy', () => {
  it('今日已用只取官网用量；官网缺失为 null，不回退本地快照', () => {
    const accounts = [
      { id: 'b1', nickname: 'Buddy甲', credits_balance: 120, needs_relogin: true, access_token_expires_at: null },
      { id: 'b2', nickname: 'Buddy乙', credits_balance: 80, needs_relogin: false, access_token_expires_at: NOW_SEC + 10 },
    ] as WorkBuddyAccountView[];
    const credits = {
      ok: false,
      accounts: [
        {
          user_id: 'b1',
          name: 'Buddy甲',
          ok: true,
          balance: 100,
          packages: [
            { remaining: 30, expire_ts: NOW_SEC + 3 * DAY, name: '活动包', total: 30, used: 0, end_time: null },
            { remaining: 70, expire_ts: NOW_SEC + 30 * DAY, name: '月包', total: 70, used: 0, end_time: null },
          ],
        },
      ],
    } as WbCreditsResult;
    const official = {
      summary: { usage_today: 9.8, usage_7days: 40, usage_this_month: 90 },
      daily: [],
    } as unknown as WbUsageOfficialAll;

    const withOfficial = summarizeBuddy(
      accounts,
      credits,
      [{ date: '2026-11-19', user_id: 'b1', status: 'success' }] as never,
      official,
      NOW,
    );
    expect(withOfficial.usedToday).toBe(9.8);
    expect(withOfficial.notes[0]).toContain('官网');

    // 官网缺失：显示「—」，不回退本地快照/网关
    const withoutOfficial = summarizeBuddy(accounts, credits, [], null, NOW);
    expect(withoutOfficial.usedToday).toBeNull();
    expect(withoutOfficial.notes[0]).toContain('不回退');
    expect(withOfficial.available).toBe(100);
    expect(withOfficial.expiringIn7d).toBe(30);
    expect(withOfficial.checkedToday).toBe(1);
    expect(withOfficial.alertAccounts).toBe(2);
    expect(withOfficial.expiringDetails).toHaveLength(1);
    expect(withOfficial.expiringDetails[0].credits).toBe(30);
  });
});

describe('qoderUsedByUid 官网采集口径', () => {
  const webAccount = (id: string, name: string, todayUsage: number) => ({
    account_id: id,
    account_name: name,
    fetched_at_ms: 0,
    range_start: '2026-11-19',
    range_end: '2026-11-19',
    records_total: 1,
    billed_total: todayUsage,
    summary: { usage_today: todayUsage, usage_7days: todayUsage, usage_this_month: todayUsage },
  });
  const webUsage = (accounts: ReturnType<typeof webAccount>[], todayUsage: number) =>
    ({
      status: 'complete',
      source: 'official_web',
      fetched_at_ms: 0,
      range_start: '2026-11-19',
      range_end: '2026-11-19',
      records_total: accounts.length,
      billed_total: todayUsage,
      summary: { usage_today: todayUsage, usage_7days: todayUsage, usage_this_month: todayUsage },
      daily: [],
      models: [],
      accounts_total: accounts.length,
      accounts,
    }) as QoderWebUsage;

  it('只认官网采集：未采集账号不计入，网关与快照不参与', () => {
    const data = emptyData();
    const today = '2026-11-19';
    data.qoderAccounts = [
      { id: 'q1', nickname: '甲' },
      { id: 'q2', nickname: '乙' },
    ] as QoderAccountView[];
    data.qoderWeb = webUsage([webAccount('q1', '甲', 10)], 10);
    // 网关/签到即便有数据也不应参与消耗口径
    data.gwUsage = {
      qoder: [
        {
          date: today,
          credits: 99,
          total_requests: 0,
          ok: 0,
          errors: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          models: [],
          accounts: [{ name: 'q2', credits: 99 }],
        } as any,
      ],
    };

    const used = qoderUsedByUid(data);
    expect([...used.keys()]).toEqual(['q1']);
    expect(used.get('q1')).toEqual({ credits: 10, source: '官网采集（逐账号）' });

    const view = buildOverview(data);
    const qoder = view.platforms.find((p) => p.key === 'qoder')!;
    expect(qoder.usedToday).toBe(10);
    expect(qoder.notes[0]).toContain('官网采集');
    expect(qoder.notes[0]).toContain('1/2');
    const rows = view.credits.rows.filter((r) => r.platform === 'qoder');
    expect(rows.find((r) => r.uid === 'q1')?.credits).toBe(10);
    expect(rows.find((r) => r.uid === 'q2')?.credits).toBeNull();
    expect(rows.find((r) => r.uid === 'q2')?.source).toContain('官网未采集该账号');
    expect(view.credits.total).toBe(10);
  });

  it('未采集任何账号时 KPI 为 null、明细为空态，不回退网关/快照', () => {
    const data = emptyData();
    data.qoderAccounts = [{ id: 'q1', nickname: '甲' }] as QoderAccountView[];
    data.gwUsage = {
      qoder: [{ date: '2026-11-19', credits: 30 } as any],
    };

    const view = buildOverview(data);
    const qoder = view.platforms.find((p) => p.key === 'qoder')!;
    expect(qoder.usedToday).toBeNull();
    expect(qoder.notes[0]).toContain('不回退');
    expect(view.credits.rows.find((r) => r.platform === 'qoder')?.credits).toBeNull();
    expect(view.credits.total).toBeNull();
  });
});

describe('summarizeQoder 与汇总', () => {
  it('Qoder 官网采集缺失时今日已用为 null，逐包到期按日期求和', () => {
    const accounts = [{ id: 'q1', nickname: 'Qoder甲', credits_balance: 999, needs_relogin: false }] as QoderAccountView[];
    const credits = {
      ok: true,
      accounts: [
        {
          user_id: 'q1',
          name: 'Qoder甲',
          ok: true,
          total: 200,
          plan_credits: 100,
          addon_credits: 100,
          packages: [
            { amount: 40, expire_at: '2026-11-21', source: 'bonus' },
            { amount: 160, expire_at: '2026-12-21', source: 'plan' },
          ],
        },
      ],
    } as QoderCreditsResult;
    const s = summarizeQoder(accounts, credits, [], null, NOW);
    expect(s.available).toBe(200);
    expect(s.usedToday).toBeNull();
    expect(s.expiringIn7d).toBe(40);
    expect(s.expiringDetails).toHaveLength(1);
    expect(s.expiringDetails[0].credits).toBe(40);
    expect(s.notes[0]).toContain('不回退');
  });

  it('Qoder 到期 = 窗口内积分包 + 明细未含 plan 包时的订阅额度（口径与积分看板一致）', () => {
    const base = {
      user_id: 'q1',
      name: 'Qoder甲',
      ok: true,
      total: 1440,
      plan_used: 0,
      plan_expires_at: '2026-11-23',
      source: 'pat',
    };
    // 明细只有资源包（无 plan 源）→ 订阅额度按 plan_credits 全额补入
    const withBonus = summarizeQoder(
      [],
      {
        ok: true,
        accounts: [
          {
            ...base,
            plan_credits: 440,
            packages: [{ amount: 1000, expire_at: '2026-11-21', source: 'bonus' }],
          },
        ],
      } as QoderCreditsResult,
      [],
      null,
      NOW,
    );
    expect(withBonus.expiringIn7d).toBe(1440);
    expect(withBonus.expiringDetails.map((d) => d.credits)).toEqual([1000, 440]);

    // 明细已含 plan 包 → 不重复补订阅额度（避免翻倍）
    const withPlanPkg = summarizeQoder(
      [],
      {
        ok: true,
        accounts: [
          {
            ...base,
            plan_credits: 440,
            packages: [
              { amount: 1000, expire_at: '2026-11-21', source: 'bonus' },
              { amount: 440, expire_at: '2026-11-23', source: 'plan' },
            ],
          },
        ],
      } as QoderCreditsResult,
      [],
      null,
      NOW,
    );
    expect(withPlanPkg.expiringIn7d).toBe(1440);
    expect(withPlanPkg.expiringDetails).toHaveLength(1);
  });

  it('Qoder 消耗取官网采集：今日已用与逐账号明细同源', () => {
    const accounts = [
      { id: 'q1', nickname: 'Qoder甲' },
      { id: 'q2', nickname: 'Qoder乙' },
    ] as QoderAccountView[];
    const web = {
      status: 'complete',
      source: 'official_web',
      fetched_at_ms: 0,
      range_start: '2026-11-19',
      range_end: '2026-11-19',
      records_total: 3,
      billed_total: 18,
      summary: { usage_today: 18, usage_7days: 18, usage_this_month: 18 },
      daily: [],
      models: [],
      accounts_total: 2,
      accounts: [
        {
          account_id: 'q1',
          account_name: 'Qoder甲',
          fetched_at_ms: 0,
          range_start: '2026-11-19',
          range_end: '2026-11-19',
          records_total: 2,
          billed_total: 12,
          summary: { usage_today: 12, usage_7days: 12, usage_this_month: 12 },
        },
        {
          account_id: 'q2',
          account_name: 'Qoder乙',
          fetched_at_ms: 0,
          range_start: '2026-11-19',
          range_end: '2026-11-19',
          records_total: 1,
          billed_total: 6,
          summary: { usage_today: 6, usage_7days: 6, usage_this_month: 6 },
        },
      ],
    } as QoderWebUsage;

    const summary = summarizeQoder(accounts, null, [], web, NOW);
    expect(summary.usedToday).toBe(18);
    expect(summary.notes[0]).toContain('官网采集');

    const usage = summarizeCreditUsage({ ...emptyData(), qoderAccounts: accounts, qoderWeb: web }, NOW);
    const qoderRows = usage.rows.filter((r) => r.platform === 'qoder');
    expect(qoderRows.map((r) => [r.name, r.credits])).toEqual([
      ['Qoder甲', 12],
      ['Qoder乙', 6],
    ]);
    expect(qoderRows.every((r) => r.source === '官网采集（逐账号）')).toBe(true);
    expect(usage.total).toBe(18);
  });

  it('总览只输出三平台，汇总按三平台求和且缺失不臆造为 0', () => {
    const data = emptyData();
    data.traeAccounts = [{ user_id: 't1', name: 'T', remaining_credits: 10 }] as AccountView[];
    data.traeUsage = {
      cached: false,
      accounts: [{ user_id: 't1', daily: [{ date: '2026-11-19', credits: 5 }] }],
    } as UsageHistoryResult;
    const { platforms, kpis } = buildOverview(data);
    expect(platforms.map((p) => p.key)).toEqual(['trae', 'buddy', 'qoder']);
    expect(kpis.available).toBe(10);
    expect(kpis.usedToday).toBe(5);
    expect(kpis.accounts).toBe(1);
    expect(kpis.alerts).toBe(0);

    const empty = aggregateKpis([
      { key: 'trae', accounts: 0, checkedToday: 0, available: null, usedToday: null, expiringIn7d: null, alertAccounts: 0, alerts: [], expiringDetails: [], notes: [] },
    ]);
    expect(empty.available).toBeNull();
    expect(empty.usedToday).toBeNull();
    expect(empty.expiringIn7d).toBeNull();
  });
});

describe('summarizeCreditUsage', () => {
  it('Trae/Buddy 取逐账号官网口径、Qoder 取官网采集，按消耗降序', () => {
    const data = emptyData();
    data.traeAccounts = [{ user_id: 't1', name: 'Trae甲' }] as AccountView[];
    data.traeUsage = {
      cached: false,
      accounts: [{ user_id: 't1', daily: [{ date: '2026-11-19', credits: 12.5 }] }],
    } as UsageHistoryResult;
    data.wbAccounts = [{ id: 'b1', nickname: 'Buddy甲' }] as WorkBuddyAccountView[];
    data.wbOfficial = {
      summary: { usage_today: 8, usage_7days: 8, usage_this_month: 8 },
      daily: [],
      accounts: [
        { user_id: 'b1', name: 'Buddy甲', usage_today: 8, usage_7days: 8, usage_this_month: 8 },
      ],
    } as unknown as WbUsageOfficialAll;
    data.qoderAccounts = [{ id: 'q1', nickname: 'Qoder甲' }] as QoderAccountView[];
    data.qoderWeb = {
      status: 'complete',
      source: 'official_web',
      fetched_at_ms: 0,
      range_start: '2026-11-19',
      range_end: '2026-11-19',
      records_total: 1,
      billed_total: 10,
      summary: { usage_today: 10, usage_7days: 10, usage_this_month: 10 },
      daily: [],
      models: [],
      accounts_total: 1,
      accounts: [
        {
          account_id: 'q1',
          account_name: 'Qoder甲',
          fetched_at_ms: 0,
          range_start: '2026-11-19',
          range_end: '2026-11-19',
          records_total: 1,
          billed_total: 10,
          summary: { usage_today: 10, usage_7days: 10, usage_this_month: 10 },
        },
      ],
    } as QoderWebUsage;

    const s = summarizeCreditUsage(data, NOW);
    expect(s.accounts).toBe(3);
    expect(s.withData).toBe(3);
    expect(s.total).toBe(30.5);
    expect(s.rows.map((r) => [r.platform, r.name, r.credits])).toEqual([
      ['trae', 'Trae甲', 12.5],
      ['qoder', 'Qoder甲', 10],
      ['buddy', 'Buddy甲', 8],
    ]);
  });

  it('无账号级数据时列出账号但 credits=null，合计为 null', () => {
    const data = emptyData();
    data.traeAccounts = [{ user_id: 't1', name: 'Trae甲' }] as AccountView[];
    data.wbAccounts = [{ id: 'b1', nickname: 'Buddy甲' }] as WorkBuddyAccountView[];
    data.qoderAccounts = [{ id: 'q1', nickname: 'Qoder甲' }] as QoderAccountView[];

    const s = summarizeCreditUsage(data, NOW);
    expect(s.accounts).toBe(3);
    expect(s.withData).toBe(0);
    expect(s.total).toBeNull();
    expect(s.rows.every((r) => r.credits === null)).toBe(true);
    // 缺失原因逐行给出，便于区分「未加载 / 无明细 / 未采集」
    expect(s.rows.find((r) => r.platform === 'trae')?.source).toContain('未加载');
    expect(s.rows.find((r) => r.platform === 'qoder')?.source).toContain('官网');
  });
});

describe('summarizeGatewayTokens', () => {
  const day = (prompt: number, completion: number, accounts: { name: string; p: number; c: number }[]) =>
    ({
      date: '2026-11-19',
      prompt_tokens: prompt,
      completion_tokens: completion,
      account_tokens: accounts.map((a) => ({
        name: a.name,
        prompt_tokens: a.p,
        completion_tokens: a.c,
      })),
    }) as UsageDayView;

  it('只统计三平台池：合计取单日统计，明细按账号解析名称并按合计降序、按池归组', () => {
    const data = emptyData();
    data.traeAccounts = [{ user_id: 't1', name: 'Trae甲' }] as AccountView[];
    data.wbAccounts = [{ id: 'b1', nickname: 'Buddy甲' }] as WorkBuddyAccountView[];
    data.gwUsage = {
      trae: [day(100, 50, [{ name: 't1', p: 100, c: 50 }])],
      buddy: [day(900, 10, [{ name: 'b1', p: 900, c: 10 }])],
      // 自定义 / BuddyAI 不属于三平台面板，不计入总览
      custom: [day(7, 3, [{ name: 'custom', p: 7, c: 3 }])],
      'buddy-ai': [day(5, 5, [{ name: 'b1', p: 5, c: 5 }])],
      qoder: null,
    };

    const t = summarizeGatewayTokens(data, NOW);
    expect(t.total).toBe(1060);
    expect(t.prompt).toBe(1000);
    expect(t.completion).toBe(60);
    expect(t.accounts).toBe(2);
    expect(t.rows.map((r) => [r.pool, r.name, r.total_tokens])).toEqual([
      ['buddy', 'Buddy甲', 910],
      ['trae', 'Trae甲', 150],
    ]);
    expect(t.byPlatform.trae.total).toBe(150);
    expect(t.byPlatform.buddy.total).toBe(910);
    expect(t.byPlatform.trae.rows).toHaveLength(1);
    // 无当日条目的池为 null，不与 0 混淆
    expect(t.byPlatform.qoder.total).toBeNull();
    expect(t.byPlatform.qoder.rows).toEqual([]);
  });

  it('无数据源或无当日条目返回 null，不用其它日期冒充', () => {
    const data = emptyData();
    data.gwUsage = {
      // 桶内有 18 日数据但今日无条目 → 不参与统计
      trae: [
        { date: '2026-11-18', prompt_tokens: 9, completion_tokens: 1, account_tokens: [] } as unknown as UsageDayView,
      ],
      buddy: [],
      qoder: null,
    };
    const t = summarizeGatewayTokens(data, NOW);
    expect(t.total).toBeNull();
    expect(t.rows).toEqual([]);
    expect(t.byPlatform.trae.total).toBeNull();
  });
});
