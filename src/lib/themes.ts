/** 主题定义（与 index.css 中 data-theme 覆盖块一一对应） */

export interface ThemeDef {
  id: string;
  name: string;
  dark: boolean;
}

/** 全部主题（顺序即侧栏主题气泡里的展示顺序） */
export const THEMES: ThemeDef[] = [
  { id: 'graphite', name: '浅色', dark: false },
  { id: 'charcoal', name: '深色', dark: true },
  { id: 'violet-night', name: '暗夜紫', dark: true },
  { id: 'ink-green', name: '墨绿', dark: true },
  { id: 'tech-blue', name: '科技蓝', dark: true },
  { id: 'neon-forest', name: '荧光墨绿', dark: true },
  { id: 'neon-ocean', name: '荧光浅蓝', dark: true },
];

export const DEFAULT_THEME = 'charcoal';

/** 兼容旧值（light/dark/system），解析为主题定义；system 按系统偏好；未知值归一为默认主题 */
export function resolveTheme(
  raw: string | undefined,
  systemPrefersDark: boolean,
): ThemeDef {
  if (raw) {
    const hit = THEMES.find((t) => t.id === raw);
    if (hit) return hit;
    if (raw === 'light') return THEMES[0];
    if (raw === 'dark') return THEMES[1];
    // 已下线的主题（如 amber-night）与其它未知值一律归一为默认主题，
    // 避免外部脏数据落库后 UI 走兜底分支不一致
    return THEMES.find((t) => t.id === DEFAULT_THEME) ?? THEMES[1];
  }
  return systemPrefersDark ? THEMES[1] : THEMES[0];
}
