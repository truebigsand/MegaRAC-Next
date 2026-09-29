import { h, type Component } from 'vue';
import { NIcon } from 'naive-ui';
import {
  DesktopOutline,
  DocumentTextOutline,
  GridOutline,
  PowerOutline,
  PulseOutline,
  SnowOutline,
  StatsChartOutline,
  SettingsOutline,
} from '@vicons/ionicons5';

/**
 * 导航图标：@vicons/ionicons5 的图标用 NIcon 包裹，尺寸/颜色交给 Naive 主题。
 * 按需具名引入，只有用到的图标会进产物（tree-shaking）。
 */
function menuIcon(comp: Component) {
  return () => h(NIcon, { size: 18 }, { default: () => h(comp) });
}

/** 仪表板 */
export const IconDashboard = menuIcon(GridOutline);
/** 传感器：读数脉冲 */
export const IconSensors = menuIcon(PulseOutline);
/** 电源控制 */
export const IconPower = menuIcon(PowerOutline);
/** 风扇控制：冷却（ionicons 无风扇字形，用雪花表示散热） */
export const IconFans = menuIcon(SnowOutline);
/** 事件日志 */
export const IconLogs = menuIcon(DocumentTextOutline);
/** 历史趋势 */
export const IconHistory = menuIcon(StatsChartOutline);
/** KVM：显示器 */
export const IconKvm = menuIcon(DesktopOutline);
/** 设置 */
export const IconSettings = menuIcon(SettingsOutline);
