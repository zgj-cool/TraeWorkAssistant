import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

/**
 * 移除 index.html 的首屏骨架。
 *
 * 注：窗口「何时显示」由 Rust 侧决定（`main_window_ready` 命令 + 兜底超时），
 * 握手发生在 index.html 的注入脚本里——骨架是纯 CSS，首帧即可绘制完，
 * 不能等这个 1.6MB 的 React bundle 解析完才让窗口出现。
 * 这里只负责 React 首帧画好之后把骨架淡出，避免硬切。
 */
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const bootSplash = document.getElementById('boot-splash');
    if (bootSplash) {
      bootSplash.style.opacity = '0';
      bootSplash.style.pointerEvents = 'none';
      window.setTimeout(() => bootSplash.remove(), 220);
    }
  });
});
