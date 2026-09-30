<script setup lang="ts">
// 数据来源与新鲜度徽标。
//
// 为什么需要它：这个重制版的取数是"两条腿"——经典 web API（骨干，可靠）+ Redfish（增补，
// 慢且可能不可用，由代理后台预热）。用户有权知道"我现在看到的数字是哪来的、有多新"，
// 而不是在 BMC 慢的时候对着空白页面猜。
//
// ⚠️ 文案按**三部分各自的就绪状态**来说，不要用"完成过几轮"——
// 实测 Thermal 那条偶尔会挂（要聚合 18 个板载传感器），三部分全成功才算一轮，
// 用轮次判断会让"系统信息明明已经有了"的界面还在说"尚未完成首轮"。
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

const PART_LABEL = { system: '系统信息', thermal: 'Thermal 阈值', firmware: '固件清单' } as const;

const partList = computed(() => {
  const p = props.augment?.parts;
  if (!p) return [];
  return (Object.keys(PART_LABEL) as (keyof typeof PART_LABEL)[]).map((k) => ({ key: k, label: PART_LABEL[k], ok: p[k] }));
});

const augmentHint = computed(() => {
  const a = props.augment;
  if (!a) return 'Redfish 增补：未知';
  if (partList.value.length === 0) return 'Redfish 增补：尚未开始';
  const ok = partList.value.filter((x) => x.ok).map((x) => x.label);
  const bad = partList.value.filter((x) => !x.ok).map((x) => x.label);
  if (bad.length === 0) return `Redfish 增补：全部就绪（${ok.join('、')}）`;
  if (ok.length === 0) return `Redfish 增补：尚未取到（${bad.join('、')}${a.lastError ? '；' + a.lastError : ''}）`;
  return `Redfish 增补：已就绪 ${ok.join('、')}；${bad.join('、')} 暂不可用，后台重试中`;
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
      <div style="max-width: 340px; line-height: 1.6">
        <div>主干：经典 web API（可靠、快）</div>
        <div>{{ augmentHint }}</div>
        <div v-if="degradedText">降级字段：{{ degradedText }}</div>
      </div>
    </n-tooltip>
    <n-tag v-if="error" key="err" size="small" type="error" :bordered="false">{{ error }}</n-tag>
  </n-space>
</template>
