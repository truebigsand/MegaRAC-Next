<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { NCard, NButton, NSpace, NAlert, NTag, useDialog, useMessage } from 'naive-ui';
import { bmcGet, bmcSend } from '../api';
import type { ChassisStatus } from '../types';
import { useIsMobile } from '../useMediaQuery';

const isMobile = useIsMobile();

const dialog = useDialog();
const message = useMessage();
const powerStatus = ref<number | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

const ACTIONS: { cmd: number; label: string; danger?: boolean; tip: string }[] = [
  { cmd: 1, label: '开启电源', tip: '主机已上电时 BMC 会拒绝此项' },
  { cmd: 0, label: '关闭电源', danger: true, tip: '立即切断主机电源' },
  { cmd: 2, label: '电源循环', danger: true, tip: '断电再上电。「已上电但没起来」时用这个' },
  { cmd: 3, label: '硬重启', danger: true, tip: '等效按 reset 键' },
  { cmd: 5, label: 'ACPI 关闭', tip: '向操作系统发送软关机' },
];

async function refresh() {
  try {
    const data = await bmcGet<ChassisStatus>('chassis-status');
    powerStatus.value = data.power_status;
  } catch {
    /* 401 已由 api 层处理 */
  }
}

function confirmAndSend(action: (typeof ACTIONS)[number]) {
  const d = dialog.warning({
    title: `确认执行「${action.label}」？`,
    content: action.tip,
    positiveText: '执行',
    negativeText: '取消',
    onPositiveClick: async () => {
      d.loading = true;
      try {
        await bmcSend('POST', 'actions/power', { power_command: action.cmd });
        message.success(`已发送：${action.label}`);
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setTimeout(refresh, 1500);
      }
    },
  });
}

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 10000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <n-space vertical size="large">
    <n-card title="电源控制">
      <template #header-extra>
        <n-tag :type="powerStatus === 1 ? 'success' : 'error'" size="small">
          {{ powerStatus === 1 ? '主机已上电' : '主机关机' }}
        </n-tag>
      </template>
      <n-space>
        <n-button
          v-for="a in ACTIONS"
          :key="a.cmd"
          :type="a.danger ? 'error' : 'primary'"
          :secondary="!a.danger"
          :disabled="a.cmd === 1 && powerStatus === 1"
          :style="isMobile ? 'flex: 1 1 40%' : undefined"
          @click="confirmAndSend(a)"
        >
          {{ a.label }}
        </n-button>
      </n-space>
      <p class="tip">电源循环：断电后重新上电，适用于「BMC 显示在线但系统无响应」；硬重启不等同于电源循环。</p>
    </n-card>
  </n-space>
</template>

<style scoped>
.tip {
  color: #777;
  font-size: 12px;
  margin-top: 12px;
}
</style>
