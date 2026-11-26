import { listen } from '@tauri-apps/api/event';
import { api } from './tauri';
import type { QoderWebUsageAccount } from '../types';

export interface QoderWebSyncFailure {
  account_id: string;
  name: string;
  message?: string;
}

export interface QoderWebSyncResult {
  total: number;
  ok: number;
  failed: QoderWebSyncFailure[];
}

/**
 * 对「已采集账号」逐个静默重采官网用量：
 * - 后端用隐藏窗口 + 已持久化的登录态（cookie 注入），无需用户重新登录；
 * - 串行执行（后端采集窗口 label 唯一，同时只能跑一个）；
 * - 结果按 account_id 匹配 `qoder-web-collect-done` 事件。
 *
 * 总览页与积分看板的「刷新」共用（保证两处行为一致）。
 */
export async function syncQoderWebAccounts(
  accounts: QoderWebUsageAccount[],
): Promise<QoderWebSyncResult> {
  const result: QoderWebSyncResult = { total: accounts.length, ok: 0, failed: [] };
  if (accounts.length === 0) return result;

  const pending = new Map<string, (p: { ok: boolean; message?: string }) => void>();
  const unlisten = await listen<{ ok: boolean; account_id?: string; message?: string }>(
    'qoder-web-collect-done',
    (e) => {
      const id = e.payload.account_id ?? '';
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(e.payload);
      }
    },
  );

  try {
    for (const a of accounts) {
      const wait = new Promise<{ ok: boolean; message?: string }>((resolve) => {
        pending.set(a.account_id, resolve);
        // 后端静默采集预算 90s，本地多等 10s 兜底
        window.setTimeout(() => {
          const fn = pending.get(a.account_id);
          if (fn) {
            pending.delete(a.account_id);
            fn({ ok: false, message: '采集超时（未收到结果）' });
          }
        }, 100_000);
      });
      try {
        await api.qoder.webCollect(a.account_id, true);
        const r = await wait;
        if (r.ok) result.ok += 1;
        else result.failed.push({ account_id: a.account_id, name: a.account_name || a.account_id, message: r.message });
      } catch (err) {
        pending.delete(a.account_id);
        result.failed.push({
          account_id: a.account_id,
          name: a.account_name || a.account_id,
          message: String(err),
        });
      }
    }
  } finally {
    unlisten();
  }
  return result;
}