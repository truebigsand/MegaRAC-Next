import { onBeforeUnmount, onMounted, type Ref } from 'vue';
import type * as echarts from 'echarts';

/**
 * 让 ECharts 实例跟随容器尺寸变化自动 resize。
 * 相比只监听 window.resize，ResizeObserver 能捕捉容器自身的真实尺寸变化
 * （断点切换、侧栏开合、字体加载后重排等），避免画布与容器尺寸不一致被压扁。
 */
export function useChartAutoResize(container: Ref<HTMLElement | undefined>, getChart: () => echarts.ECharts | null): void {
  let observer: ResizeObserver | null = null;
  let raf = 0;

  onMounted(() => {
    const el = container.value;
    if (!el || typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => getChart()?.resize());
    });
    observer.observe(el);
  });

  onBeforeUnmount(() => {
    cancelAnimationFrame(raf);
    observer?.disconnect();
    observer = null;
  });
}
