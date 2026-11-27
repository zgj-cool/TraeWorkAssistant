import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Users,
  PlayCircle,
  Coins,
  CalendarCheck,
  TrendingUp,
  Settings,
  Server,
  KeyRound,
  SlidersHorizontal,
  Palette,
  Info,
  Sparkles,
  Bot,
  Boxes,
  LayoutGrid,
  Globe,
} from 'lucide-react';
import { useAppStore } from '../store';
import { cn } from '../lib/cn';
import { nextTheme } from '../lib/themes';
import { resolveAppIcon } from '../lib/appIcons';
import { APP_LOGOS } from '../lib/appLogos';
import { getPinnedApp, isAppVisible, getOrderedApps } from '../lib/appVisibility';
import type { AppKey, ViewKey } from '../types';
import AboutDialog from './AboutDialog';
import SystemDialog from './SystemDialog';

export type { ViewKey };

const NAV: { key: ViewKey; label: string; icon: typeof Users }[] = [
  { key: 'dashboard', label: '概览', icon: LayoutDashboard },
  { key: 'accounts', label: '账号管理', icon: Users },
  { key: 'checkin', label: '一键签到', icon: PlayCircle },
  { key: 'credits', label: '积分看板', icon: Coins },
  { key: 'api-service', label: '资源调度', icon: Server },
  { key: 'settings', label: '环境配置', icon: Settings },
];

/** 豆包应用菜单：概述 / 账号管理 / 一键签到 / 额度看板 / 环境配置 */
const DOUBAO_NAV: { key: ViewKey; label: string; icon: typeof Users }[] = [
  { key: 'doubao-overview', label: '概述', icon: LayoutDashboard },
  { key: 'doubao-accounts', label: '账号管理', icon: Users },
  { key: 'doubao-checkin', label: '一键签到', icon: CalendarCheck },
  { key: 'doubao-quota', label: '额度看板', icon: TrendingUp },
  { key: 'doubao-settings', label: '环境配置', icon: Settings },
];

/** Buddy 应用菜单（workbuddy-product-design.md §3.7.0：五页应用级子导航，批次1） */
const BUDDY_NAV: { key: ViewKey; label: string; icon: typeof Users }[] = [
  { key: 'buddy-overview', label: '概述', icon: LayoutDashboard },
  { key: 'buddy-accounts', label: '账号管理', icon: Users },
  { key: 'buddy-checkin', label: '签到与成长', icon: PlayCircle },
  { key: 'buddy-credits', label: '积分看板', icon: Coins },
  { key: 'buddy-api-service', label: '资源调度', icon: Server },
  { key: 'buddy-settings', label: '环境配置', icon: Settings },
];

/** Qoder 应用菜单（F-80：IDE / Work / CLI 三端共用六页子导航，P1 对齐 Buddy） */
const QODER_NAV: { key: ViewKey; label: string; icon: typeof Users }[] = [
  { key: 'qoder-overview', label: '概述', icon: LayoutDashboard },
  { key: 'qoder-accounts', label: '账号管理', icon: Users },
  { key: 'qoder-checkin', label: '每日签到', icon: PlayCircle },
  { key: 'qoder-credits', label: '积分看板', icon: Coins },
  { key: 'qoder-api-service', label: '资源调度', icon: Server },
  { key: 'qoder-settings', label: '环境配置', icon: Settings },
];

/** BuddyAI 应用菜单（buddy-ai 国际版独立池；六页子导航对齐国内 Buddy 产品形态） */
const BUDDYAI_NAV: { key: ViewKey; label: string; icon: typeof Users }[] = [
  { key: 'buddyai-overview', label: '概述', icon: LayoutDashboard },
  { key: 'buddyai-accounts', label: '账号管理', icon: Users },
  { key: 'buddyai-checkin', label: '活跃打卡', icon: PlayCircle },
  { key: 'buddyai-credits', label: '积分看板', icon: Coins },
  { key: 'buddyai-api-service', label: '资源调度', icon: Server },
  { key: 'buddyai-settings', label: '环境配置', icon: Settings },
];

/** 应用切换 Tab：trae = 当前菜单；buddy = 批次1接入；qoder = F-80 接入；doubao = 接入中；
 *  buddy-ai = 国际版独立池（默认隐藏，系统设置-应用显示 opt-in） */
export const APP_TABS: { key: AppKey; label: string; icon: typeof Users; disabled?: boolean; title?: string }[] = [
  { key: 'trae', label: 'Trae', icon: Sparkles },
  { key: 'buddy', label: 'Buddy', icon: Bot, title: 'WorkBuddy / CodeBuddy' },
  { key: 'qoder', label: 'Qoder', icon: Boxes, title: 'Qoder CN（Qoder CN IDE / Qoder CN / CLI）' },
  { key: 'doubao', label: '豆包', icon: LayoutGrid },
  { key: 'buddy-ai', label: 'BuddyAI', icon: Globe, title: 'Buddy 国际版（buddy-ai 独立池）' },
];

/** 全部合法应用 key（settings 脏值兜底用） */
export const APP_KEYS = APP_TABS.map((t) => t.key);

/** 栅格列数必须使用字面量，Tailwind JIT 才能扫描生成（应用 Tab 最多 4 列，>4 个折两行） */
const GRID_COLS = ['grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4'] as const;

export default function Sidebar({
  view,
  onNav,
}: {
  view: ViewKey;
  onNav: (v: ViewKey) => void;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const activeApp = useAppStore((s) => s.activeApp);
  const setActiveApp = useAppStore((s) => s.setActiveApp);
  const setShowApiManager = useAppStore((s) => s.setShowApiManager);
  const settings = useAppStore((s) => s.settings);
  const [showAbout, setShowAbout] = useState(false);
  const [showSystem, setShowSystem] = useState(false);

  // 侧边栏应用显示（系统设置「应用显示」维护）：固定应用始终可见，其余按隐藏列表过滤；
  // 展示顺序跟随系统设置「应用显示」拖拽排序（app_order），未提及应用按默认顺序补尾。
  // 口径统一由 lib/appVisibility 提供（pinned 非法/缺失回退 trae；buddy-ai 不参与固定、
  // 默认隐藏，仅 settings.buddy_ai_visible = true 时显示）
  const pinnedApp = getPinnedApp(settings);
  const visibleTabs = getOrderedApps(settings).flatMap((key) => {
    const tab = APP_TABS.find((t) => t.key === key);
    return tab && isAppVisible(settings, key) ? [tab] : [];
  });

  // 应用 Tab 自适应列数：≤4 个单行铺满；>4 个固定 4 列自动折两行（按顺序排列：5→4+1 / 6→4+2 / 7→4+3 / 8→4+4）
  const tabCols = Math.min(4, Math.max(1, visibleTabs.length));

  // 当前激活应用被隐藏（或固定项变更）时自动回落固定应用主页，避免停留在无 Tab 的应用
  useEffect(() => {
    if (!visibleTabs.some((t) => t.key === activeApp)) {
      // 总览为平台无关视图：仅回落 activeApp，不把 view 重置为应用首页
      if (useAppStore.getState().view === 'overview') useAppStore.setState({ activeApp: pinnedApp });
      else setActiveApp(pinnedApp);
    }
    // 审查修复：补 buddy_ai_visible 依赖——停留在 BuddyAI 应用时关闭其可见性，
    // 回落固定应用须即时触发（否则停留在无 Tab 的应用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeApp, pinnedApp, settings?.hidden_apps, settings?.buddy_ai_visible]);

  // 按当前应用切换菜单：Trae → 现有 6 页；豆包 → 3 页；Buddy → 6 页；Qoder → 6 页（F-80）；BuddyAI → 6 页（国际版对齐 Buddy 产品形态）
  const nav =
    activeApp === 'doubao'
      ? DOUBAO_NAV
      : activeApp === 'buddy'
      ? BUDDY_NAV
      : activeApp === 'qoder'
      ? QODER_NAV
      : activeApp === 'buddy-ai'
      ? BUDDYAI_NAV
      : NAV;

  // 主题轮询：每次点击切换到下一个主题并持久化
  const cycleTheme = async () => {
    const { settings, saveSettings } = useAppStore.getState();
    if (!settings) return;
    const next = nextTheme(settings.theme);
    try {
      // 审查修复（L34）：saveSettings 即 patch 语义，只提交 theme 字段，不回传整份 settings 快照（patch 纪律）
      await saveSettings({ theme: next.id });
      pushToast('success', `主题已切换：${next.name}`);
    } catch {
      /* toast 已发出 */
    }
  };

  return (
    <aside className="app-sidebar sticky left-0 z-10 flex w-52 shrink-0 flex-col border-r border-slate-200/70 bg-white dark:border-zinc-800/70 dark:bg-zinc-900/30">
      <nav className="flex-1 space-y-0.5 p-3">
        {/* 跨平台总览：常驻顶部，不随应用 Tab 切换 */}
        <NavButton
          active={view === 'overview'}
          icon={LayoutDashboard}
          label="总览"
          onClick={() => onNav('overview')}
          title="Trae / Buddy / Qoder / 豆包 一屏总览"
        />
        <div className="!my-2 border-t border-slate-200/70 dark:border-zinc-800" />
        {nav.map((item) => (
          <NavButton
            key={item.key}
            active={view === item.key}
            icon={item.icon}
            label={item.label}
            onClick={() => onNav(item.key)}
          />
        ))}
      </nav>
      {/* 应用切换 Tab（位于左下角工具图标行上方；显示项由系统设置「应用显示」控制） */}
      <div className="border-t border-slate-200/70 p-3 dark:border-zinc-800/70">
        <div
          className={cn(
            'app-tabbar grid gap-1 rounded-[10px] bg-slate-100/80 p-1 dark:bg-zinc-800/50',
            GRID_COLS[tabCols - 1] ?? 'grid-cols-4',
          )}
        >
          {visibleTabs.map((tab) => {
            // 自定义图标优先（系统设置「应用图标」），非法/缺失回退官方 logo
            const CustomIcon = resolveAppIcon(settings?.app_icons?.[tab.key]);
            const active = activeApp === tab.key;
            return (
              <button
                key={tab.key}
                disabled={tab.disabled}
                onClick={() => setActiveApp(tab.key)}
                title={tab.title ?? tab.label}
                data-tab-active={active || undefined}
                className={cn(
                  'flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[11px] font-medium transition active:scale-[0.97]',
                  tab.disabled && 'cursor-not-allowed opacity-40',
                  active
                    ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:bg-zinc-700/80 dark:text-white'
                    : 'text-slate-500 hover:text-slate-800 dark:text-zinc-500 dark:hover:text-zinc-300',
                )}
              >
                {CustomIcon ? (
                  <CustomIcon size={15} />
                ) : (
                  <img
                    src={APP_LOGOS[tab.key]}
                    alt={`${tab.label} logo`}
                    className="h-4 w-4 rounded-[3px] object-contain"
                    draggable={false}
                  />
                )}
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center justify-center gap-1 border-t border-slate-200/70 p-3 dark:border-zinc-800/70">
        {/* API 管理入口（统一网关 §5.1，原 Github 图标位置） */}
        <button
          onClick={() => setShowApiManager(true)}
          className={footerBtn}
          aria-label="API 管理"
          title="API 管理（统一网关：启停 / 接口配置 / API Keys / 生态接入 / 用量统计）"
        >
          <KeyRound size={17} />
        </button>
        <button
          onClick={() => setShowSystem(true)}
          className={footerBtn}
          aria-label="系统设置与系统日志查看"
          title="系统设置与系统日志查看"
        >
          <SlidersHorizontal size={17} />
        </button>
        <button
          onClick={() => void cycleTheme()}
          className={footerBtn}
          aria-label="切换主题"
          title="切换主题（在所有主题间轮询）"
        >
          <Palette size={17} />
        </button>
        <button
          onClick={() => setShowAbout(true)}
          className={footerBtn}
          aria-label="软件说明"
          title="软件说明（版本 / 概述 / 作者 / 版权）"
        >
          <Info size={17} />
        </button>
      </div>
      <AboutDialog open={showAbout} onClose={() => setShowAbout(false)} />
      <SystemDialog open={showSystem} onClose={() => setShowSystem(false)} />
    </aside>
  );
}

const footerBtn =
  'flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 active:bg-slate-200/70 dark:text-zinc-500 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200';

/** 侧栏导航项：弱化底色的选中态 + 左侧极短强调条（替代整块黑底，降低视觉重量） */
function NavButton({
  active,
  icon: Icon,
  label,
  onClick,
  title,
}: {
  active: boolean;
  icon: typeof Users;
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      data-nav-active={active || undefined}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-[10px] py-2 pl-3.5 pr-3 text-[13px] font-medium transition-colors',
        active
          ? 'bg-slate-100 text-slate-900 dark:bg-zinc-800/70 dark:text-zinc-50'
          : 'text-slate-500 hover:bg-slate-100/60 hover:text-slate-800 dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200',
      )}
    >
      {active && (
        <span className="nav-indicator absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-zinc-900 dark:bg-zinc-100" />
      )}
      <Icon size={16} />
      {label}
    </button>
  );
}
