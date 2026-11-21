import { type ReactNode } from 'react';

/** 页头：标题 + 描述 + 右侧操作区。
 *  清爽化：去掉重色竖条装饰，靠字号/字距/留白建立层次，长描述限宽提升可读性。 */
export default function PageHeader({
  title,
  desc,
  actions,
  leftExtra,
}: {
  title: string;
  desc?: string;
  actions?: ReactNode;
  /** 左侧区域附加元素（紧跟在标题/描述文字后面） */
  leftExtra?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[21px] font-semibold leading-7 tracking-[-0.02em] text-slate-900 dark:text-zinc-50">
          {title}
        </h1>
        {(desc || leftExtra) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {desc && (
              <p className="max-w-4xl text-[13px] leading-relaxed text-slate-500 dark:text-zinc-400">
                {desc}
              </p>
            )}
            {leftExtra}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
