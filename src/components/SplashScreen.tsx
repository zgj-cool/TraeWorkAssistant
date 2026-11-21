import { APP_NAME } from '../lib/about';
import { BrandMark } from './BrandMark';

/** 启动加载页（方案 A · 极简细线）：
 *  居中品牌标识 + 产品名，下方发丝进度线 + 呼吸三点。
 *  纯展示、无数据依赖——在 store.ready 之前渲染，取代原来的不可见 spinner。
 *
 *  注意：这里**不放入场动画**。它要与 index.html 的首屏骨架无缝衔接
 *  （骨架先显示、React 接管后淡出），任一侧带头 opacity:0 的入场动画，
 *  交接瞬间都会出现「只有底色没有内容」的一闪（深色主题下即黑闪）。 */
export default function SplashScreen({ status = '正在加载本地数据' }: { status?: string }) {
  return (
    <div
      className="flex h-full items-center justify-center bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex flex-col items-center">
        <div className="flex items-center gap-2.5">
          <BrandMark size={34} iconSize={19} />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">{APP_NAME}</span>
        </div>
        <div className="mt-6 flex flex-col items-center gap-4">
          <span className="inline-flex items-center gap-2 text-[12px] text-slate-500 dark:text-zinc-400">
            {status}
            <span className="splash-dots">
              <i />
              <i />
              <i />
            </span>
          </span>
          <span className="splash-bar">
            <i />
          </span>
        </div>
      </div>
    </div>
  );
}
