<script setup lang="ts">
// 电源控制页（重写版）。
// 状态来自归一化接口 /api/overview；写操作仍走 BMC 原始通道（POST actions/power）。
// 与旧版的区别：主机状态与"是否有其他人在操作"的上下文更清楚，且写操作失败会区分
// "BMC 忙"与"被 BMC 拒绝"，不再一律提示会话过期。
import { computed } from 'vue';
import { NAlert, NButton, NCard, NGi, NGrid, NSpace, NStatistic, NTag, useDialog, useMessage } from 'naive-ui';
import { apiGet, bmcSend } from '../api/client';
import { useResource } from '../api/useResource';
import type { Overview } from '../api/models';
import SourceBadge from '../components/SourceBadge.vue';

const dialog = useDialog();
const message = useMessage();
const overview = useResource<Overview>('/api/overview', apiGet, { intervalMs: 6000 });

const ACTIONS: { cmd: number; label: string; danger?: boolean; tip: string }[] = [
  { cmd: 1, label: '开启电源', tip: '主机已上电时 BMC 会拒绝此项' },
  { cmd: 0, label: '关闭电源', danger: true, tip: '立即切断主机电源' },
  { cmd: 2, label: '电源循环', danger: true, tip: '断电再上电。「已上电但没起来」时用这个' },
  { cmd: 3, label: '硬重启', danger: true, tip: '等效按 reset 键' },
  { cmd: 5, label: 'ACPI 关闭', tip: '向操作系统发送软关机' },
];

const powerOn = computed(() => overview.data.value?.system.powerState === 'on');

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
        // 电源动作生效有延迟，等一拍再刷新
        setTimeout(() => void overview.refresh(), 1500);
      } catch (e) {
        const err = e as Error & { isBusy?: boolean };
        message.error(err.isBusy ? `BMC 忙，稍后重试：${err.message}` : err.message);
      } finally {
        d.loading = false;
      }
    },
  });
}
</script>

<template>
  <n-space vertical size="medium">
    <n-space justify="space-between" align="center">
      <n-space align="center" size="small">
        <n-tag :type="powerOn ? 'success' : 'default'" :bordered="false" size="small">
          主机{{ powerOn ? '在线' : '离线' }}
        </n-tag>
        <n-tag v-if="overview.data.value?.system.model" key="model" size="small" :bordered="false">
          {{ overview.data.value.system.model }}
        </n-tag>
      </n-space>
      <source-badge
        :augment="overview.data.value?.sources.augment"
        :stale="overview.stale.value"
        :age-sec="overview.ageSec.value"
        :error="overview.error.value"
      />
    </n-space>

    <n-alert type="warning" size="small">
      电源操作会影响主机与其上所有虚拟机。带红色标注的动作会立即断电或强制重启。
    </n-alert>

    <n-card size="small" title="当前状态">
      <n-grid :x-gap="12" cols="1 s:2" responsive="screen">
        <n-gi>
          <n-statistic :value="powerOn ? '已上电' : '已断电'" label="主机电源（来自 BMC）" />
        </n-gi>
        <n-gi>
          <n-statistic :value="String(overview.data.value?.sessions ?? '—')" label="BMC 会话数" />
        </n-gi>
      </n-grid>
      <n-alert v-if="!powerOn" type="info" size="small" style="margin-top: 10px">
        主机已断电时「开启电源」可用；若显示已上电但系统没起来，请用「电源循环」。
      </n-alert>
    </n-card>

    <n-card size="small" title="操作">
      <n-space vertical size="small">
        <n-space v-for="a in ACTIONS" :key="a.cmd" align="center" size="small">
          <n-button :type="a.danger ? 'error' : 'primary'" :secondary="!a.danger" size="small" style="width: 108px" @click="confirmAndSend(a)">
            {{ a.label }}
          </n-button>
          <span style="font-size: 13px; opacity: 0.75">{{ a.tip }}</span>
        </n-space>
      </n-space>
    </n-card>
  </n-space>
</template>
