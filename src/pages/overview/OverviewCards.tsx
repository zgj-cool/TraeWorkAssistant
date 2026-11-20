import type { ReactNode } from 'react';
import { AlertTriangle, ChevronRight, Clock3, Coins } from 'lucide-react';
import { Badge } from '../../components/ui';
import { cn } from '../../lib/cn';
import { fmtCredits, fmtTokens } from '../../lib/format';
import type { AppKey, ViewKey } from '../../types';
import { APP_LOGOS } from '../../lib/appLogos';
import type { PlatformKey, PlatformSummary, TokenPoolSummary } from './overviewModel';

export const PLATFORMS: Record<
  PlatformKey,
  {
    label: string;
    /** 官方 logo 资源（统一取自 lib/appLogos） */
    logo: string;
    app: AppKey;
    home: ViewKey;
    accounts: ViewKey;
    credits: ViewKey;
    apiService: ViewKey;
  }
> = {
  trae: {
    label: 'Trae',
    logo: APP_LOGOS.trae,
    app: 'trae',
    home: 'dashboard',
    accounts: 'accounts',
    credits: 'credits',
    apiService: 'api-service',
  },
  buddy: {
    label: 'Buddy',
    logo: APP_LOGOS.buddy,
    app: 'buddy',
    home: 'buddy-overview',
    accounts: 'buddy-accounts',
    credits: 'buddy-credits',
    apiService: 'buddy-api-service',
  },
  qoder: {
    label: 'Qoder',
    logo: APP_LOGOS.qoder,
    app: 'qoder',
    home: 'qoder-overview',
    accounts: 'qoder-accounts',
    credits: 'qoder-credits',
    apiService: 'qoder-api-service',
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

/** 平台卡片顶部的紧凑指标格（2 列 × 3 行） */
function MetricCell({
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
      className="group min-w-0 rounded-lg px-2 py-1.5 text-left transition hover:bg-slate-50 dark:hover:bg-zinc-800/70"
      title={`前往${label}详情`}
    >
      <span className="block text-[11px] text-slate-400">{label}</span>
      <span
        className={cn(
          'mt-0.5 block truncate text-sm font-semibold tabular-nums',
          warn ? 'text-rose-500 dark:text-rose-400' : 'text-slate-800 dark:text-zinc-100',
        )}
      >
        {value}
      </span>
      {hint && <span className="mt-0.5 block truncate text-[10px] text-slate-400">{hint}</span>}
    </button>
  );
}

/** 卡片内分区（待处理 / 到期 / Token），列表区超高滚动，避免三卡高度失控 */
function CardSection({
  icon,
  title,
  meta,
  metaClass,
  children,
}: {
  icon: ReactNode;
  title: string;
  meta: string;
  metaClass?: string;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-slate-100 px-3 py-2 dark:border-zinc-800">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400">
          {icon}
          {title}
        </span>
        <span className={cn('shrink-0 text-[11px] tabular-nums', metaClass ?? 'text-slate-400')}>
          {meta}
        </span>
      </div>
      <div className="max-h-36 space-y-0.5 overflow-auto">{children}</div>
    </div>
  );
}

/** 分区内的一行：标题 + 次级说明 + 右侧数值；传 onClick 时是按钮 */
function ListRow({
  title,
  sub,
  right,
  rightClass,
  hint,
  onClick,
}: {
  title: string;
  sub?: string;
  right?: string;
  rightClass?: string;
  hint?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-slate-700 dark:text-zinc-200">{title}</span>
        {sub && <span className="block truncate text-[10px] text-slate-400">{sub}</span>}
      </span>
      {right && (
        <span className={cn('shrink-0 text-xs font-semibold tabular-nums', rightClass)}>{right}</span>
      )}
    </>
  );
  if (!onClick) {
    return (
      <div className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left" title={hint}>
        {content}
      </div>
    );
  }
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-slate-50 dark:hover:bg-zinc-800/70"
      title={hint}
    >
      {content}
    </button>
  );
}

export function PlatformCard({
  summary,
  poolTokens,
  onGo,
}: {
  summary: PlatformSummary;
  /** 该平台池的今日网关 Token（缺失时按无数据渲染） */
  poolTokens?: TokenPoolSummary;
  onGo: (view: ViewKey) => void;
}) {
  const meta = PLATFORMS[summary.key];
  const alert = summary.alertAccounts > 0;
  const tokens: TokenPoolSummary = poolTokens ?? { prompt: null, completion: null, total: null, rows: [] };
  /** 账号级明细合计（用于标注与池合计之间的历史差额） */
  const rowsTotal = tokens.rows.reduce((n, r) => n + r.total_tokens, 0);
  const tokenHint =
    tokens.total == null
      ? 'API 网关暂无数据'
      : `输入 ${fmtTokens(tokens.prompt ?? 0)} / 输出 ${fmtTokens(tokens.completion ?? 0)}` +
        (tokens.rows.length > 0 ? ` · ${tokens.rows.length} 个账号` : '');

  return (
    <section className="card flex flex-col overflow-hidden transition duration-150 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md dark:hover:border-zinc-700">
      <button
        onClick={() => onGo(meta.home)}
        className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 text-left dark:border-zinc-800"
      >
        <span className="flex items-center gap-2">
          <img
            src={meta.logo}
            alt={`${meta.label} logo`}
            className="h-8 w-8 shrink-0 rounded-lg object-contain"
            draggable={false}
          />
          <span className="text-sm font-semibold">{meta.label}</span>
          <Badge tone={TONE[summary.key]}>{summary.accounts} 个账号</Badge>
        </span>
        <span className="flex items-center gap-1 text-xs text-slate-400">
          进入 <ChevronRight size={14} />
        </span>
      </button>

      <div className="grid grid-cols-2 gap-0.5 p-2">
        <MetricCell
          label="账号"
          value={`${summary.accounts} 个`}
          hint={`今日已${summary.key === 'qoder' ? '领' : '签'} ${summary.checkedToday}`}
          onClick={() => onGo(meta.accounts)}
        />
        <MetricCell
          label="可用积分"
          value={valueOrDash(summary.available)}
          hint="各账号余额合计"
          onClick={() => onGo(meta.credits)}
        />
        <MetricCell
          label="今日已用积分"
          value={valueOrDash(summary.usedToday)}
          hint={summary.notes[0]}
          onClick={() => onGo(meta.credits)}
        />
        <MetricCell
          label="今日 Token"
          value={tokens.total == null ? '—' : fmtTokens(tokens.total)}
          hint={tokenHint}
          onClick={() => onGo(meta.apiService)}
        />
        <MetricCell
          label="7 天内到期积分"
          value={valueOrDash(summary.expiringIn7d)}
          hint="仅计剩余 > 0 的积分包"
          onClick={() => onGo(meta.credits)}
          warn={(summary.expiringIn7d ?? 0) > 0}
        />
        <MetricCell
          label="待处理账号"
          value={`${summary.alertAccounts} 个`}
          hint="凭证临期 / 需重登"
          onClick={() => onGo(meta.accounts)}
          warn={alert}
        />
      </div>

      {/* Token 明细栏常驻展示：无数据也占位，避免被误认为功能缺失 */}
      <CardSection
        icon={<Coins size={11} className="text-violet-500" />}
        title="今日 Token 消耗"
        meta={
          tokens.total == null
            ? '暂无数据'
            : `${tokens.rows.length} 个账号 · ${fmtTokens(tokens.total)}`
        }
        metaClass={tokens.total == null ? 'text-slate-400' : 'text-violet-600 dark:text-violet-400'}
      >
        {tokens.rows.length === 0 ? (
          <p className="px-1.5 py-1 text-[11px] leading-relaxed text-slate-400">
            {tokens.total == null
              ? '今日暂无网关用量。启动 API 服务并产生请求后，这里会按账号展示输入 / 输出 Token。'
              : tokens.total === 0
                ? '今日无 Token 消耗（请求未回传 usage）。'
                : `今日合计 ${fmtTokens(tokens.total)}，账号级明细自本版本起累计，暂无记录。`}
          </p>
        ) : (
          <>
            {tokens.rows.map((r) => (
              <ListRow
                key={r.id}
                title={r.name}
                sub={`输入 ${fmtTokens(r.prompt_tokens)} / 输出 ${fmtTokens(r.completion_tokens)}`}
                right={fmtTokens(r.total_tokens)}
                rightClass="text-violet-600 dark:text-violet-400"
                hint="前往 API 服务 · 用量统计"
                onClick={() => onGo(meta.apiService)}
              />
            ))}
            {rowsTotal < (tokens.total ?? 0) && (
              <p className="px-1.5 pt-0.5 text-[10px] leading-relaxed text-slate-400">
                其余 {fmtTokens((tokens.total ?? 0) - rowsTotal)} 为升级前历史请求（无账号级明细）。
              </p>
            )}
          </>
        )}
      </CardSection>

      {/* 到期明细栏常驻展示：无数据也占位 */}
      <CardSection
        icon={<Clock3 size={11} className="text-amber-500" />}
        title="7 日内到期明细"
        meta={
          summary.expiringDetails.length > 0 ? `${summary.expiringDetails.length} 个账号` : '无'
        }
        metaClass={
          summary.expiringDetails.length > 0
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-slate-400'
        }
      >
        {summary.expiringDetails.length === 0 ? (
          <p className="px-1.5 py-1 text-[11px] leading-relaxed text-slate-400">
            7 日内没有即将到期的积分包。
          </p>
        ) : (
          summary.expiringDetails.map((d) => (
            <ListRow
              key={d.id}
              title={d.name || d.user_id}
              sub={d.reason}
              right={d.credits == null ? '金额未刷新' : fmtCredits(d.credits)}
              rightClass="text-amber-600 dark:text-amber-400"
              hint="查看积分包明细"
              onClick={() => onGo(d.view)}
            />
          ))
        )}
      </CardSection>

      {summary.alerts.length > 0 && (
        <CardSection
          icon={<AlertTriangle size={11} className="text-rose-500" />}
          title="待处理账号"
          meta={`${summary.alerts.length} 项`}
          metaClass="text-rose-500 dark:text-rose-400"
        >
          {summary.alerts.map((a) => (
            <ListRow
              key={a.id}
              title={a.name || a.user_id}
              sub={a.reason}
              right="去处理"
              rightClass="text-rose-500 dark:text-rose-400"
              hint="前往账号页处理"
              onClick={() => onGo(a.view)}
            />
          ))}
        </CardSection>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-1 border-t border-slate-100 px-4 py-2 dark:border-zinc-800">
        {summary.notes.slice(1).map((note) => (
          <Badge key={note} tone="slate">{note}</Badge>
        ))}
        {alert && <Badge tone="red"><AlertTriangle size={11} /> 待处理</Badge>}
      </div>
    </section>
  );
}
