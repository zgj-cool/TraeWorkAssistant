/**
 * 全局 API 管理 · 模型同义组（kv model_alias，model_alias_get/set）
 *
 * 背景：同一模型在各资源池的上游 id 不同（如 Trae `DeepSeek-V4-Pro-Official` /
 * Buddy `deepseek-v4-pro`），客户端只想配一个名字却得为每个 id 各配一份。
 *
 * 本面板维护「对外 id + 各池成员」，语义是**请求入口的前置判断**：
 * - 仅对外 id 触发映射（成员 id 自身请求仍按原路由，零行为差异）；
 * - 不影响模型目录：/v1/models 与各资源页的模型目录完全不变，对外名不会出现在目录里，
 *   客户端需手动填写该名字；未列成员的池按请求名命中自身同名模型。
 * 整表覆盖保存，后端校验后落库即时生效。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Plus, Save } from 'lucide-react';
import { Badge, Spinner } from '../ui';
import { api } from '../../lib/tauri';
import { useAppStore } from '../../store';
import type { ModelAliasGroup, ModelAliasMember, UnifiedModel } from '../../types';

/** 可选池（与后端 model_alias::POOLS 一致） */
const POOLS: { value: string; label: string }[] = [
  { value: 'trae', label: 'Trae' },
  { value: 'buddy', label: 'Buddy' },
  { value: 'buddy-ai', label: 'BuddyAi' },
  { value: 'qoder', label: 'Qoder' },
  { value: 'custom', label: '自定义' },
];

const poolLabel = (pool: string) => POOLS.find((p) => p.value === pool)?.label ?? pool;

/** 组行（稳定 key 包装：新增/删除中间行时受控输入不串焦点） */
type GroupRow = { key: number; group: ModelAliasGroup };

/** 空成员行 */
const emptyMember = (pool = 'trae'): ModelAliasMember => ({ pool, model: '' });

/** 空组 */
const emptyGroup = (): ModelAliasGroup => ({
  id: '',
  members: [emptyMember()],
  note: '',
  enabled: true,
});

export default function ModelAliasPanel() {
  const toast = useAppStore((s) => s.pushToast);
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [savedGroups, setSavedGroups] = useState<ModelAliasGroup[]>([]);
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [file, list] = await Promise.all([
        api.apiServer.modelAliasGet(),
        api.apiServer.unifiedModels(),
      ]);
      setRows(file.groups.map((group) => ({ key: ++seq.current, group })));
      setSavedGroups(file.groups);
      setModels(list);
    } catch (e) {
      toast('error', `加载模型同义组失败：${e}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(rows.map((r) => r.group)) !== JSON.stringify(savedGroups),
    [rows, savedGroups],
  );

  /** 某池的可选模型 id（目录内该池可服务的条目；允许手工输入目录外 id） */
  const candidatesFor = useCallback(
    (pool: string) => {
      const set = new Set<string>();
      for (const m of models) {
        if (m.sources.some((s) => s.pool === pool && !s.disabled)) set.add(m.id);
      }
      return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    },
    [models],
  );

  const patchGroup = (i: number, patch: Partial<ModelAliasGroup>) => {
    setRows((rs) =>
      rs.map((row, k) => (k === i ? { ...row, group: { ...row.group, ...patch } } : row)),
    );
  };

  const patchMember = (i: number, j: number, patch: Partial<ModelAliasMember>) => {
    setRows((rs) =>
      rs.map((row, k) => {
        if (k !== i) return row;
        const members = row.group.members.map((m, x) => (x === j ? { ...m, ...patch } : m));
        return { ...row, group: { ...row.group, members } };
      }),
    );
  };

  /** 保存前置校验（与后端 model_alias::validate 同口径，后端仍为准） */
  const validate = (): string | null => {
    const ids = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const g = rows[i].group;
      const id = g.id.trim().toLowerCase();
      if (!id) return `第 ${i + 1} 组：对外模型名不能为空`;
      if (ids.has(id)) return `对外模型名重复：${g.id.trim()}（每组必须唯一）`;
      ids.add(id);
      if (g.members.length === 0) return `${g.id.trim()}：至少需要一个池成员`;
      const pools = new Set<string>();
      for (const m of g.members) {
        const model = m.model.trim();
        if (!m.pool) return `${g.id.trim()}：成员缺少资源池`;
        if (!model) return `${g.id.trim()}：${poolLabel(m.pool)} 池成员模型名不能为空`;
        if (pools.has(m.pool)) return `${g.id.trim()}：${poolLabel(m.pool)} 池重复配置`;
        pools.add(m.pool);
      }
    }
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) {
      toast('warn', err);
      return;
    }
    setSaving(true);
    try {
      const groups = rows.map((r) => ({
        ...r.group,
        id: r.group.id.trim(),
        note: r.group.note.trim(),
        members: r.group.members.map((m) => ({ pool: m.pool, model: m.model.trim() })),
      }));
      const file = await api.apiServer.modelAliasSet(groups);
      setRows(file.groups.map((group) => ({ key: ++seq.current, group })));
      setSavedGroups(file.groups);
      toast('success', '模型同义组已保存，下一条请求即生效');
    } catch (e) {
      toast('error', `保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 说明条 */}
      <div className="flex items-start gap-2 rounded-lg border border-brand-300/60 bg-brand-50/70 px-3 py-2 text-xs text-brand-800 dark:border-brand-700/40 dark:bg-brand-500/10 dark:text-brand-200">
        <Layers size={16} className="mt-0.5 shrink-0" />
        <div>
          <p>
            同一模型在各池上游 id 不同（如 Trae 的 <code>DeepSeek-V4-Pro-Official</code> 与
            Buddy 的 <code>deepseek-v4-pro</code>）时，可在此绑定为一个「对外模型名」：
            只有请求这个对外名时，网关才按调度命中池改用该池真实 id。
          </p>
          <p className="mt-1 opacity-80">
            同义组只是请求入口的前置判断，<span className="font-medium">不影响模型目录</span>：
            /v1/models 与各资源页的模型目录完全不变，对外名不会出现在目录里（客户端需手动
            填写）；成员 id 自身请求也保持原路由。未列成员的池按请求名命中其自身同名模型
            （如 Buddy/Qoder 本身就叫 deepseek-v4-pro，无需重复列入成员）。
          </p>
        </div>
      </div>

      {/* 操作条 */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">同义组</span>
        <span className="text-xs text-slate-400">{rows.length} 组</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setRows((rs) => [...rs, { key: ++seq.current, group: emptyGroup() }])}
            className="flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Plus size={13} />
            新增同义组
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-40"
          >
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save size={13} />}
            保存
          </button>
        </div>
      </div>

      {rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400 dark:border-zinc-700 dark:text-zinc-500">
          未配置同义组：模型目录与调度保持原样（零行为差异）。点击「新增同义组」开始。
        </div>
      )}

      {/* 组卡片 */}
      <div className="space-y-2">
        {rows.map(({ key, group: g }, i) => (
          <div
            key={key}
            className={`rounded-lg border border-slate-200 p-3 dark:border-zinc-700 ${g.enabled ? '' : 'opacity-60'}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-slate-400">
                #{i + 1}
              </span>
              <input
                value={g.id}
                onChange={(e) => patchGroup(i, { id: e.target.value })}
                placeholder="对外模型名（客户端配置这个，如 deepseek-v4-pro）"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs text-slate-700 outline-none focus:border-brand-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              />
              <Badge tone={g.enabled ? 'green' : 'slate'}>{g.enabled ? '启用' : '停用'}</Badge>
              <label className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-xs text-slate-500 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={g.enabled}
                  onChange={(e) => patchGroup(i, { enabled: e.target.checked })}
                  className="accent-brand-500"
                />
                启用
              </label>
              <button
                onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-rose-500 transition hover:bg-rose-50 dark:hover:bg-rose-900/20"
              >
                删除
              </button>
            </div>

            {/* 成员行 */}
            <div className="mt-2 space-y-1.5 pl-10">
              {g.members.map((m, j) => {
                const candidates = candidatesFor(m.pool);
                const listId = `alias-models-${key}-${j}`;
                return (
                  <div key={`${key}-${j}`} className="flex items-center gap-2">
                    <select
                      value={m.pool}
                      onChange={(e) => patchMember(i, j, { pool: e.target.value })}
                      className="w-28 shrink-0 rounded-md border border-slate-200 bg-white px-1.5 py-1.5 text-xs text-slate-700 outline-none focus:border-brand-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                    >
                      {POOLS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <input
                      value={m.model}
                      onChange={(e) => patchMember(i, j, { model: e.target.value })}
                      list={listId}
                      placeholder={`${poolLabel(m.pool)} 池真实模型 id（可下拉选择或手填）`}
                      spellCheck={false}
                      className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs text-slate-700 outline-none focus:border-brand-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                    />
                    <datalist id={listId}>
                      {candidates.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                    <button
                      onClick={() =>
                        setRows((rs) =>
                          rs.map((row, k) =>
                            k === i
                              ? {
                                  ...row,
                                  group: {
                                    ...row.group,
                                    members: row.group.members.filter((_, x) => x !== j),
                                  },
                                }
                              : row,
                          ),
                        )
                      }
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:text-rose-500"
                    >
                      移除
                    </button>
                  </div>
                );
              })}
              <button
                onClick={() =>
                  setRows((rs) =>
                    rs.map((row, k) =>
                      k === i
                        ? { ...row, group: { ...row.group, members: [...row.group.members, emptyMember()] } }
                        : row,
                    ),
                  )
                }
                className="flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-500 transition hover:border-brand-400 hover:text-brand-500 dark:border-zinc-700 dark:text-zinc-400"
              >
                <Plus size={12} />
                添加成员
              </button>
            </div>

            <div className="mt-2 pl-10">
              <input
                value={g.note}
                onChange={(e) => patchGroup(i, { note: e.target.value })}
                placeholder="备注（可选）"
                className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-brand-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}