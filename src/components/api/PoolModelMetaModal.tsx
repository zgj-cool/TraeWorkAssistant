import { useEffect, useRef, useState } from 'react';
import { Eraser, Save } from 'lucide-react';
import { Modal, Spinner } from '../ui';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import { withMinDelay } from '../../lib/delay';
import type { TraeModelMeta, TraeRateWindow } from '../../types';

/**
 * Buddy/Qoder 模型目录池级人工覆盖编辑弹框（kv pool_model_meta，键 pool|canonical）。
 *
 * 背景：Trae 源有 L1 覆盖层编辑（trae_model_meta），Buddy/Qoder 目录此前是
 * 「上游同步整表替换」的只读镜像。本弹框维护覆盖层，字段与 TraeModelMeta
 * 同构；目录同步只写各自目录键、永不覆盖人工值（文件隔离）。生效字段：
 * 展示名（label）/ 基准倍率（rate）/ 倍率时段规则（rate_windows，闲时折扣，
 * 与 Trae 同语义）/ 单模型启用（enabled=false = 该池不再作为此模型的源）。
 */

/** 表单数值解析：空串 → null（未设置）；非法数字或负数返回 NaN 由调用方拦截 */
const numOrNull = (s: string) => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  // 倍率无负值语义；min="0" 只约束 spinner，需在保存侧拦截
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

const POOL_LABELS: Record<'buddy' | 'qoder', string> = { buddy: 'Buddy', qoder: 'Qoder' };

export default function PoolModelMetaModal({
  pool,
  model,
  onClose,
  onSaved,
}: {
  pool: 'buddy' | 'qoder';
  /** null = 关闭态 */
  model: { id: string } | null;
  onClose: () => void;
  /** 保存/清除成功后回调（父页面刷新目录展示） */
  onSaved: () => void;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [label, setLabel] = useState('');
  const [rate, setRate] = useState('');
  // 倍率时段规则行级表单（与 Trae 编辑弹框同款交互）
  const [windows, setWindows] = useState<
    { start: string; end: string; rate: string; label: string }[]
  >([]);
  const [enabled, setEnabled] = useState<'' | 'true' | 'false'>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [hasManual, setHasManual] = useState(false);
  // 回显请求序号令牌：仅最后一次请求回填，防快速重开慢响应覆盖新弹框
  const reqSeq = useRef(0);

  useEffect(() => {
    if (!model) return;
    reqSeq.current += 1;
    const seq = reqSeq.current;
    setLoading(true);
    setLabel('');
    setRate('');
    setWindows([]);
    setEnabled('');
    setHasManual(false);
    void api.apiServer
      .poolMetaGet(pool, model.id)
      .then((known) => {
        if (reqSeq.current !== seq) return;
        setHasManual(known != null);
        setLabel(known?.label ?? '');
        setRate(known?.rate != null ? String(known.rate) : '');
        setWindows(
          (known?.rate_windows ?? []).map((w) => ({
            start: w.start,
            end: w.end,
            rate: String(w.rate),
            label: w.label ?? '',
          })),
        );
        setEnabled(known?.enabled === true ? 'true' : known?.enabled === false ? 'false' : '');
      })
      .catch(() => {})
      .finally(() => {
        if (reqSeq.current === seq) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, model?.id]);

  if (!model) return null;
  const inputCls =
    'h-7 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-brand-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200';
  const metaInputCls = loading ? `${inputCls} opacity-60` : inputCls;

  const save = async () => {
    const rateNum = numOrNull(rate);
    if (Number.isNaN(rateNum)) {
      pushToast('error', '数值字段格式不正确，请检查倍率');
      return;
    }
    // 时段规则：时刻须为合法 HH:MM、倍率须为非负有限数、起止不得相等
    const wins: TraeRateWindow[] = [];
    for (const [i, w] of windows.entries()) {
      const start = w.start.trim();
      const end = w.end.trim();
      const wr = numOrNull(w.rate);
      const validHhmm = (s: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);
      if (!validHhmm(start) || !validHhmm(end)) {
        pushToast('error', `第 ${i + 1} 条时段规则：时刻格式应为 HH:MM（如 12:00）`);
        return;
      }
      if (start === end) {
        pushToast('error', `第 ${i + 1} 条时段规则：起止时刻不能相同`);
        return;
      }
      if (wr == null || Number.isNaN(wr)) {
        pushToast('error', `第 ${i + 1} 条时段规则：窗口倍率必填且不能为负`);
        return;
      }
      wins.push({ start, end, rate: wr, label: w.label.trim() || null });
    }
    const meta: TraeModelMeta = {
      label: label.trim() || null,
      rate: rateNum,
      // 空列表 = 未设置（不落空数组）
      rate_windows: wins.length > 0 ? wins : null,
      enabled: enabled === '' ? null : enabled === 'true',
    };
    setSaving(true);
    try {
      await withMinDelay(api.apiServer.poolMetaSet(pool, model.id, meta), 300);
      pushToast(
        'success',
        `已保存 ${model.id} 人工覆盖（${POOL_LABELS[pool]} 池；目录同步不覆盖人工值）`,
      );
      onClose();
      onSaved();
    } catch (err) {
      pushToast('error', `保存失败：${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const clearMeta = async () => {
    setClearing(true);
    try {
      await withMinDelay(api.apiServer.poolMetaClear(pool, model.id), 300);
      pushToast('success', `已清除 ${model.id} 人工覆盖，恢复上游同步值`);
      onClose();
      onSaved();
    } catch (err) {
      pushToast('error', `清除失败：${String(err)}`);
    } finally {
      setClearing(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => {
        if (saving || clearing || loading) return;
        onClose();
      }}
      title={`编辑人工覆盖 · ${POOL_LABELS[pool]} · ${model.id}`}
      footer={
        <>
          {hasManual && (
            <button
              className="btn-outline mr-auto flex items-center gap-1"
              onClick={() => void clearMeta()}
              disabled={clearing || saving || loading}
              title="清除人工覆盖，恢复上游同步值"
            >
              <Eraser size={14} />
              {clearing ? '清除中…' : '清除人工值'}
            </button>
          )}
          <button className="btn-ghost" onClick={onClose} disabled={saving || clearing}>
            取消
          </button>
          <button
            className="btn-primary flex items-center gap-1"
            onClick={() => void save()}
            disabled={saving || loading || clearing}
          >
            {saving ? <Spinner className="text-white" /> : <Save size={15} />}
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <p className="mb-3 text-xs text-slate-400 dark:text-zinc-500">
        人工覆盖优先于上游同步值（目录同步<b>不会覆盖</b>人工值）；<b>留空 = 未设置</b>，
        交由上游目录数据。
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-slate-500 dark:text-zinc-400">展示名</label>
          <input
            className={metaInputCls}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="留空 = 上游目录名"
            disabled={loading}
          />
        </div>
        <div>
          <label
            className="mb-1 block text-xs text-slate-500 dark:text-zinc-400"
            title="折扣窗口外的基准倍率；窗口内取值由下方「倍率时段规则」决定"
          >
            积分倍率（基准）
          </label>
          <input
            className={metaInputCls}
            type="number"
            step="0.01"
            min="0"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="留空 = 上游目录倍率"
            disabled={loading}
          />
        </div>
        <div className="col-span-2">
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-xs text-slate-500 dark:text-zinc-400">
              倍率时段规则（闲时折扣）
            </label>
            <button
              type="button"
              className="btn-ghost !px-1.5 !py-0.5 text-[11px]"
              disabled={loading}
              onClick={() =>
                setWindows((prev) => [...prev, { start: '12:00', end: '14:00', rate: '', label: '' }])
              }
            >
              + 添加时段
            </button>
          </div>
          {windows.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-200 px-2 py-2 text-[11px] text-slate-400 dark:border-zinc-700 dark:text-zinc-500">
              未配置 — 全天使用基准倍率
            </p>
          ) : (
            <div className="space-y-1.5">
              {windows.map((w, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    className={`${metaInputCls} !w-24`}
                    type="time"
                    value={w.start}
                    disabled={loading}
                    onChange={(e) =>
                      setWindows((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)),
                      )
                    }
                  />
                  <span className="text-xs text-slate-400">–</span>
                  <input
                    className={`${metaInputCls} !w-24`}
                    type="time"
                    value={w.end}
                    disabled={loading}
                    onChange={(e) =>
                      setWindows((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)),
                      )
                    }
                  />
                  <input
                    className={`${metaInputCls} !w-20`}
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="倍率"
                    value={w.rate}
                    disabled={loading}
                    onChange={(e) =>
                      setWindows((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)),
                      )
                    }
                  />
                  <input
                    className={metaInputCls}
                    placeholder="备注（如 午间闲时）"
                    value={w.label}
                    disabled={loading}
                    onChange={(e) =>
                      setWindows((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="btn-ghost !px-1.5 !py-0.5 text-[11px] text-rose-500"
                    disabled={loading}
                    title="删除该时段"
                    onClick={() => setWindows((prev) => prev.filter((_, j) => j !== i))}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="mt-1 text-[11px] leading-4 text-slate-400 dark:text-zinc-500">
            命中窗口按窗口倍率计费与调度，未命中回落基准倍率；结束早于开始表示跨午夜
            （如 22:00–08:00）。时段生效中时目录倍率列会标注「闲时」并回显基准值。
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500 dark:text-zinc-400">模型启用</label>
          <select
            className={metaInputCls}
            value={enabled}
            onChange={(e) => setEnabled(e.target.value as '' | 'true' | 'false')}
            disabled={loading}
          >
            <option value="">未设置（默认启用）</option>
            <option value="true">启用</option>
            <option value="false">禁用（不路由 {POOL_LABELS[pool]} 源）</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}
