import { CheckCircle2, Info, AlertTriangle, XCircle, X } from 'lucide-react';
import { useAppStore, type ToastKind } from '../store';
import { cn } from '../lib/cn';

const iconMap: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
};

/** 配色只走「描边 + 图标」：文字沿用正文灰阶，长时间阅读错误长文案不刺眼 */
const borderTone: Record<ToastKind, string> = {
  info: 'border-sky-200/90 dark:border-sky-500/30',
  success: 'border-emerald-200/90 dark:border-emerald-500/30',
  warn: 'border-amber-200/90 dark:border-amber-500/30',
  error: 'border-rose-200/90 dark:border-rose-500/30',
};

const iconTone: Record<ToastKind, string> = {
  info: 'text-sky-600 dark:text-sky-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-rose-600 dark:text-rose-400',
};

export default function Toaster() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
      // 内联 z-index 兜底：任意值类 z-[60] 一旦未生成，toast 会被弹窗遮罩（z-50）盖住
      style={{ zIndex: 60 }}
    >
      {toasts.map((t) => {
        const Icon = iconMap[t.kind];
        return (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex animate-pop-in items-start gap-2.5 rounded-xl border bg-white px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-700 shadow-soft-lg dark:bg-zinc-900 dark:text-zinc-200',
              borderTone[t.kind],
            )}
          >
            <Icon size={16} className={cn('mt-0.5 shrink-0', iconTone[t.kind])} />
            <span className="flex-1 break-words">{t.msg}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-slate-400 opacity-70 transition-opacity hover:opacity-100 dark:text-zinc-500"
              aria-label="关闭"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
