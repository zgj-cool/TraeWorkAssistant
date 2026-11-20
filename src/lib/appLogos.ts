import traeLogo from '../assets/logos/trae.png';
import workbuddyLogo from '../assets/logos/workbuddy.svg';
import qoderLogo from '../assets/logos/qoder.svg';
import doubaoLogo from '../assets/logos/doubao.png';
import type { AppKey } from '../types';

/**
 * 各应用官方 logo（取自各产品官网资源）：
 * Trae = trae.ai favicon.png / Buddy 与 BuddyAI = workbuddy.ai logo.svg /
 * Qoder = qoder.com favIcon.svg / 豆包 = doubao.com 192x192 图标。
 * 侧边栏应用 Tab 与总览平台卡片共用，避免图标口径分叉。
 */
export const APP_LOGOS: Record<AppKey, string> = {
  trae: traeLogo,
  buddy: workbuddyLogo,
  qoder: qoderLogo,
  doubao: doubaoLogo,
  'buddy-ai': workbuddyLogo,
};
