import { APP_HOME_VIEW, type AppKey, type ViewKey } from '../types';

/**
 * 应用内功能页类型：切换侧边栏应用 Tab 时按此保持「同一功能页」，
 * 不再一律重置到目标应用首页（如 Trae 积分看板 ⇄ Buddy 积分看板）。
 */
export type AppPageKind = 'overview' | 'accounts' | 'checkin' | 'credits' | 'api' | 'settings';

/** 各应用「功能页类型 → 视图」映射（缺失 = 该应用没有对应功能页，切换时回落首页） */
const APP_PAGE_VIEWS: Record<AppKey, Partial<Record<AppPageKind, ViewKey>>> = {
  trae: {
    overview: 'dashboard',
    accounts: 'accounts',
    checkin: 'checkin',
    credits: 'credits',
    api: 'api-service',
    settings: 'settings',
  },
  doubao: {
    overview: 'doubao-overview',
    accounts: 'doubao-accounts',
    checkin: 'doubao-checkin',
    // 豆包额度看板与三平台积分看板同属「统计看板」功能页
    credits: 'doubao-quota',
    settings: 'doubao-settings',
  },
  buddy: {
    overview: 'buddy-overview',
    accounts: 'buddy-accounts',
    checkin: 'buddy-checkin',
    credits: 'buddy-credits',
    api: 'buddy-api-service',
    settings: 'buddy-settings',
  },
  qoder: {
    overview: 'qoder-overview',
    accounts: 'qoder-accounts',
    checkin: 'qoder-checkin',
    credits: 'qoder-credits',
    api: 'qoder-api-service',
    settings: 'qoder-settings',
  },
  'buddy-ai': {
    overview: 'buddyai-overview',
    accounts: 'buddyai-accounts',
    checkin: 'buddyai-checkin',
    credits: 'buddyai-credits',
    api: 'buddyai-api-service',
    settings: 'buddyai-settings',
  },
};

/** 视图 → 功能页类型（由 APP_PAGE_VIEWS 反查；跨平台总览单独登记） */
const VIEW_PAGE_KIND: Partial<Record<ViewKey, AppPageKind>> = (() => {
  const map: Partial<Record<ViewKey, AppPageKind>> = { overview: 'overview' };
  for (const views of Object.values(APP_PAGE_VIEWS)) {
    for (const [kind, view] of Object.entries(views) as [AppPageKind, ViewKey][]) {
      map[view] = kind;
    }
  }
  return map;
})();

/**
 * 切换应用 Tab 的目标视图：保持当前功能页；当前视图无功能页归属
 * （如 logs）或目标应用缺少该功能页时，回落目标应用首页。
 */
export function resolveAppSwitchView(current: ViewKey, target: AppKey): ViewKey {
  const kind = VIEW_PAGE_KIND[current];
  if (!kind) return APP_HOME_VIEW[target];
  return APP_PAGE_VIEWS[target][kind] ?? APP_HOME_VIEW[target];
}
