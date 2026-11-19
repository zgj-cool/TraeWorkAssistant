import { describe, expect, it } from 'vitest';
import {
  aggregateKpis,
  buildOverview,
  summarizeBuddy,
  summarizeQoder,
  summarizeTrae,
  type OverviewData,
} from './overviewModel';
import type {
  AccountView,
  QoderAccountView,
  QoderCreditsResult,
  UsageHistoryResult,
  WbCreditsResult,
  WbUsageFallback,
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
    wbUsage: null,
    qoderAccounts: [],
    qoderCredits: null,
    qoderWebUsage: null,
    qoderCheckin: [],
    qoderSnapshots: [],
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
  it('今日已用优先取官网用量，官网失败回退本地快照', () => {
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
    const fallback = {
      summary: { usage_today: 7.2, usage_7days: 38, usage_this_month: 88 },
    } as WbUsageFallback;

    const withOfficial = summarizeBuddy(
      accounts,
      credits,
      [{ date: '2026-11-19', user_id: 'b1', status: 'success' }] as never,
      official,
      fallback,
      NOW,
    );
    expect(withOfficial.usedToday).toBe(9.8);
    expect(withOfficial.notes[0]).toContain('官网');

    const withoutOfficial = summarizeBuddy(
      accounts,
      credits,
      [],
      null,
      fallback,
      NOW,
    );
    expect(withoutOfficial.usedToday).toBe(7.2);
    expect(withoutOfficial.notes[0]).toContain('回退本地快照');
    expect(withOfficial.available).toBe(100);
    expect(withOfficial.expiringIn7d).toBe(30);
    expect(withOfficial.checkedToday).toBe(1);
    expect(withOfficial.alertAccounts).toBe(2);
    expect(withOfficial.expiringDetails).toHaveLength(1);
    expect(withOfficial.expiringDetails[0].credits).toBe(30);
  });
});

describe('summarizeQoder 与汇总', () => {
  it('Qoder 今日已用取本地快照，consumed=null 显示缺失，逐包到期按日期求和', () => {
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
    const s = summarizeQoder(
      accounts,
      credits,
      [],
      [{ date: '2026-11-19', consumed: null, total_balance: 200, ts: 0, accounts: [] }],
      null,
      NOW,
    );
    expect(s.available).toBe(200);
    expect(s.usedToday).toBeNull();
    expect(s.expiringIn7d).toBe(40);
    expect(s.expiringDetails).toHaveLength(1);
    expect(s.expiringDetails[0].credits).toBe(40);
    expect(s.notes[0]).toContain('本地');
  });

  it('Qoder 官网会话可用时今日已用优先官方明细，失败回退快照', () => {
    const official = summarizeQoder(
      [],
      null,
      [],
      [{ date: '2026-11-19', consumed: 3, total_balance: 10, ts: 0, accounts: [] }],
      { ok: true, used_today: 21.5, billed_today: 5, source: 'official_web_cookie' },
      NOW,
    );
    expect(official.usedToday).toBe(21.5);
    expect(official.notes[0]).toContain('官网会话');

    const failed = summarizeQoder(
      [],
      null,
      [],
      [{ date: '2026-11-19', consumed: 3, total_balance: 10, ts: 0, accounts: [] }],
      { ok: false, used_today: null, error: '未读取到 Cookie' },
      NOW,
    );
    expect(failed.usedToday).toBe(3);
    expect(failed.notes[0]).toContain('回退');
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
