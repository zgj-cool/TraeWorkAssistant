import { cn } from '../lib/cn';

/** 品牌标识：实心圆角方块内的机器人（AI）图形。
 *  浅色=深底白标、深色=浅底深标（与主按钮的反相语言一致），不使用渐变以保持清爽。 */
export function BrandMark({
  size = 24,
  iconSize = 14,
  className,
}: {
  size?: number;
  iconSize?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center bg-zinc-900 text-white ring-1 ring-inset ring-white/10 dark:bg-zinc-100 dark:text-zinc-900 dark:ring-black/5',
        className,
      )}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
    >
      <svg
        viewBox="0 0 24 24"
        style={{ width: iconSize, height: iconSize }}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2" />
        <path d="M20 14h2" />
        <path d="M15 13v2" />
        <path d="M9 13v2" />
      </svg>
    </span>
  );
}

export default BrandMark;
