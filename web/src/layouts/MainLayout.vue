<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NMenu, NButton, NSpace, NTag } from 'naive-ui';
import { RouterView, useRoute } from 'vue-router';
import { auth } from '../store';
import { logout } from '../api';

const router = useRouter();
const route = useRoute();
const hostOn = ref<boolean | null>(null);

const menuOptions = [
  { label: '仪表板', key: 'dashboard' },
  { label: '传感器', key: 'sensors' },
  { label: '电源控制', key: 'power' },
  { label: '风扇控制', key: 'fans' },
  { label: '事件日志', key: 'logs' },
  { label: '历史趋势', key: 'history' },
  { label: 'KVM', key: 'kvm' },
  { label: '设置', key: 'settings' },
];

function onMenuUpdate(key: string) {
  router.push('/' + key);
}

async function onLogout() {
  await logout();
  router.push('/login');
}

onMounted(async () => {
  // 刷新后恢复登录态显示
  try {
    const res = await fetch('/api/auth/me');
    const data = (await res.json()) as { loggedIn: boolean; username?: string };
    auth.loggedIn = data.loggedIn;
    auth.username = data.username ?? '';
    if (!data.loggedIn) router.push('/login');
  } catch {
    /* 代理未启动 */
  }
  // 头部主机状态徽标：3s 轮询 chassis-status
  const poll = async () => {
    try {
      const res = await fetch('/bmc/chassis-status');
      if (res.ok) {
        const data = (await res.json()) as { power_status: number };
        hostOn.value = data.power_status === 1;
      } else {
        hostOn.value = null;
      }
    } catch {
      hostOn.value = null;
    }
  };
  poll();
  setInterval(poll, 5000);
});
</script>

<template>
  <n-layout style="height: 100vh" has-sider>
    <n-layout-sider bordered content-style="padding: 16px;" :width="220" collapse-mode="width">
      <div style="font-weight: 700; font-size: 18px; margin-bottom: 20px">MegaRAC Next</div>
      <n-menu :options="menuOptions" :value="route.name as string" @update:value="onMenuUpdate" />
    </n-layout-sider>
    <n-layout>
      <n-layout-header bordered style="height: 56px; display: flex; align-items: center; padding: 0 20px; justify-content: space-between">
        <n-space align="center">
          <n-tag :type="hostOn === null ? 'warning' : hostOn ? 'success' : 'error'" size="small" round>
            {{ hostOn === null ? '状态未知' : hostOn ? '主机在线' : '主机关机' }}
          </n-tag>
          <span style="color: #888; font-size: 13px">192.168.0.200 · MZ32-AR0</span>
        </n-space>
        <n-space align="center">
          <span v-if="auth.loggedIn" style="color: #aaa; font-size: 13px">{{ auth.username }}</span>
          <n-button quaternary size="small" @click="onLogout">注销</n-button>
        </n-space>
      </n-layout-header>
      <n-layout-content content-style="padding: 20px; min-height: calc(100vh - 56px)">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>
