import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, MessagesSquare } from 'lucide-react';
import { Badge, EmptyState, Spinner } from '../../components/ui';
import { api } from '../../lib/tauri';
import { fmtCredits, fmtTokens } from '../../lib/format';
import { useAppStore } from '../../store';
import type { UsageSessionView, UsageSessionsResult } from '../../types';
import type { PlatformScope } from './KpiRow';

/**
 * 会话明细 Tab（issue #82）：
 * 展示会话级明细行——时间 / 账号 / 会话说明 / 模型 / 消耗积分 / 消耗 token 等。
 * Trae 数据源为官网 query_user_usage_group_by_session 会话行缓存（纯缓存零网络）；
 * Buddy 数据源为官网请求级计费明细落盘（get-user-request-usage，随官方用量拉取保鲜），
 * 上游无 token/会话说明字段 → 相应列隐藏；
 * Qoder 数据源优先官网采集行级明细（Webview 同源 fetch histories，逐请求、含会话说明；
 * 积分看板「官网采集」时随路落盘），未采集时回退 API 网关请求级本地流水
 *（record_usage_qoder 转发时逐请求落库）；两者均无费用/缓存 token 字段 → 相应列隐藏。
 * Qoder 行支持展开看各轮请求级明细（键口径 session_id ∪ preview，纯本地零网络；
 * 官网源下展开即该请求本身）。
 *
 * 三平台均支持多选合计积分：点击整行或行首复选框即选中/取消（跨页保留，
 * 筛选变化即清空）。Trae / Buddy 经 API 网关转发时一个任务会拆成多条会话，
 * 逐行累加不便；Qoder 官网采集已把同任务流水合并成单行，选中即任务总消耗。
 */

const PAGE_SIZE = 50;

/**
 * 行键（React key 与勾选态共用）：同账号 + 会话 + 秒级时间戳 + 页内序号。
 * 勾选态以行键为身份跨页留存，翻页回来仍处于选中状态。
 */
function rowKeyOf(r: UsageSessionView, idx: number): string {
  return `${r.user_id}-${r.session_id || 'x'}-${r.ts}-${idx}`;
}

/**
 * 表格列数（基础列 + 勾选列 + 展开列 + 平台附加列）：
 * 空结果行与展开明细行的 colSpan 共用，避免两处手算漂移。
 */
function columnCount(
  scope: PlatformScope,
  selCol: boolean,
  richColumns: boolean,
  showCacheCost: boolean,
): number {
  // 时间 / 账号 / 模型 / 消耗积分（会话说明列仅 Trae、Buddy 有）
  const base = 4 + (scope === 'qoder' ? 0 : 1);
  return (
    base +
    (selCol ? 1 : 0) +
    // Qoder：展开 chevron + 原价/折扣 + 费用
    (scope === 'qoder' ? 3 : 0) +
    (richColumns ? 1 : 0) +
    (showCacheCost ? 2 : 0)
  );
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function SessionsTab({
  scope,
  accountOptions,
  refreshKey,
}: {
  scope: PlatformScope;
  /** 账号筛选下拉（Trae=vault 账号；Buddy=积分接口账号清单） */
  accountOptions: { user_id: string; name: string }[];
  /** 全局刷新联动键：看板「刷新数据」完成后 +1，触发重查缓存 */
  refreshKey: number;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  // 会话概述显示开关（issue #82 T6.1）：settings 未加载/缺字段时按默认开处理
  const showPreview = useAppStore((s) => s.settings?.sessions_preview_enabled) !== false;
  // 默认「今日」：会话明细最常看当天消耗，跨天更直观（快捷区间仍可切近 7/30 天）
  const [start, setStart] = useState(() => fmtDate(new Date()));
  const [end, setEnd] = useState(() => fmtDate(new Date()));
  const [model, setModel] = useState('');
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<UsageSessionsResult | null>(null);
  const [loading, setLoading] = useState(false);
  // 审查 No.11：查询失败持久错误态（toast 稍纵即逝；横幅保留至下次成功查询）
  const [error, setError] = useState<string | null>(null);
  // 模型下拉选项并集（审查 m-7）：data.models 是「过滤后结果」里的模型清单，
  // 选中某模型后下拉只剩该模型，无法直接切回其它模型（需先清筛选）。
  // 改为跨查询累计并集（切换平台时重置），下拉始终可选全部出现过的模型
  const [modelsUnion, setModelsUnion] = useState<string[]>([]);
  // 会话展开明细（Qoder 专属）：expandedKey = 当前展开行 key；查询失败保留上次结果
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<UsageSessionView[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // 明细请求序号守卫：快速切换展开行时旧响应可能后到，仅最新一次请求可写明细态
  const detailSeqRef = useRef(0);
  // 多会话积分合计：rowKey → 行数据（勾选态跨页留存，故存快照）
  const [selected, setSelected] = useState<Record<string, UsageSessionView>>({});
  // 表头「全选本页」复选框的三态（部分选中显示 indeterminate）
  const headCbRef = useRef<HTMLInputElement>(null);

  const toggleDetail = (key: string, r: UsageSessionView) => {
    if (expandedKey === key) {
      setExpandedKey(null);
      setDetail(null);
      return;
    }
    const seq = ++detailSeqRef.current;
    setExpandedKey(key);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    api.qoder
      .sessionDetail({ date: r.date, uid: r.user_id, sessionId: r.session_id, preview: r.preview })
      .then((rows) => {
        if (seq !== detailSeqRef.current) return;
        setDetail(rows);
        setDetailError(null);
      })
      .catch((err) => {
        if (seq !== detailSeqRef.current) return;
        setDetailError(String(err));
      })
      .finally(() => {
        if (seq === detailSeqRef.current) setDetailLoading(false);
      });
  };

  // 展开/明细随主查询重置：筛选或翻页后行键可能恰好重合，陈旧明细不得残留
  const resetExpanded = useCallback(() => {
    detailSeqRef.current++;
    setExpandedKey(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  useEffect(() => {
    setModelsUnion([]);
    setModel('');
    resetExpanded();
  }, [scope, resetExpanded]);

  // 筛选条件变化（含看板刷新）即清空勾选：行键带页内序号，结果集一变就可能
  // 指向另一行，留着会让合计变成「看不见的积分」。翻页不在依赖内——跨页累加是主要用法。
  useEffect(() => {
    setSelected({});
  }, [scope, start, end, model, userId, refreshKey]);

  useEffect(() => {
    // D4（审查修复清单 v1.4.9）：开始日期晚于结束日期时不发无效请求（原实现
    // 静默返回空列表，用户误以为无数据）——复用既有 error 横幅提示调整区间
    if (start > end) {
      setLoading(false);
      setError('开始日期晚于结束日期，请调整时间范围后重试');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    resetExpanded();
    const fetchFn =
      scope === 'buddy'
        ? api.workbuddy.usageSessions
        : scope === 'qoder'
          ? api.qoder.usageSessions
          : api.accounts.usageSessions;
    fetchFn({
      start,
      end,
      model: model || null,
      userId: userId || null,
      page,
      pageSize: PAGE_SIZE,
    })
      .then((r) => {
        if (!cancelled) {
          setData(r);
          // 模型清单并入并集（排序去重；过滤态返回的子集不收缩下拉选项）
          setModelsUnion((prev) => Array.from(new Set([...prev, ...(r.models ?? [])])).sort());
        }
        // 空页回夹（审查修复）：筛选/刷新后数据缩水，本地页码可能越界停在
        // 空页——以服务端夹取后的 r.page 为准回同步（触发一次纠正查询）。
        // cancelled 守卫防竞态：过期响应不得改页码再触发新一轮查询
        if (!cancelled && r.page !== page) setPage(r.page);
      })
      .catch((err) => {
        // 审查 No.11：失败保留上次成功结果（不清空已渲染表格），错误横幅持续可见
        if (!cancelled) {
          setError(`会话明细查询失败：${String(err)}`);
          pushToast('error', `会话明细查询失败：${String(err)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, start, end, model, userId, page, refreshKey, pushToast]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  // ---- 勾选合计（Trae / Buddy）----
  const pageRows = data?.rows ?? [];
  const pageRowKeys = pageRows.map((r, i) => rowKeyOf(r, i));
  const pageSelectedCount = pageRowKeys.filter((k) => selected[k]).length;
  const allPageSelected = pageRowKeys.length > 0 && pageSelectedCount === pageRowKeys.length;
  const selectedRows = Object.values(selected);
  const selectedCount = selectedRows.length;
  const selectedCredits = selectedRows.reduce((sum, r) => sum + (r.credits || 0), 0);
  const selectedInputTokens = selectedRows.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
  const selectedOutputTokens = selectedRows.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
  // 三平台均渲染勾选列（行点击与复选框同效，供多选合计积分）
  const selCol = true;

  const toggleSelected = (key: string, r: UsageSessionView) =>
    setSelected((prev) => {
      if (!prev[key]) return { ...prev, [key]: r };
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const togglePageSelected = () => {
    setSelected((prev) => {
      const next = { ...prev };
      if (allPageSelected) {
        pageRowKeys.forEach((k) => delete next[k]);
      } else {
        pageRows.forEach((r, i) => {
          next[rowKeyOf(r, i)] = r;
        });
      }
      return next;
    });
  };

  // 部分选中时表头复选框显示为 indeterminate（HTML 属性只能命令式设置）
  useEffect(() => {
    if (headCbRef.current) {
      headCbRef.current.indeterminate = pageSelectedCount > 0 && !allPageSelected;
    }
  }, [pageSelectedCount, allPageSelected]);

  // issue #82 问题2：Buddy 官网请求级行无 token、费用字段 → 隐藏这两列（恒显示 '—' 无信息量）。
  // 注：Qoder 亦有勾选列，行点击与复选框同效（点击整行选中）。
  // 会话说明列三平台均展示：Buddy 已接入上游 input/inputTrunc（旧缓存未刷新前显示 '—'）
  const richColumns = scope !== 'buddy';
  // issue #82 问题5：Qoder 网关流水无缓存 token/费用字段 → 隐藏这两列
  const showCacheCost = scope === 'trae';
  const setRange = (days: number) => {
    setStart(fmtDate(new Date(Date.now() - days * 86400_000)));
    setEnd(fmtDate(new Date()));
    setPage(1);
  };

  return (
    <div className="space-y-4">
      {/* 筛选行：日期区间 + 快捷区间 + 账号 / 模型下拉 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">筛选</span>
        <input
          type="date"
          value={start}
          onChange={(e) => {
            setStart(e.target.value);
            setPage(1);
          }}
          className="input !py-1.5 !text-xs w-36"
        />
        <span className="text-xs text-slate-400">至</span>
        <input
          type="date"
          value={end}
          onChange={(e) => {
            setEnd(e.target.value);
            setPage(1);
          }}
          className="input !py-1.5 !text-xs w-36"
        />
        <button className="btn-outline !px-2 !py-1 !text-[12px]" onClick={() => setRange(0)}>
          今日
        </button>
        <button className="btn-outline !px-2 !py-1 !text-[12px]" onClick={() => setRange(6)}>
          近 7 天
        </button>
        <button className="btn-outline !px-2 !py-1 !text-[12px]" onClick={() => setRange(29)}>
          近 30 天
        </button>
        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setPage(1);
          }}
          className="input !w-auto !py-1 text-xs"
        >
          <option value="">全部账号</option>
          {accountOptions.map((a) => (
            <option key={a.user_id} value={a.user_id}>
              {a.name || a.user_id}
            </option>
          ))}
        </select>
        <select
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setPage(1);
          }}
          className="input !w-auto !py-1 text-xs"
        >
          <option value="">全部模型</option>
          {modelsUnion.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {loading && <span className="text-xs text-slate-400">加载中…</span>}
      </div>

      {/* 多会话积分合计条：未选时作功能引导，已选时实时汇总。
          空结果页不渲染引导（勾选列此时根本不存在） */}
      {selCol && (selectedCount > 0 || pageRows.length > 0) && (
        <div
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2 text-xs ${
            selectedCount > 0
              ? 'border-brand-200 bg-brand-50/60 text-slate-600 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-zinc-300'
              : 'border-dashed border-slate-200 text-slate-400 dark:border-zinc-800'
          }`}
        >
          {selectedCount > 0 ? (
            <>
              <span className="font-medium text-slate-700 dark:text-zinc-100">
                已选 {selectedCount} 条会话
              </span>
              <span>
                合计消耗{' '}
                <b className="tabular-nums text-brand-600 dark:text-brand-400">
                  {fmtCredits(selectedCredits)}
                </b>{' '}
                积分
              </span>
              {(selectedInputTokens > 0 || selectedOutputTokens > 0) && (
                <span
                  className="tabular-nums text-slate-500 dark:text-zinc-400"
                  title={`输入 ${selectedInputTokens.toLocaleString()} / 输出 ${selectedOutputTokens.toLocaleString()}`}
                >
                  Token 入/出 {fmtTokens(selectedInputTokens)} / {fmtTokens(selectedOutputTokens)}
                </span>
              )}
              <button
                className="btn-ghost !px-1.5 !py-0.5 !text-[11px] text-slate-500"
                onClick={() => setSelected({})}
              >
                清空选择
              </button>
              <span className="ml-auto text-[11px] text-slate-400">
                翻页保留选择；改筛选或刷新会清空
              </span>
            </>
          ) : (
            <span>点击任意行即可选中/取消，选中多行可合计积分消耗</span>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-600 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
          {data ? '（下方为上次成功查询的结果，可调整筛选后重试）' : '（尚无已加载数据，可调整筛选后重试）'}
        </div>
      )}

      {scope === 'qoder' && (
        <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
          Qoder 会话明细优先取自官网采集（积分看板「官网采集」逐请求落盘）；未采集时回退 API 网关本地流水。
          官网行不含 token，相关列为 0；「原价/折扣/费用」取自上游 original_credits / discount_factor / cost。
        </p>
      )}

      {data && data.total === 0 ? (
        // fetched_at > 0 表示已成功拉取过缓存：total===0 属筛选后无结果，不再引导刷新（审查 P4）
        <EmptyState
          icon={<MessagesSquare size={22} />}
          title="暂无会话明细"
          hint={
            data.fetched_at > 0
              ? '当前筛选条件下暂无会话记录，可调整时间范围、账号或模型后重试。'
              : '点击右上角「刷新数据」拉取消耗明细后查看；仅展示已拉取缓存窗口内的会话。'
          }
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-zinc-800">
            <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-zinc-50">会话明细</h3>
            <span className="text-xs text-slate-400">
              {data
                ? `共 ${data.total.toLocaleString()} 条会话 · 区间合计 ${fmtCredits(data.credits_total)} 积分`
                : ''}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200/70 bg-slate-50/70 text-[11.5px] font-medium tracking-[0.01em] text-slate-500 dark:border-zinc-800/70 dark:bg-zinc-900/40 dark:text-zinc-400">
                <tr>
                  {selCol && (
                    <th className="w-8 px-2 py-2 text-center">
                      <input
                        ref={headCbRef}
                        type="checkbox"
                        className="h-3.5 w-3.5 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                        checked={allPageSelected}
                        onChange={togglePageSelected}
                        title="全选/取消本页"
                      />
                    </th>
                  )}
                  {scope === 'qoder' && <th className="w-8" />}
                  <th className="px-4 py-2 text-left">时间</th>
                  <th className="px-4 py-2 text-left">账号</th>
                  {/* Qoder 官网无会话说明字段（name 为空）→ 该页隐藏此列，不展示空列 */}
                  {scope !== 'qoder' && <th className="px-4 py-2 text-left">会话说明</th>}
                  <th className="px-4 py-2 text-left">模型</th>
                  <th className="px-4 py-2 text-right">消耗积分</th>
                  {richColumns && (
                    <th
                      className="px-4 py-2 text-right"
                      title="输入 / 输出 token（悬停查看精确值）"
                    >
                      Token (入/出)
                    </th>
                  )}
                  {showCacheCost && (
                    <>
                      <th
                        className="px-4 py-2 text-right"
                        title="缓存读 / 缓存写 token（悬停查看精确值）"
                      >
                        缓存 (读/写)
                      </th>
                      <th className="px-4 py-2 text-right">费用</th>
                    </>
                  )}
                  {scope === 'qoder' && (
                    <>
                      <th
                        className="px-4 py-2 text-right"
                        title="官网 original_credits（折扣前原价）/ discount_factor（折扣系数）"
                      >
                        原价 / 折扣
                      </th>
                      <th className="px-4 py-2 text-right" title="官网 cost（实际费用）">
                        费用
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((r, idx) => {
                  const rowKey = rowKeyOf(r, idx);
                  return (
                    <RowWithDetail
                      key={rowKey}
                      rowKey={rowKey}
                      r={r}
                      idx={idx}
                      scope={scope}
                      selCol={selCol}
                      selected={Boolean(selected[rowKey])}
                      onToggleSelected={() => toggleSelected(rowKey, r)}
                      richColumns={richColumns}
                      showCacheCost={showCacheCost}
                      showPreview={showPreview}
                      expanded={expandedKey === rowKey}
                      detail={detail}
                      detailLoading={detailLoading}
                      detailError={detailError}
                      onToggle={() => toggleDetail(rowKey, r)}
                    />
                  );
                })}
                {data && data.rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={columnCount(scope, selCol, richColumns, showCacheCost)}
                      className="px-4 py-6 text-center text-xs text-slate-400"
                    >
                      当前筛选条件下无会话记录
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {/* 分页 */}
          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-2.5 dark:border-zinc-800">
            <span className="text-xs text-slate-400">
              第 {page} / {totalPages} 页 · 每页 {PAGE_SIZE} 条
            </span>
            <div className="flex gap-2">
              <button
                className="btn-outline !px-2.5 !py-1 text-xs"
                disabled={loading || page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <button
                className="btn-outline !px-2.5 !py-1 text-xs"
                disabled={loading || page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 单会话行 + Qoder 展开子行（「展开会话看各轮明细」）：
 * 主行与原实现同列结构；三平台行首均有勾选列，点击整行与勾选复选框同效
 * （选中/取消）；qoder 作用域另有展开 chevron，展开后请求级行以子表渲染
 * （时间 / 模型 / 积分 / Token / 轮 id）；Trae/Buddy 上游缓存无逐请求明细，
 * 展开能力仍仅 Qoder 有。
 */
function RowWithDetail({
  rowKey,
  r,
  idx,
  scope,
  selCol,
  selected,
  onToggleSelected,
  richColumns,
  showCacheCost,
  showPreview,
  expanded,
  detail,
  detailLoading,
  detailError,
  onToggle,
}: {
  rowKey: string;
  r: UsageSessionView;
  idx: number;
  scope: PlatformScope;
  /** 行首勾选列（仅 Trae / Buddy） */
  selCol: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  richColumns: boolean;
  showCacheCost: boolean;
  showPreview: boolean;
  expanded: boolean;
  detail: UsageSessionView[] | null;
  detailLoading: boolean;
  detailError: string | null;
  onToggle: () => void;
}) {
  const expandable = scope === 'qoder';
  const span = columnCount(scope, selCol, richColumns, showCacheCost);
  return (
    <>
      <tr
        className={`row-hover cursor-pointer border-t border-slate-200/70 dark:border-zinc-800${
          selected ? ' bg-brand-500/10 dark:bg-brand-500/10' : ''
        }`}
        onClick={onToggleSelected}
        title={selected ? '点击取消选中' : '点击选中加入合计'}
      >
        {selCol && (
          <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              className="h-3.5 w-3.5 cursor-pointer rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              checked={selected}
              onChange={onToggleSelected}
              title={selected ? '移出已选合计' : '加入已选合计'}
            />
          </td>
        )}
        {expandable && (
          <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
            <button
              className="btn-ghost !p-1 text-slate-400"
              title={expanded ? '收起各轮明细' : '展开各轮请求明细'}
              onClick={onToggle}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          </td>
        )}
        <td className="whitespace-nowrap px-4 py-2 text-xs tabular-nums text-slate-500">
          {fmtTime(r.ts)}
        </td>
        <td className="whitespace-nowrap px-4 py-2 text-xs">
          {r.account_name || r.user_id}
        </td>
        {/* Qoder 官网无会话说明字段 → 该页不渲染说明列 */}
        {scope !== 'qoder' && (
          <td
            className="max-w-[260px] truncate px-4 py-2 text-xs"
            title={showPreview ? r.preview : undefined}
          >
            {showPreview ? r.preview || '—' : '—'}
          </td>
        )}
        <td className="whitespace-nowrap px-4 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <span>{r.model}</span>
            {r.mode && (
              <Badge tone="slate" title="会话模式">
                {r.mode}
              </Badge>
            )}
          </div>
        </td>
        <td className="px-4 py-2 text-right text-xs tabular-nums">
          {fmtCredits(r.credits)}
        </td>
        {richColumns && (
          <td
            className="px-4 py-2 text-right text-xs tabular-nums text-slate-500"
            title={
              r.input_tokens || r.output_tokens
                ? `输入 ${r.input_tokens.toLocaleString()} / 输出 ${r.output_tokens.toLocaleString()}`
                : undefined
            }
          >
            {r.input_tokens || r.output_tokens
              ? `${fmtTokens(r.input_tokens)} / ${fmtTokens(r.output_tokens)}`
              : '—'}
          </td>
        )}
        {showCacheCost && (
          <>
            <td
              className="px-4 py-2 text-right text-xs tabular-nums text-slate-400"
              title={
                r.cache_read_tokens || r.cache_write_tokens
                  ? `缓存读 ${r.cache_read_tokens.toLocaleString()} / 缓存写 ${r.cache_write_tokens.toLocaleString()}`
                  : undefined
              }
            >
              {r.cache_read_tokens || r.cache_write_tokens
                ? `${fmtTokens(r.cache_read_tokens)} / ${fmtTokens(r.cache_write_tokens)}`
                : '—'}
            </td>
            <td className="px-4 py-2 text-right text-xs tabular-nums text-slate-500">
              {r.cost_money > 0 ? `$${r.cost_money.toFixed(4)}` : '—'}
            </td>
          </>
        )}
        {scope === 'qoder' && (
          <>
            <td
              className="whitespace-nowrap px-4 py-2 text-right text-xs tabular-nums text-slate-500"
              title={
                r.original_cost != null ? `原价费用 ${r.original_cost.toFixed(4)}` : undefined
              }
            >
              {r.original_credits != null
                ? `${fmtCredits(r.original_credits)}${
                    r.discount_factor != null && r.discount_factor > 0 && r.discount_factor < 1
                      ? ` · ${(r.discount_factor * 10).toFixed(1).replace(/\.0$/, '')} 折`
                      : ''
                  }`
                : '—'}
            </td>
            <td className="px-4 py-2 text-right text-xs tabular-nums text-slate-500">
              {r.cost_money > 0 ? r.cost_money.toFixed(4) : '—'}
            </td>
          </>
        )}
      </tr>
      {expandable && expanded && (
        <tr key={`${rowKey}-detail`} className="border-t border-slate-100 bg-slate-50/60 dark:border-zinc-800 dark:bg-zinc-900/60">
          <td colSpan={span} className="px-6 py-2">
            {detailLoading && (
              <div className="flex items-center gap-2 py-1 text-xs text-slate-400">
                <Spinner /> 加载各轮明细…
              </div>
            )}
            {detailError && (
              <div className="py-1 text-xs text-rose-500">各轮明细查询失败：{detailError}</div>
            )}
            {!detailLoading && !detailError && (
              <div className="space-y-1">
                <div className="text-xs text-slate-400">
                  共 {detail?.length ?? 0} 条请求（键口径：会话 ∪ 同说明；已被定时合并的历史区间仅剩聚合行）
                </div>
                {(detail ?? []).map((d, i) => (
                  <div
                    key={`${rowKey}-d-${i}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs tabular-nums"
                  >
                    <span className="text-slate-500">{fmtTime(d.ts)}</span>
                    <span>{d.model}</span>
                    <span className="text-slate-500">
                      {fmtCredits(d.credits)} 积分 ·{' '}
                      {d.input_tokens || d.output_tokens
                        ? `${fmtTokens(d.input_tokens)} / ${fmtTokens(d.output_tokens)}`
                        : '—'}{' '}
                      token
                    </span>
                    {d.preview && (
                      <span className="max-w-[240px] truncate text-slate-400" title={d.preview}>
                        {d.preview}
                      </span>
                    )}
                    {d.original_credits != null && (
                      <span className="text-slate-400">
                        原价 {fmtCredits(d.original_credits)}
                        {d.discount_factor != null && d.discount_factor > 0 && d.discount_factor < 1
                          ? ` · ${(d.discount_factor * 10).toFixed(1).replace(/\.0$/, '')} 折`
                          : ''}
                      </span>
                    )}
                    {d.cost_money > 0 && (
                      <span className="text-slate-400">费用 {d.cost_money.toFixed(4)}</span>
                    )}
                    {d.record_id && (
                      <span className="font-mono text-slate-300 dark:text-zinc-600" title={`轮键 ${d.record_id}`}>
                        轮 {d.record_id.slice(0, 8)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
