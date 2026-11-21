import { type ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

type Tone =
  | 'slate'
  | 'brand'
  | 'green'
  | 'amber'
  | 'red'
  | 'blue'
  | 'violet'
  | 'cyan';

/** 徽标配色：浅底 + 同色系发丝描边（比实心色块更轻，密集状态栏不抢视线） */
const toneMap: Record<Tone, string> = {
  slate:
    'border-slate-200/80 bg-slate-50 text-slate-600 dark:border-zinc-700/70 dark:bg-zinc-800/50 dark:text-zinc-300',
  brand:
    'border-zinc-300/60 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
  green:
    'border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300',
  amber:
    'border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300',
  red: 'border-rose-200/80 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300',
  blue: 'border-sky-200/80 bg-sky-50 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300',
  violet:
    'border-violet-200/80 bg-violet-50 text-violet-700 dark:border-violet-500/20 dark:bg-violet-500/10 dark:text-violet-300',
  cyan: 'border-cyan-200/80 bg-cyan-50 text-cyan-700 dark:border-cyan-500/20 dark:bg-cyan-500/10 dark:text-cyan-300',
};

const accentMap: Record<Tone, string> = {
  slate: 'bg-slate-400',
  brand: 'bg-zinc-500',
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
  blue: 'bg-sky-500',
  violet: 'bg-violet-500',
  cyan: 'bg-cyan-500',
};

export function Badge({
  children,
  tone = 'slate',
  className,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cn('chip', toneMap[tone], className)} title={title}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
      role="status"
      aria-label="loading"
    />
  );
}

export function Progress({
  value,
  max = 100,
  className,
}: {
  value: number;
  max?: number;
  className?: string;
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div
      className={cn(
        'h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-zinc-800',
        className,
      )}
    >
      <div
        className="h-full rounded-full bg-zinc-900 transition-[width] duration-300 dark:bg-zinc-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size,
  widthClass,
  bodyClass,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'lg' | 'xl' | '2xl';
  /** 覆盖默认宽度类（如 max-w-[63rem]）；不传按 size 映射 */
  widthClass?: string;
  /** 附加到内容区（如 max-h-[80vh] overflow-y-auto，长内容弹框限制高度内部滚动） */
  bodyClass?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/35 backdrop-blur-[3px] dark:bg-black/60" onClick={onClose} />
      <div className={`card relative z-10 w-full bg-white dark:bg-zinc-900 ${widthClass ?? (size === '2xl' ? 'max-w-[78rem]' : size === 'xl' ? 'max-w-4xl' : size === 'lg' ? 'max-w-2xl' : 'max-w-lg')} animate-pop-in p-5 shadow-soft-lg`} role="dialog" aria-modal="true">
        <div className="mb-3.5 flex items-center justify-between gap-3">
          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-zinc-50">
            {title}
          </h3>
          <button className="btn-ghost -mr-1 h-8 w-8 !p-0" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className={`text-[13px] leading-relaxed text-slate-600 dark:text-zinc-300 ${bodyClass ?? ''}`}>
          {children}
        </div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-slate-300/80 py-12 text-center dark:border-zinc-700/70">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-zinc-800/70 dark:text-zinc-500">
          {icon}
        </div>
      )}
      <p className="text-[13px] font-medium text-slate-600 dark:text-zinc-300">{title}</p>
      {hint && (
        <p className="mt-1 max-w-sm text-[12px] leading-relaxed text-slate-400 dark:text-zinc-500">
          {hint}
        </p>
      )}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'slate',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', accentMap[tone])} />
        <span className="truncate text-[12px] font-medium text-slate-500 dark:text-zinc-400">
          {label}
        </span>
      </div>
      <div className="mt-2 text-[26px] font-semibold leading-none tracking-[-0.02em] text-slate-900 tabular-nums dark:text-zinc-50">
        {value}
      </div>
      {hint && (
        <div className="mt-2 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">
          {hint}
        </div>
      )}
    </div>
  );
}

/** 分段切换控件（页面内二级分类：Tab / 数据源）。
 *  统一「浅槽 + 白色胶囊」选中态，避免各页面自行拼装导致深浅与圆角不一致。 */
export function SegmentedTabs({
  options,
  value,
  onChange,
  className,
}: {
  options: { key: string; label: string; disabled?: boolean; title?: string }[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'inline-flex flex-wrap items-center gap-0.5 rounded-[10px] bg-slate-100/80 p-1 dark:bg-zinc-800/50',
        className,
      )}
    >
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            disabled={o.disabled}
            title={o.title}
            aria-pressed={active}
            className={cn(
              'rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              active
                ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:bg-zinc-700/80 dark:text-white'
                : 'text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              o.disabled && 'cursor-not-allowed opacity-40',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
