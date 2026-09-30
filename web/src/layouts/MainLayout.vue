<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NMenu, NButton, NSpace, NTag, NDrawer, NDrawerContent, NIcon } from 'naive-ui';
import { RouterView } from 'vue-router';
import { auth } from '../store';
import { logout } from '../api';
import { useIsMobile } from '../useMediaQuery';
import { IconDashboard, IconSensors, IconPower, IconFans, IconLogs, IconHistory, IconKvm, IconSettings, IconInventory } from '../icons';

const router = useRouter();
const route = useRoute();
const isMobile = useIsMobile();
const hostOn = ref<boolean | null>(null);
const showMenu = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const menuOptions = [
  { label: '仪表板', key: 'dashboard', icon: IconDashboard },
  { label: '传感器', key: 'sensors', icon: IconSensors },
  { label: '电源控制', key: 'power', icon: IconPower },
  { label: '风扇控制', key: 'fans', icon: IconFans },
  { label: '事件日志', key: 'logs', icon: IconLogs },
  { label: '历史趋势', key: 'history', icon: IconHistory },
  { label: '系统清单', key: 'inventory', icon: IconInventory },
  { label: 'KVM', key: 'kvm', icon: IconKvm },
  { label: '设置', key: 'settings', icon: IconSettings },
];

function onMenuUpdate(key: string) {
  showMenu.value = false;
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
  // 头部主机状态徽标：5s 轮询 chassis-status
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
  timer = setInterval(poll, 10000);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <n-layout style="height: 100vh" has-sider>
    <!-- 桌面：固定侧栏 -->
    <n-layout-sider v-if="!isMobile" bordered content-style="padding: 16px;" :width="220">
      <div style="font-weight: 700; font-size: 18px; margin-bottom: 20px">MegaRAC Next</div>
      <n-menu :options="menuOptions" :value="route.name as string" @update:value="onMenuUpdate" />
    </n-layout-sider>

    <!-- 移动：抽屉菜单 -->
    <n-drawer v-model:show="showMenu" :width="240" placement="left">
      <n-drawer-content body-content-style="padding: 12px" :native-scrollbar="false">
        <div style="font-weight: 700; font-size: 18px; margin-bottom: 16px">MegaRAC Next</div>
        <n-menu :options="menuOptions" :value="route.name as string" @update:value="onMenuUpdate" />
      </n-drawer-content>
    </n-drawer>

    <n-layout>
      <n-layout-header
        bordered
        style="height: 56px; display: flex; align-items: center; justify-content: space-between; gap: 8px"
        :style="{ padding: isMobile ? '0 12px' : '0 20px' }"
      >
        <n-space align="center" :size="8" :wrap="false" style="min-width: 0">
          <n-button v-if="isMobile" quaternary size="small" @click="showMenu = true" aria-label="菜单">
            <n-icon size="20">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </n-icon>
          </n-button>
          <n-tag :type="hostOn === null ? 'warning' : hostOn ? 'success' : 'error'" size="small" round>
            {{ hostOn === null ? '状态未知' : hostOn ? '主机在线' : '主机关机' }}
          </n-tag>
          <span v-if="!isMobile" style="color: #888; font-size: 13px">192.168.0.200 · MZ32-AR0</span>
          <span v-else style="color: #888; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">MegaRAC Next</span>
        </n-space>
        <n-space align="center" :size="4" :wrap="false">
          <span v-if="auth.loggedIn && !isMobile" style="color: #aaa; font-size: 13px">{{ auth.username }}</span>
          <n-button quaternary size="small" @click="onLogout">注销</n-button>
        </n-space>
      </n-layout-header>
      <n-layout-content
        :content-style="`padding: ${isMobile ? '12px' : '20px'}; min-height: calc(100vh - 56px)`"
      >
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>
