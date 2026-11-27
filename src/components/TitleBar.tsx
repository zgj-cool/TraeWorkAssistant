import { useEffect, useState } from 'react';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { Copy, Minus, Square, X } from 'lucide-react';
import { useAppStore } from '../store';
import { Modal } from './ui';
import { APP_NAME } from '../lib/about';
import { BrandMark } from './BrandMark';
import { cn } from '../lib/cn';

const win = getCurrentWindow();

export default function TitleBar() {
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const proxyRunning = useAppStore((s) => s.proxy.running);

  // issue #46：跟踪窗口真实最大化状态——toggleMaximize 在无边框窗口 hide/show 后
  // 可能与内部状态失同步（视觉已还原但 isMaximized() 仍为 true，点最大化无反应），
  // 改为显式判断 + 图标随状态切换。
  // 冷启动补充：窗口直接以工作区尺寸建出（不调 Win32 maximize，避免尺寸跳变重绘），
  // 此时 isMaximized() 恒为 false，需叠加 Rust 侧的「逻辑最大化」标记。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    const sync = async () => {
      // 物理最大化（用户点过最大化按钮）与逻辑最大化（启动即铺满）取或：
      // 两种形态在视觉上都是满屏，标题栏图标应一致
      const [physical, logical] = await Promise.all([
        win.isMaximized().catch(() => false),
        invoke<boolean>('window_logically_maximized').catch(() => false),
      ]);
      if (alive) setMaximized(physical || logical);
    };
    void (async () => {
      await sync();
      unlisten = await win.onResized(() => void sync());
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const toggleMaximize = async () => {
    // 判定同样取「物理 || 逻辑」：逻辑最大化时 isMaximized() 为假，
    // 若只看它会把「还原」误判成「最大化」（点一下没反应）
    const [physical, logical] = await Promise.all([
      win.isMaximized().catch(() => false),
      invoke<boolean>('window_logically_maximized').catch(() => false),
    ]);
    const isMax = physical || logical;
    if (isMax) {
      await win.unmaximize();
      // 还原到建窗默认尺寸（逻辑最大化时窗口尺寸本就是工作区，unmaximize 不会生效）
      await win.setSize(new LogicalSize(1180, 760));
      await win.center();
    } else {
      await win.maximize();
    }
    // 同步逻辑标记并刷新图标
    await invoke('window_logical_zoom_set', { maximized: !isMax }).catch(() => {});
    setMaximized(!isMax);
  };

  return (
    <>
      <div className="app-titlebar flex h-10 shrink-0 items-center justify-between border-b border-slate-200/70 bg-white pl-3 pr-1 dark:border-zinc-800/70 dark:bg-zinc-950">
        <div data-tauri-drag-region className="flex flex-1 items-center gap-2">
          <BrandMark size={22} iconSize={13} />
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-slate-800 dark:text-zinc-100">
            {APP_NAME}
          </span>
        </div>
        <div className="flex items-center">
          {/* onMouseDown 阻止冒泡：否则事件冒泡到外层 data-tauri-drag-region，Tauri 会启动窗口拖拽而吞掉 click，导致最小/最大化/关闭无响应 */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => void invoke('minimize_to_tray')}
            className={cn(winBtn)}
            aria-label="最小化"
            title="最小化到托盘"
          >
            <Minus size={15} />
          </button>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => void toggleMaximize()}
            className={cn(winBtn)}
            aria-label={maximized ? '还原' : '最大化'}
            title={maximized ? '向下还原' : '最大化'}
          >
            {maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setShowCloseConfirm(true)}
            className="flex h-8 w-10 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-rose-500 hover:text-white active:bg-rose-600 dark:text-zinc-400"
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <Modal
        open={showCloseConfirm}
        onClose={() => setShowCloseConfirm(false)}
        title="确认退出应用"
        footer={
          <>
            <button className="btn-outline" onClick={() => setShowCloseConfirm(false)}>
              取消
            </button>
            <button className="btn-danger" onClick={() => void win.close()}>
              确认退出
            </button>
          </>
        }
      >
        {proxyRunning ? (
          <p className="leading-relaxed">
            检测到代理正在运行，退出时将自动关闭代理并还原系统代理设置。
            <br />
            确认退出 {APP_NAME}？
          </p>
        ) : (
          <p className="leading-relaxed">确认退出 {APP_NAME}？</p>
        )}
      </Modal>
    </>
  );
}

/** 窗口按钮（最小化 / 最大化）：统一的弱化色，hover 仅提亮底色 */
const winBtn =
  'flex h-8 w-10 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 active:bg-slate-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100';
