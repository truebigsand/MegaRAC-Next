import { onBeforeUnmount, ref, type Ref } from 'vue';

/** 响应式媒体查询（组件内使用；卸载时自动清理监听） */
export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(false);
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia(query);
    matches.value = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      matches.value = e.matches;
    };
    mq.addEventListener('change', onChange);
    onBeforeUnmount(() => mq.removeEventListener('change', onChange));
  }
  return matches;
}

/** 手机等窄屏（<=768px） */
export function useIsMobile(): Ref<boolean> {
  return useMediaQuery('(max-width: 768px)');
}
