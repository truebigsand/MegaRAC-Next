// 轮询型资源的组合式函数：所有页面统一用它取数，把「BMC 会慢会挂」这件事收敛到一处。
//
// 解决的三个真实问题（都是这台 BMC 上实测出来的）：
//   1. **慢**：单个请求可能十几秒。所以默认间隔给得保守，且失败后指数退避，
//      不然后台轮询会自己把 BMC 压垮（也避免触发新固件的防滥用封禁）。
//   2. **会挂**：偶发超时。出错时**保留上一份好数据**（stale-while-error），
//      页面上继续显示旧值 + 一个"数据可能过时"的提示，而不是整页空白。
//   3. **切后台**：标签页隐藏时暂停轮询（省得在用户不看的时候还占着 BMC）。
import { ref, onMounted, onBeforeUnmount, watch, type Ref } from 'vue';
import { ApiError } from './client';

export interface ResourceState<T> {
  data: Ref<T | null>;
  error: Ref<string>;
  /** 数据的最后成功更新时间（毫秒） */
  updatedAt: Ref<number>;
  /** 连续失败次数 */
  failures: Ref<number>;
  loading: Ref<boolean>;
  /** 拿了多久的旧数据（秒）；null 表示没有旧数据 */
  ageSec: Ref<number | null>;
  /** 是否正处于"数据可能过时"状态 */
  stale: Ref<boolean>;
  refresh: () => Promise<void>;
}

const BASE_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
/** 超过这个时长没成功更新过，就认为数据"过时"（前端会提示） */
export const STALE_AFTER_MS = 30_000;

export function useResource<T>(
  path: string | null,
  fetcher: (path: string) => Promise<T>,
  opts: { intervalMs?: number } = {},
): ResourceState<T> {
  const interval = opts.intervalMs ?? BASE_INTERVAL_MS;
  const data = ref<T | null>(null) as Ref<T | null>;
  const error = ref('');
  const updatedAt = ref(0);
  const failures = ref(0);
  const loading = ref(false);
  const ageSec = ref<number | null>(null);
  const stale = ref(false);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let tickAge: ReturnType<typeof setInterval> | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  async function load(): Promise<void> {
    if (!path || stopped) return;
    loading.value = true;
    try {
      const d = await fetcher(path);
      data.value = d;
      updatedAt.value = Date.now();
      failures.value = 0;
      error.value = '';
    } catch (e) {
      failures.value++;
      error.value = e instanceof ApiError ? e.message : (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  function schedule(): void {
    if (stopped || !path) return;
    clear();
    // 指数退避：基础间隔 × 2^失败次数，上限 60 秒
    const backoff = Math.min(interval * Math.pow(2, Math.min(failures.value, 4)), MAX_BACKOFF_MS);
    timer = setTimeout(async () => {
      if (document.hidden) {
        schedule();
        return;
      }
      await load();
      schedule();
    }, failures.value > 0 ? backoff : interval);
  }

  async function refresh(): Promise<void> {
    await load();
    schedule();
  }

  const onVisible = () => {
    if (!document.hidden) void refresh();
  };

  onMounted(() => {
    void refresh();
    document.addEventListener('visibilitychange', onVisible);
    // 每秒刷新"数据年龄"，让过时提示能自己浮现
    tickAge = setInterval(() => {
      if (!updatedAt.value) {
        ageSec.value = null;
        stale.value = false;
        return;
      }
      ageSec.value = Math.round((Date.now() - updatedAt.value) / 1000);
      stale.value = Date.now() - updatedAt.value > STALE_AFTER_MS;
    }, 1000);
  });

  onBeforeUnmount(() => {
    stopped = true;
    clear();
    if (tickAge) clearInterval(tickAge);
    document.removeEventListener('visibilitychange', onVisible);
  });

  // path 变化（例如登录后才拿到）时立刻重来一轮
  watch(
    () => path,
    (p) => {
      if (p) void refresh();
    },
  );

  return { data, error, updatedAt, failures, loading, ageSec, stale, refresh };
}
