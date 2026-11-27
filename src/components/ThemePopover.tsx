import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Monitor } from 'lucide-react';
import { useAppStore } from '../store';
import { cn } from '../lib/cn';
import { THEMES } from '../lib/themes';

/**
 * 主题气泡（侧栏调色盘按钮弹出）。
 *
 * 设计取舍：
 * - 点选即生效并持久化，没有「确定」按钮——主题切换是高频、可逆、视觉即时可见的
 *   操作，多一步确认只会增加摩擦。系统设置里的保存条不再承载主题，避免同一状态有
 *   两处入口且一处要保存一处不用。
 * - 每项带三格色卡（底 / 面 / 强调）而不是纯文字：主题名（如「荧光墨绿」）描述不出
 *   最终观感，色卡能让人一眼选完，不用逐个试。
 * - 用 portal 挂到 body：侧栏一旦带 filter / backdrop-filter / transform 就会成为
 *   fixed 后代的包含块，气泡会被挤进 208px 的侧栏里。
 * - 位置按按钮的 getBoundingClientRect 反向计算，向上展开（按钮贴在窗口底部）。
 */
export default function ThemePopover({
  anchor,
  anchorEl,
  onClose,
}: {
  /** 触发按钮的矩形；气泡据此向上、向右对齐 */
  anchor: DOMRect;
  /** 触发按钮本身：外部点击判定需要排除它，否则会与按钮的 toggle 打架 */
  anchorEl?: HTMLElement | null;
  onClose: () => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const toast = useAppStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 当前值：'system' 或具体主题 id
  const current = settings?.theme ?? 'system';

  // 点外部 / 按 Esc 关闭。
  // 必须排除触发按钮本身（anchorEl）：按钮用的是 onClick，而这里监听 mousedown——
  // 点击按钮时 mousedown 先到，若把它当「外部点击」关掉，紧接着的 click 又会重新
  // 打开，表现为「点两下 = 重复打开、永远关不掉」。把按钮排除后，那次 mousedown
  // 被忽略，click 里的 toggle 才能正常收起。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchorEl?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, anchorEl]);

  const pick = async (id: string, name: string) => {
    if (busy || id === current) {
      if (id === current) onClose();
      return;
    }
    setBusy(true);
    try {
      await saveSettings({ theme: id });
      toast('success', `主题已切换：${name}`);
      onClose();
    } catch {
      /* toast 已发出 */
    } finally {
      setBusy(false);
    }
  };

  // 向上展开、与按钮右边缘对齐；左右做视口夹取防止溢出
  const width = 232;
  const gap = 8;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
  const bottom = window.innerHeight - anchor.top + gap;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="选择主题"
      className="theme-pop fixed z-[70] w-[232px] rounded-xl border border-slate-200/80 p-1.5 shadow-soft-lg backdrop-blur-xl animate-pop-in dark:border-zinc-700/70"
      style={{ left, bottom, width }}
    >
      <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-slate-400 dark:text-zinc-500">
        主题
      </div>
      <div className="flex flex-col gap-0.5">
        {/* 跟随系统 */}
        <button
          onClick={() => void pick('system', '跟随系统')}
          className={cn(
            'flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors',
            current === 'system'
              ? 'bg-slate-100 font-medium text-slate-900 dark:bg-zinc-800 dark:text-zinc-50'
              : 'text-slate-600 hover:bg-slate-100/70 dark:text-zinc-300 dark:hover:bg-zinc-800/60',
          )}
        >
          <Monitor size={14} className="shrink-0 opacity-70" />
          <span className="flex-1">跟随系统</span>
          {current === 'system' && <Check size={13} className="shrink-0 text-emerald-500" />}
        </button>

        <div className="my-1 border-t border-slate-200/70 dark:border-zinc-700/60" />

        {THEMES.map((t) => {
          const active = current === t.id;
          return (
            <button
              key={t.id}
              onClick={() => void pick(t.id, t.name)}
              disabled={busy}
              aria-current={active || undefined}
              className={cn(
                'group flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors disabled:opacity-60',
                active
                  ? 'bg-slate-100 font-medium text-slate-900 dark:bg-zinc-800 dark:text-zinc-50'
                  : 'text-slate-600 hover:bg-slate-100/70 dark:text-zinc-300 dark:hover:bg-zinc-800/60',
              )}
            >
              <ThemeSwatch id={t.id} />
              <span className="flex-1 truncate">{t.name}</span>
              {active && <Check size={13} className="shrink-0 text-emerald-500" />}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

/** 三格色卡：底 / 面 / 强调。色值与 index.css 中各主题的变量保持一致 */
const SWATCHES: Record<string, [string, string, string]> = {
  graphite: ['#f7f7f8', '#ffffff', '#3f3f46'],
  charcoal: ['#09090b', '#18181b', '#a1a1aa'],
  'violet-night': ['#0d0817', '#241a3e', '#a78bfa'],
  'ink-green': ['#07130e', '#173327', '#31c891'],
  'tech-blue': ['#060d1a', '#14243f', '#60a5fa'],
  'neon-forest': ['#04120c', '#071a12', '#3be698'],
  'neon-ocean': ['#040912', '#111d2d', '#78a6df'],
};

function ThemeSwatch({ id }: { id: string }) {
  const [bg, surface, accent] = SWATCHES[id] ?? ['#18181b', '#27272a', '#a1a1aa'];
  return (
    <span
      className="relative flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-[5px] ring-1 ring-inset ring-black/10 dark:ring-white/10"
      style={{ background: bg }}
      aria-hidden
    >
      <span className="absolute inset-x-0 bottom-0 h-2" style={{ background: surface }} />
      <span className="absolute bottom-0 left-0 h-1 w-1 rounded-tr-sm" style={{ background: accent }} />
    </span>
  );
}
