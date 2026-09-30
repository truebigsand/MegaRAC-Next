<script setup lang="ts">
// 仪表盘（重写版）。
//
// 与旧版的区别：
//   · 只依赖两个**归一化接口**（/api/overview + /api/sensors），不再自己拼 4 个裸接口；
//   · 顶部有数据来源/新鲜度徽标——BMC 慢的时候用户能看出"这是 30 秒前的数据"而不是以为页面坏了；
//   · 传感器健康统计、最热几处、各风扇转速都直接来自归一化模型
//     （含"未安装的传感器读数为 0"这类情况的正确处理，不会误报严重告警）。
import { computed, reactive, watch } from 'vue';
import { NAlert, NCard, NGi, NGrid, NList, NListItem, NSpace, NSpin, NStatistic, NTag, NThing } from 'naive-ui';
import { apiGet } from '../api/client';
import { useResource } from '../api/useResource';
import type { Overview, SensorSnapshot } from '../api/models';
import SourceBadge from '../components/SourceBadge.vue';
import LiveTrend from '../components/LiveTrend.vue';

const overview = useResource<Overview>('/api/overview', apiGet, { intervalMs: 10_000 });
const sensors = useResource<SensorSnapshot>('/api/sensors', apiGet, { intervalMs: 10_000 });

// 实时曲线的客户端缓冲（最近 120 点）。
// ⚠️ 不含 CPU0_DTS：它是 AMD 的"距临界温度余量"（越小越热），不是温度本身，
// 混在温度图/最热榜里会让人把 69 当成 CPU 的真实温度。要看余量请去「历史趋势」页选它。
const TEMP_KEYS = ['CPU0_TEMP', 'MB_TEMP1', 'MB_TEMP2'];
const FAN_KEYS = ['CPU0_FAN', 'SYS_FAN1', 'SYS_FAN2', 'SYS_FAN3', 'SYS_FAN4'];
const buf = reactive<{ temps: Map<string, { t: number; v: number }[]>; fans: Map<string, { t: number; v: number }[]> }>({
  temps: new Map(),
  fans: new Map(),
});
const MAX_POINTS = 120;

function push(map: Map<string, { t: number; v: number }[]>, key: string, v: number) {
  if (!map.has(key)) map.set(key, []);
  const arr = map.get(key)!;
  arr.push({ t: Date.now(), v });
  if (arr.length > MAX_POINTS) arr.shift();
}

watch(
  () => sensors.data.value?.at,
  () => {
    const snap = sensors.data.value;
    if (!snap) return;
    for (const s of snap.sensors) {
      if (s.value === null || s.value === 0) continue; // 0 = 未安装/无读数
      if (TEMP_KEYS.includes(s.name)) push(buf.temps, s.name, s.value);
      else if (FAN_KEYS.includes(s.name)) push(buf.fans, s.name, s.value);
    }
  },
);

const tempSeries = computed(() => [...buf.temps.entries()].map(([name, points]) => ({ name, points })));
const fanSeries = computed(() => [...buf.fans.entries()].map(([name, points]) => ({ name, points })));

const ov = computed(() => overview.data.value);
const healthType = (h: string) => (h.toLowerCase() === 'ok' ? 'success' : h ? 'warning' : 'default');
const sensorTagType = (k: 'ok' | 'warn' | 'crit' | 'na') =>
  k === 'ok' ? 'success' : k === 'warn' ? 'warning' : k === 'crit' ? 'error' : 'default';
</script>

<style scoped>
/* 顶层用普通 flex 容器，避免 Naive Space 对条件子节点自动编号 key 时的重复 key 警告；
   同时把内容收在中线——超宽屏下统计卡与图表拉满 2560px 会很难读 */
.page-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1720px;
  margin: 0 auto;
}
</style>

<template>
  <div class="page-stack">
    <n-space justify="space-between" align="center">
      <n-space align="center" size="small">
        <n-tag key="power" :type="ov?.system.powerState === 'on' ? 'success' : 'default'" :bordered="false" size="small">
          主机{{ ov?.system.powerState === 'on' ? '在线' : '离线' }}
        </n-tag>
        <n-tag v-if="ov?.system.health" key="health" :type="healthType(ov.system.health)" :bordered="false" size="small">
          健康：{{ ov.system.health }}
        </n-tag>
        <n-tag v-if="ov?.fanMode" key="fanmode" size="small" :bordered="false">风扇策略：{{ ov.fanMode }}</n-tag>
      </n-space>
      <source-badge
        :augment="ov?.sources.augment"
        :stale="overview.stale.value"
        :age-sec="overview.ageSec.value"
        :error="overview.error.value"
        :degraded="ov?.sources.degraded"
      />
    </n-space>

    <n-alert v-if="!ov && overview.loading.value" type="info" size="small">
      <n-spin size="small" /> 正在从 BMC 读取…
    </n-alert>
    <n-alert v-else-if="!ov && overview.error.value" type="error" size="small">
      读取失败：{{ overview.error.value }}
    </n-alert>

    <n-grid v-if="ov" :x-gap="12" :y-gap="12" cols="1 s:2 m:4" responsive="screen">
      <n-gi>
        <n-card size="small" title="BMC 固件">
          <n-statistic :value="ov.firmware.version || '—'" :label="`构建 ${ov.firmware.buildDate || '—'}`" />
          <n-space size="small" style="margin-top: 6px">
            <n-tag key="image" size="tiny" :bordered="false">镜像 {{ ov.firmware.activeImage ?? '—' }}</n-tag>
            <n-tag v-if="ov.firmware.skuVer" key="sku" size="tiny" :bordered="false">SKU {{ ov.firmware.skuVer }}</n-tag>
          </n-space>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card size="small" title="主板 / BIOS">
          <n-statistic :value="ov.system.model || '—'" :label="ov.system.biosVersion ? `BIOS ${ov.system.biosVersion}` : 'BIOS 待补充'" />
          <n-space size="small" style="margin-top: 6px">
            <n-tag v-if="ov.system.cpuSummary" size="tiny" :bordered="false">{{ ov.system.cpuSummary }}</n-tag>
          </n-space>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card size="small" title="传感器">
          <n-statistic :value="`${ov.sensors.ok} / ${ov.sensors.total}`" label="正常 / 总计" />
          <n-space size="small" style="margin-top: 6px">
            <n-tag key="warn" size="tiny" :type="sensorTagType('warn')" :bordered="false">告警 {{ ov.sensors.warn }}</n-tag>
            <n-tag key="crit" size="tiny" :type="sensorTagType('crit')" :bordered="false">严重 {{ ov.sensors.crit }}</n-tag>
            <n-tag key="na" size="tiny" :bordered="false">不适用 {{ ov.sensors.na }}</n-tag>
          </n-space>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card size="small" title="会话 / 运行时长">
          <n-statistic
            :value="ov.uptimeHours === null ? '—' : `${Math.floor(ov.uptimeHours / 24)} 天 ${Math.round(ov.uptimeHours % 24)} 小时`"
            :label="`BMC 会话 ${ov.sessions} 条`"
          />
          <n-space v-if="ov.system.serial" size="small" style="margin-top: 6px">
            <n-tag size="tiny" :bordered="false">SN {{ ov.system.serial }}</n-tag>
          </n-space>
        </n-card>
      </n-gi>
    </n-grid>

    <n-grid v-if="ov" :x-gap="12" :y-gap="12" cols="1 m:2" responsive="screen">
      <n-gi>
        <n-card size="small" title="最热几处">
          <n-list v-if="ov.hottest.length" hoverable>
            <n-list-item v-for="h in ov.hottest" :key="h.name">
              <n-thing :title="h.name">
                <template #description>
                  <n-tag size="small" :type="h.value >= 80 ? 'error' : h.value >= 60 ? 'warning' : 'success'" :bordered="false">
                    {{ h.value }} °C
                  </n-tag>
                </template>
              </n-thing>
            </n-list-item>
          </n-list>
          <n-alert v-else type="default" size="small">暂无温度读数</n-alert>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card size="small" title="风扇转速">
          <n-list v-if="ov.fans.length" hoverable>
            <n-list-item v-for="f in ov.fans" :key="f.name">
              <n-thing :title="f.name">
                <template #description>
                  <n-tag size="small" :bordered="false">{{ f.rpm }} RPM</n-tag>
                </template>
              </n-thing>
            </n-list-item>
          </n-list>
          <n-alert v-else type="default" size="small">暂无风扇读数</n-alert>
        </n-card>
      </n-gi>
    </n-grid>

    <!-- 宽屏（≥1280px）两张趋势图并排：单张拉满整行时又扁又长，读起来很差 -->
    <n-grid :x-gap="12" :y-gap="12" cols="1 l:2" responsive="screen">
      <n-gi>
        <n-card size="small" title="温度趋势（最近采样）">
          <template #header-extra>
            <n-tag size="tiny" :bordered="false">{{ sensors.data.value?.counts.total ?? 0 }} 个传感器</n-tag>
          </template>
          <live-trend :series="tempSeries" y-name="°C" :height="260" />
        </n-card>
      </n-gi>
      <n-gi>
        <n-card size="small" title="风扇趋势（最近采样）">
          <template #header-extra>
            <n-tag size="tiny" :bordered="false">DTS（温度余量）见「历史趋势」</n-tag>
          </template>
          <live-trend :series="fanSeries" y-name="RPM" :height="260" :min="0" />
        </n-card>
      </n-gi>
    </n-grid>
  </div>
</template>
