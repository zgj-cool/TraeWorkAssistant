import { AlertTriangle, ArrowUpRight, Bot, Boxes, ChevronRight, Sparkles } from 'lucide-react';
import { Badge } from '../../components/ui';
import { fmtCredits } from '../../lib/format';
import type { AppKey, ViewKey } from '../../types';
import type { PlatformAlert, PlatformKey, PlatformSummary } from './overviewModel';

export const PLATFORMS: Record<
  PlatformKey,
  { label: string; icon: typeof Sparkles; app: AppKey; home: ViewKey; accounts: ViewKey; credits: ViewKey }
> = {
  trae: { label: 'Trae', icon: Sparkles, app: 'trae', home: 'dashboard', accounts: 'accounts', credits: 'credits' },
  buddy: {
    label: 'Buddy',
    icon: Bot,
    app: 'buddy',
    home: 'buddy-overview',
    accounts: 'buddy-accounts',
    credits: 'buddy-credits',
  },
  qoder: {
    label: 'Qoder',
    icon: Boxes,
    app: 'qoder',
    home: 'qoder-overview',
    accounts: 'qoder-accounts',
    credits: 'qoder-credits',
  },
};

const TONE: Record<PlatformKey, 'brand' | 'blue' | 'violet'> = {
  trae: 'brand',
  buddy: 'blue',
  qoder: 'violet',
};

function valueOrDash(v: number | null, suffix = ''): string {
  return v == null ? '—' : `${fmtCredits(v)}${suffix}`;
}

function MetricRow({
  label,
  value,
  hint,
  onClick,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  onClick: () => void;
  warn?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left transition hover:bg-slate-50 dark:hover:bg-zinc-800/70"
      title={`前往${label}详情`}
    >
      <span className="min-w-0">
        <span className="block text-xs text-slate-500 dark:text-zinc-400">{label}</span>
        <span className={`mt-0.5 block text-lg font-bold tabular-nums tracking-tight xl:text-xl ${warn ? 'text-rose-500' : 'text-slate-800 dark:text-zinc-100'}`}>
          {value}
        </span>
        {hint && <span className="mt-0.5 block truncate text-[11px] text-slate-400">{hint}</span>}
      </span>
      <ArrowUpRight size={14} className="shrink-0 text-slate-300 transition group-hover:text-slate-600 dark:text-zinc-600 dark:group-hover:text-zinc-200" />
    </button>
  );
}

export function PlatformCard({ summary, onGo }: { summary: PlatformSummary; onGo: (view: ViewKey) => void }) {
  const meta = PLATFORMS[summary.key];
  const Icon = meta.icon;
  const alert = summary.alertAccounts > 0;
  return (
    <section className="card flex flex-col overflow-hidden transition duration-150 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md dark:hover:border-zinc-700">
      <button
        onClick={() => onGo(meta.home)}
        className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 text-left dark:border-zinc-800"
      >
        <span className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-zinc-200">
            <Icon size={17} />
          </span>
          <span className="text-sm font-semibold">{meta.label}</span>
          <Badge tone={TONE[summary.key]}>{summary.accounts} 个账号</Badge>
        </span>
        <span className="flex items-center gap-1 text-xs text-slate-400">
          进入 <ChevronRight size={14} />
        </span>
      </button>
      <div className="flex-1 divide-y divide-slate-50 px-2 py-1 dark:divide-zinc-900">
        <MetricRow
          label="账号情况"
          value={`${summary.accounts} 个 · 今日已${summary.key === 'qoder' ? '领' : '签'} ${summary.checkedToday}`}
          hint="账号池规模与当日签到"
          onClick={() => onGo(meta.accounts)}
        />
        <MetricRow
          label="可用积分"
          value={valueOrDash(summary.available)}
          hint="各账号余额合计"
          onClick={() => onGo(meta.credits)}
        />
        <MetricRow
          label="今日已用积分"
          value={valueOrDash(summary.usedToday)}
          hint={summary.notes[0]}
          onClick={() => onGo(meta.credits)}
        />
        <MetricRow
          label="7 天内到期积分"
          value={valueOrDash(summary.expiringIn7d)}
          hint="仅计剩余 > 0 且未过期的积分包"
          onClick={() => onGo(meta.credits)}
          warn={(summary.expiringIn7d ?? 0) > 0}
        />
        <MetricRow
          label="账号过期情况"
          value={`${summary.alertAccounts} 个待处理`}
          hint="凭证临期 / 需重登 / 会话失效"
          onClick={() => onGo(meta.accounts)}
          warn={alert}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-slate-100 px-4 py-2 dark:border-zinc-800">
        {summary.notes.slice(1).map((note) => (
          <Badge key={note} tone="slate">{note}</Badge>
        ))}
        {alert && <Badge tone="red"><AlertTriangle size={11} /> 待处理</Badge>}
      </div>
    </section>
  );
}

export function AlertRow({ alert, onGo }: { alert: PlatformAlert; onGo: (app: AppKey, view: ViewKey) => void }) {
  const meta = PLATFORMS[alert.platform];
  const Icon = meta.icon;
  return (
    <button
      onClick={() => onGo(meta.app, alert.view)}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-slate-50 dark:hover:bg-zinc-800/70"
    >
      <Icon size={15} className="shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-slate-700 dark:text-zinc-200">
          {alert.name || alert.user_id}
          <span className="ml-2 text-xs text-slate-400">{alert.reason}</span>
        </span>
      </span>
      <span className="shrink-0 text-xs text-slate-400">去处理 <ArrowUpRight size={12} className="inline" /></span>
    </button>
  );
}
