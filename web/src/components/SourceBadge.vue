<script setup lang="ts">
// 数据来源与新鲜度徽标。
//
// 为什么需要它：这个重制版的取数是"两条腿"——经典 web API（骨干，可靠）+ Redfish（增补，
// 慢且可能不可用，由代理后台预热）。用户有权知道"我现在看到的数字是哪来的、有多新"，
// 而不是在 BMC 慢的时候对着空白页面猜。
import { computed } from 'vue';
import { NTag, NTooltip, NSpace } from 'naive-ui';
import type { AugmentInfo } from '../api/models';

const props = defineProps<{
  augment?: AugmentInfo;
  stale?: boolean;
  ageSec?: number | null;
  error?: string;
  /** 明确降级掉的字段（来自 overview.sources.degraded） */
  degraded?: string[];
}>();

const freshness = computed(() => {
  if (props.ageSec === null || props.ageSec === undefined) return '刚更新';
  if (props.ageSec < 5) return '刚刚更新';
  if (props.ageSec < 60) return `${props.ageSec} 秒前更新`;
  return `${Math.round(props.ageSec / 60)} 分钟前更新`;
});

const augmentHint = computed(() => {
  const a = props.augment;
  if (!a) return 'Redfish 增补：未知';
  if (!a.rounds) return 'Redfish 增补：尚未完成首轮（后台进行中）';
  if (a.lastError) return `Redfish 增补：部分不可用（${a.lastError}）`;
  return `Redfish 增补：正常（第 ${a.rounds} 轮，${a.ageSec === null ? '' : a.ageSec + ' 秒前'}）`;
});

const degradedText = computed(() => (props.degraded ?? []).join('；'));
</script>

<template>
  <n-space align="center" :size="6" style="flex-wrap: wrap">
    <n-tooltip>
      <template #trigger>
        <n-tag key="fresh" size="small" :type="stale ? 'warning' : 'success'" :bordered="false">
          {{ stale ? '数据可能过时' : '实时' }} · {{ freshness }}
        </n-tag>
      </template>
      <div style="max-width: 320px; line-height: 1.6">
        <div>主干：经典 web API（可靠、快）</div>
        <div>{{ augmentHint }}</div>
        <div v-if="degradedText">降级字段：{{ degradedText }}</div>
      </div>
    </n-tooltip>
    <n-tag v-if="error" key="err" size="small" type="error" :bordered="false">{{ error }}</n-tag>
  </n-space>
</template>
