import { RefreshCw, X } from 'lucide-react';
import { Badge } from '../../components/ui';
import type { QoderWebUsageAccount } from '../../types';

/** 采集目标（Qoder 池账号） */
export interface QoderWebCollectTarget {
  id: string;
  name: string;
}

/**
 * Qoder 官网采集账号选择弹框（多账号独立采集）。
 * 每个账号使用独立 Webview 数据目录，登录态互不影响；已采集账号显示校验状态与采集时间。
 */
export default function QoderWebCollectDialog({
  open,
  targets,
  collected,
  collectingId,
  onClose,
  onPick,
}: {
  open: boolean;
  targets: QoderWebCollectTarget[];
  /** account_id → 已采集摘要 */
  collected: Map<string, QoderWebUsageAccount>;
  /** 正在采集的账号（null = 空闲） */
  collectingId: string | null;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="card w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-50">选择要采集官网用量的账号</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              每个账号使用独立窗口数据目录（登录态互不影响）。采集时请在该窗口登录对应账号，
              结果按账号归档并做 uid 校验。
            </p>
          </div>
          <button className="btn-outline shrink-0" onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="mt-3 max-h-[60vh] divide-y divide-slate-100 overflow-y-auto dark:divide-zinc-800">
          {targets.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">Qoder 池暂无账号，请先在账号管理导入。</p>
          ) : (
            targets.map((t) => {
              const hit = collected.get(t.id);
              return (
                <div key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-slate-800 dark:text-zinc-100">{t.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                      {hit ? (
                        <>
                          <Badge tone={hit.verified ? 'green' : 'amber'}>
                            {hit.verified ? '已校验' : '未校验'}
                          </Badge>
                          <span>今日已用 {hit.summary.usage_today.toFixed(2)}</span>
                          <span>·</span>
                          <span>{hit.records_total} 条</span>
                          <span>·</span>
                          <span>{new Date(hit.fetched_at_ms).toLocaleString('zh-CN', { hour12: false })}</span>
                        </>
                      ) : (
                        <span>未采集</span>
                      )}
                    </div>
                  </div>
                  <button
                    className="btn-outline shrink-0 text-xs"
                    onClick={() => onPick(t.id)}
                    disabled={collectingId != null}
                  >
                    <RefreshCw size={13} className={collectingId === t.id ? 'animate-spin' : ''} />
                    {hit ? '重新采集' : '采集'}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}