import type { CSSProperties } from 'react';
import { useIsDark } from './useIsDark';

/**
 * 图表视觉基线（第三批：配色收敛）。
 *
 * 目标：从「每个图表各挑一套彩虹色」收敛为 **中性灰阶 + 单强调色**：
 * - 网格 / 坐标轴 / tooltip 一律中性（跟随浅深色）；
 * - 主系列（消耗、请求量、调用次数）用强调色 `accent`（暖铜，与「积分消耗」的语义色一致）；
 * - 次系列（获得 / 输出）用 `accentSoft`（绿，表示收入类数据）；
 * - 多系列排行（各模型趋势、Token 分项）走中性墨阶 `ramp`，只有 Top1 用强调色，
 *   让「最大项」自然成为视觉焦点，其余按灰阶退后；
 * - 热力图走中性墨阶（不再用 GitHub 绿），与整体基调一致。
 *
 * 用法：`const t = useChartTheme();` 然后 `stroke={t.accent}` / `{...t.axis}` /
 * `contentStyle={t.tooltip}` / `stroke={t.grid}`。新增图表请勿再硬编码十六进制色值。
 */

export interface ChartTheme {
  isDark: boolean;
  /** 网格线（极淡，仅作参考） */
  grid: string;
  /** 坐标轴线 */
  axisLine: string;
  /** 坐标轴刻度文字 */
  axisTick: string;
  /** hover 竖线 / 光标 */
  cursor: string;
  /** tooltip 容器样式（recharts contentStyle） */
  tooltip: CSSProperties;
  /** 单强调色：主系列（消耗 / 请求量） */
  accent: string;
  /** 强调色淡档：收入类次系列（获得积分） */
  accentSoft: string;
  /** 深墨（中性主数据，如输入 Token） */
  ink: string;
  /** 浅墨（中性次数据，如缓存读） */
  inkSoft: string;
  /** 有序系列色阶（排行第 1 项起；用尽后循环，尾部为低权重项） */
  ramp: string[];
  /** 聚合尾项（如「其他」） */
  rest: string;
  /** Token 分项堆叠色（缓存写 / 缓存读 / 新输入 / 输出） */
  stack: { cache_write: string; cache_read: string; new_input: string; output: string };
  /** 热力图梯度（空值 + 四档） */
  heat: { empty: string; levels: string[] };
}

export function chartTheme(isDark: boolean): ChartTheme {
  return isDark
    ? {
        isDark,
        grid: '#3f3f46',
        axisLine: '#3f3f46',
        axisTick: '#a1a1aa',
        cursor: '#52525b',
        tooltip: {
          fontSize: 12,
          borderRadius: 10,
          border: '1px solid #3f3f46',
          background: '#18181b',
          color: '#e4e4e7',
          boxShadow: '0 8px 20px rgba(0,0,0,0.45)',
          padding: '8px 12px',
        },
        accent: '#fbbf24',
        accentSoft: '#34d399',
        ink: '#e4e4e7',
        inkSoft: '#a1a1aa',
        // 深色下首项强调、其余墨阶由亮到暗（数值越大越亮 → 与深色底对比更清晰）
        ramp: ['#fbbf24', '#e4e4e7', '#c8c8ce', '#a1a1aa', '#8a8a94', '#71717a'],
        rest: '#52525b',
        stack: {
          cache_write: '#52525b',
          cache_read: '#71717a',
          new_input: '#a1a1aa',
          output: '#e4e4e7',
        },
        heat: {
          empty: '#1c1c20',
          levels: ['#3a4a5c', '#556b80', '#7d97ad', '#b6c9d9'],
        },
      }
    : {
        isDark,
        grid: '#e2e8f0',
        axisLine: '#e2e8f0',
        axisTick: '#94a3b8',
        cursor: '#cbd5e1',
        tooltip: {
          fontSize: 12,
          borderRadius: 10,
          border: '1px solid #e2e8f0',
          background: '#fff',
          color: '#1e293b',
          boxShadow: '0 8px 20px rgba(15,23,42,0.10)',
          padding: '8px 12px',
        },
        accent: '#b45309',
        accentSoft: '#047857',
        ink: '#334155',
        inkSoft: '#94a3b8',
        ramp: ['#b45309', '#334155', '#475569', '#64748b', '#7c8ba0', '#94a3b8'],
        rest: '#cbd5e1',
        stack: {
          cache_write: '#94a3b8',
          cache_read: '#cbd5e1',
          new_input: '#475569',
          output: '#1e293b',
        },
        heat: {
          empty: '#eef2f6',
          levels: ['#dbe3ec', '#bcc9d8', '#8fa3b8', '#4c617a'],
        },
      };
}

/** 组件内取样式（浅深色自动跟随） */
export function useChartTheme(): ChartTheme {
  return chartTheme(useIsDark());
}

/** 公共坐标轴属性（recharts XAxis / YAxis 展开用） */
export function axisPropsOf(t: ChartTheme, width?: number) {
  return {
    tick: { fontSize: 11, fill: t.axisTick },
    axisLine: { stroke: t.axisLine },
    tickLine: false,
    ...(width != null ? { width } : {}),
  } as const;
}
