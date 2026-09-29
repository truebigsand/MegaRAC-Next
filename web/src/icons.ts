import { h, type VNode } from 'vue';

/**
 * 导航图标：统一的描边风格（24 网格、1.8 线宽、currentColor），
 * 不引入图标库依赖；颜色随文字，尺寸由菜单渲染控制。
 */
function svg(children: VNode[]): VNode {
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 18,
      height: 18,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    children,
  );
}

const rect = (x: number, y: number, w: number, hh: number, rx = 1.5) => h('rect', { x, y, width: w, height: hh, rx });
const circle = (cx: number, cy: number, r: number) => h('circle', { cx, cy, r });
const path = (d: string) => h('path', { d });

/** 仪表板：四宫格 */
export const IconDashboard = () => svg([rect(3, 3, 7, 7), rect(14, 3, 7, 7), rect(3, 14, 7, 7), rect(14, 14, 7, 7)]);

/** 传感器：读数波形 */
export const IconSensors = () => svg([path('M3 12h3.5l2.2-6 3.1 12 2.3-6H21')]);

/** 电源控制：电源符号 */
export const IconPower = () => svg([path('M12 3.5v8.5'), path('M7.6 7.4a7 7 0 1 0 8.8 0')]);

/** 风扇控制：气流 */
export const IconFans = () =>
  svg([path('M3 8h11a2.6 2.6 0 1 0-2.6-2.6'), path('M3 12h15a2.6 2.6 0 1 1-2.6 2.6'), path('M3 16h8.5a2.4 2.4 0 1 1-2.4 2.4')]);

/** 事件日志：文档 + 文本行 */
export const IconLogs = () => svg([rect(5, 3, 14, 18, 2), path('M9 8h6'), path('M9 12h6'), path('M9 16h4')]);

/** 历史趋势：折线图 */
export const IconHistory = () => svg([path('M4 4v15a1 1 0 0 0 1 1h15'), path('M7 15l4-5 3 3 5-7')]);

/** KVM：显示器 */
export const IconKvm = () => svg([rect(3, 4, 18, 12, 2), path('M9 20h6'), path('M12 16v4')]);

/** 设置：滑杆 */
export const IconSettings = () =>
  svg([
    path('M4 7h9'),
    circle(16.5, 7, 2.2),
    path('M20 7h0'),
    path('M4 12h3.5'),
    circle(10.2, 12, 2.2),
    path('M14 12h6'),
    path('M4 17h11'),
    circle(18, 17, 2.2),
  ]);
