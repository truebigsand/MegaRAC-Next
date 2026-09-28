/**
 * 图表配色的唯一来源（深色主题）。
 * 图表系列、坐标轴、图例、tooltip 标记都从这里取色，避免同一颜色在多处重复定义。
 */
export const CHART_COLORS = {
  /** 主曲线：编辑中的档案 / 曲线编辑器的目标曲线 */
  primary: '#63e2b7',
  /** 对照曲线：当前运行的档案 */
  reference: '#888',
  /** 取样阶梯 / 取样点 */
  sampled: '#f0a020',
  /** 坐标轴刻度与单位名 */
  axisText: '#888',
  /** 宽屏图例文字 */
  legendText: '#aaa',
  /** 窄屏图例文字（字号更小，用更亮的灰度保证对比度） */
  legendTextCompact: '#bbb',
  /** 可翻页图例的翻页图标（禁用态） */
  pageIconInactive: '#555',
} as const;

/** 曲线编辑器预览图的系列顺序：[目标曲线, 取样点] */
export const PREVIEW_PALETTE: string[] = [CHART_COLORS.primary, CHART_COLORS.sampled];
