import { useState } from 'react';
import { AlertTriangle, ChevronRight, Clock3, Coins, TrendingDown } from 'lucide-react';
import { Badge, SegmentedTabs } from '../../components/ui';
import { cn } from '../../lib/cn';
import { fmtCredits, fmtTokens } from '../../lib/format';
import type { AppKey, ViewKey } from '../../types';
import type { BoardNavIntent } from '../../store';
import { APP_LOGOS } from '../../lib/appLogos';
import type {
  CreditUsageRow,
  PlatformKey,
  PlatformSummary,
  TokenPoolSummary,
} from './overviewModel';

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
  }
> = {
  trae: {
    label: 'Trae',
    logo: APP_LOGOS.trae,
    app: 'trae',
    home: 'dashboard',
    accounts: 'accounts',
    credits: 'credits',
  },
  buddy: {
    label: 'Buddy',
    logo: APP_LOGOS.buddy,
    app: 'buddy',
    home: 'buddy-overview',
    accounts: 'buddy-accounts',
    credits: 'buddy-credits',
  },
  qoder: {
    label: 'Qoder',
    logo: APP_LOGOS.qoder,
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

/** 指标格尺寸：hero = 主指标（卡片最高优先级）、md = 核心指标、sm = 辅助指标 */
type MetricSize = 'hero' | 'md' | 'sm';

/** 字号阶梯：标签统一 13 / 说明统一 12 / 数值 28·20·16，避免同屏出现 11·11.5·12·12.5 的碎片档位 */
const METRIC_SIZE: Record<MetricSize, { label: string; value: string; hint: string; box: string }> = {
  hero: {
    label: 'text-[13px]',
    value: 'text-[28px] leading-[1.1]',
    hint: 'text-[12px]',
    box: 'px-4 py-3 bg-slate-50/70 dark:bg-zinc-800/25',
  },
  md: {
    label: 'text-[13px]',
    value: 'text-[20px] leading-[1.15]',
    hint: 'text-[12px]',
    box: 'px-3.5 py-3',
  },
  sm: {
    label: 'text-[13px]',
    value: 'text-[20px] leading-[1.15]',
    hint: 'text-[12px]',
    box: 'px-2.5 py-2.5',
  },
};

/** 平台卡片顶部指标格：数值放大 / 标签加密，保证扫读时一眼抓到重点 */
function MetricCell({
  label,
  value,
  hint,
  onClick,
  warn,
  size = 'md',
}: {
  label: string;
  value: string;
  hint?: string;
  onClick: () => void;
  warn?: boolean;
  size?: MetricSize;
}) {
  const s = METRIC_SIZE[size];
  return (
    <button
      onClick={onClick}
      className={cn(
        'group min-w-0 text-left transition-colors hover:bg-slate-100/70 dark:hover:bg-zinc-800/45',
        s.box,
      )}
      title={`前往${label}详情`}
    >
      <span className={cn('block truncate font-medium text-slate-500 dark:text-zinc-400', s.label)}>
        {label}
      </span>
      <span
        className={cn(
          'mt-1 block truncate font-semibold tabular-nums tracking-[-0.02em]',
          s.value,
          warn ? 'text-rose-500 dark:text-rose-400' : 'text-slate-900 dark:text-zinc-50',
        )}
      >
        {value}
      </span>
      {hint && (
        <span
          className={cn('mt-1 block truncate text-slate-500 dark:text-zinc-400', s.hint)}
          title={hint}
        >
          {hint}
        </span>
      )}
    </button>
  );
}

/** 明细区内的一行：标题 + 次级说明 + 右侧数值；传 onClick 时是按钮 */
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
        <span className="block truncate text-[14px] font-medium leading-5 text-slate-700 dark:text-zinc-200">
          {title}
        </span>
        {sub && (
          <span className="mt-0.5 block truncate text-[12px] leading-4 text-slate-500 dark:text-zinc-400">
            {sub}
          </span>
        )}
      </span>
      {right && (
        <span className={cn('shrink-0 text-[14px] font-semibold tabular-nums', rightClass)}>
          {right}
        </span>
      )}
    </>
  );
  if (!onClick) {
    return (
      <div className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left" title={hint}>
        {content}
      </div>
    );
  }
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-slate-50/80 dark:hover:bg-zinc-800/60"
      title={hint}
    >
      {content}
    </button>
  );
}

/** 平台卡片明细区维度（Tab 切换） */
type DetailTab = 'credits' | 'tokens' | 'expiry' | 'alerts';

export function PlatformCard({
  summary,
  creditRows,
  poolTokens,
  onGo,
}: {
  summary: PlatformSummary;
  /** 该平台的逐账号今日积分消耗（缺失时按空态渲染） */
  creditRows?: CreditUsageRow[];
  /** 该平台池的今日网关 Token（缺失时按无数据渲染） */
  poolTokens?: TokenPoolSummary;
  /** 跳转目标页（可附带积分看板 Tab/数据源，如 Token 统计 + 网关源；账号页忽略该参数） */
  onGo: (view: ViewKey, nav?: BoardNavIntent) => void;
}) {
  const meta = PLATFORMS[summary.key];
  const alert = summary.alertAccounts > 0;
  const credits = creditRows ?? [];
  const creditsWithData = credits.filter((r) => r.credits != null);
  const creditsTotal = creditsWithData.length
    ? Math.round(creditsWithData.reduce((n, r) => n + (r.credits ?? 0), 0) * 100) / 100
    : null;
  const tokens: TokenPoolSummary = poolTokens ?? { prompt: null, completion: null, total: null, rows: [] };
  /** 账号级明细合计（用于标注与池合计之间的历史差额） */
  const rowsTotal = tokens.rows.reduce((n, r) => n + r.total_tokens, 0);
  const tokenHint =
    tokens.total == null
      ? 'API 网关暂无数据'
      : `输入 ${fmtTokens(tokens.prompt ?? 0)} / 输出 ${fmtTokens(tokens.completion ?? 0)}` +
        (tokens.rows.length > 0 ? ` · ${tokens.rows.length} 个账号` : '');

  /** 明细区维度：Tab 化后单栏展示，合计与 Tab 同行右对齐 */
  const [tab, setTab] = useState<DetailTab>('credits');
  const tabs = [
    { key: 'credits', label: '积分' },
    { key: 'tokens', label: 'Token' },
    { key: 'expiry', label: '到期' },
    ...(summary.alerts.length > 0 ? [{ key: 'alerts', label: '待处理' }] : []),
  ];
  const tabIcon = {
    credits: <TrendingDown size={14} className="text-amber-500" />,
    tokens: <Coins size={14} className="text-violet-500" />,
    expiry: <Clock3 size={14} className="text-amber-500" />,
    alerts: <AlertTriangle size={14} className="text-rose-500" />,
  }[tab];
  const tabTone: Record<DetailTab, string> = {
    credits: 'text-amber-600 dark:text-amber-400',
    tokens: 'text-violet-600 dark:text-violet-400',
    expiry: 'text-amber-600 dark:text-amber-400',
    alerts: 'text-rose-500 dark:text-rose-400',
  };
  const detailMeta =
    tab === 'credits'
      ? creditsWithData.length > 0
        ? `合计 ${fmtCredits(creditsTotal ?? 0)}`
        : '暂无数据'
      : tab === 'tokens'
        ? tokens.total == null
          ? '暂无数据'
          : `合计 ${fmtTokens(tokens.total)}`
        : tab === 'expiry'
          ? summary.expiringDetails.length > 0
            ? `${summary.expiringDetails.length} 个账号`
            : '无到期'
          : `${summary.alerts.length} 项`;
  /** 合计仅显示总额，完整口径（账号数等）放 title 提示 */
  const detailTitle =
    tab === 'credits'
      ? `${creditsWithData.length}/${credits.length} 个账号有今日积分明细，合计 ${fmtCredits(creditsTotal ?? 0)}`
      : tab === 'tokens'
        ? `今日网关 Token 合计 ${fmtTokens(tokens.total ?? 0)}，${tokens.rows.length} 个账号有明细`
        : tab === 'expiry'
          ? `${summary.expiringDetails.length} 个账号有 7 日内到期积分`
          : `${summary.alerts.length} 项待处理账号`;

  return (
    <section className="card flex flex-col overflow-hidden hover:-translate-y-0.5 hover:border-slate-300/80 hover:shadow-soft-lg dark:hover:border-zinc-700/80">
      <button
        onClick={() => onGo(meta.home)}
        className="group/head flex items-center justify-between gap-2 border-b border-slate-200/60 px-4 py-3.5 text-left dark:border-zinc-800/60"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <img
            src={meta.logo}
            alt={`${meta.label} logo`}
            className="h-8 w-8 shrink-0 rounded-md object-contain"
            draggable={false}
          />
          <span className="text-[16px] font-semibold tracking-[-0.01em]">{meta.label}</span>
          <Badge tone={TONE[summary.key]} className="text-[12px]">
            {summary.accounts} 个账号
          </Badge>
        </span>
        <span className="flex shrink-0 items-center gap-0.5 text-[13px] text-slate-400 transition-colors group-hover/head:text-slate-600 dark:group-hover/head:text-zinc-300">
          进入 <ChevronRight size={15} />
        </span>
      </button>

      {/* 主指标：可用积分（全宽强调，最高优先级） */}
      <MetricCell
        size="hero"
        label="可用积分"
        value={valueOrDash(summary.available)}
        hint="各账号余额合计"
        onClick={() => onGo(meta.credits)}
      />

      {/* 核心指标：今日消耗与今日 Token */}
      <div className="grid grid-cols-2 divide-x divide-slate-200/60 border-t border-slate-200/60 dark:divide-zinc-800/60 dark:border-zinc-800/60">
        <MetricCell
          label="今日已用积分"
          /* 取最后一条口径标记（如「官网明细缓存」），避免额外一行徽标 */
          value={valueOrDash(summary.usedToday)}
          hint={summary.notes[summary.notes.length - 1]}
          onClick={() => onGo(meta.credits)}
        />
        <MetricCell
          label="今日 Token"
          value={tokens.total == null ? '—' : fmtTokens(tokens.total)}
          hint={tokenHint}
          onClick={() => onGo(meta.credits, { tab: 'tokens', source: 'gateway' })}
        />
      </div>

      {/* 辅助指标：账号 / 到期 / 待处理 */}
      <div className="grid grid-cols-3 divide-x divide-slate-200/60 border-t border-slate-200/60 dark:divide-zinc-800/60 dark:border-zinc-800/60">
        <MetricCell
          size="sm"
          label="账号"
          value={`${summary.accounts} 个`}
          hint={`已${summary.key === 'qoder' ? '领' : '签'} ${summary.checkedToday}`}
          onClick={() => onGo(meta.accounts)}
        />
        <MetricCell
          size="sm"
          label="7 天内到期"
          value={valueOrDash(summary.expiringIn7d)}
          hint="剩余 > 0 的包"
          onClick={() => onGo(meta.credits, { tab: 'expiry' })}
          warn={(summary.expiringIn7d ?? 0) > 0}
        />
        <MetricCell
          size="sm"
          label="待处理"
          value={`${summary.alertAccounts} 个`}
          hint="临期 / 重登"
          onClick={() => onGo(meta.accounts)}
          warn={alert}
        />
      </div>

      {/* 明细区：Tab 与合计同行（左 Tab / 右合计），单栏列表字号可放大 */}
      <div className="flex items-center justify-between gap-3 border-t border-slate-200/60 px-3.5 py-2.5 dark:border-zinc-800/60">
        <SegmentedTabs options={tabs} value={tab} onChange={(key) => setTab(key as DetailTab)} />
        <span
          className={cn(
            'flex min-w-0 shrink-0 items-center gap-1.5 text-[14px] font-semibold tabular-nums',
            tabTone[tab],
          )}
          title={detailTitle ?? detailMeta}
        >
          {tabIcon}
          <span className="truncate">{detailMeta}</span>
        </span>
      </div>

      <div className="h-60 divide-y divide-slate-100 overflow-auto dark:divide-zinc-800/70">
        {tab === 'credits' &&
          (credits.length === 0 ? (
            <p className="px-3.5 py-3 text-[13px] leading-relaxed text-slate-500 dark:text-zinc-400">
              本平台暂无账号，导入账号后这里会按账号展示今日积分消耗。
            </p>
          ) : (
            credits.map((r) => (
              <ListRow
                key={r.id}
                title={r.name || r.uid}
                sub={r.source}
                right={r.credits == null ? '—' : fmtCredits(r.credits)}
                rightClass={
                  r.credits == null ? 'text-slate-400' : 'text-amber-600 dark:text-amber-400'
                }
                hint="前往积分看板"
                onClick={() => onGo(meta.credits)}
              />
            ))
          ))}

        {tab === 'tokens' &&
          (tokens.rows.length === 0 ? (
            <p className="px-3.5 py-3 text-[13px] leading-relaxed text-slate-500 dark:text-zinc-400">
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
                  hint="前往积分看板 · Token 统计"
                  onClick={() => onGo(meta.credits, { tab: 'tokens', source: 'gateway' })}
                />
              ))}
              {rowsTotal < (tokens.total ?? 0) && (
                <p className="px-3.5 py-2 text-[12px] leading-relaxed text-slate-400">
                  其余 {fmtTokens((tokens.total ?? 0) - rowsTotal)} 为升级前历史请求（无账号级明细）。
                </p>
              )}
            </>
          ))}

        {tab === 'expiry' &&
          (summary.expiringDetails.length === 0 ? (
            <p className="px-3.5 py-3 text-[13px] leading-relaxed text-slate-500 dark:text-zinc-400">
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
                onClick={() => onGo(d.view, { tab: 'expiry' })}
              />
            ))
          ))}

        {tab === 'alerts' &&
          (summary.alerts.length === 0 ? (
            <p className="px-3.5 py-3 text-[13px] leading-relaxed text-slate-500 dark:text-zinc-400">
              当前没有需要处理的账号。
            </p>
          ) : (
            summary.alerts.map((a) => (
              <ListRow
                key={a.id}
                title={a.name || a.user_id}
                sub={a.reason}
                right="去处理"
                rightClass="text-rose-500 dark:text-rose-400"
                hint="前往账号页处理"
                onClick={() => onGo(a.view)}
              />
            ))
          ))}
      </div>

    </section>
  );
}


