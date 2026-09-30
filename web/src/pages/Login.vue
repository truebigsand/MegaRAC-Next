<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NCard, NForm, NFormItem, NInput, NButton, NDivider, NText, useMessage, useDialog } from 'naive-ui';
import { login, resetBmc } from '../api';
import { auth } from '../store';

const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const username = ref('admin');
const password = ref('');
const loading = ref(false);
const resetting = ref(false);

async function onSubmit() {
  if (!username.value || !password.value) {
    message.warning('请输入用户名与密码');
    return;
  }
  loading.value = true;
  try {
    await login(username.value, password.value);
    auth.loggedIn = true;
    auth.username = username.value;
    router.push('/dashboard');
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}

/**
 * 重置 BMC（管理控制器冷复位）。
 *
 * 为什么放在登录页、且用这里填的账密：它要解决的是"**根本登不进来**"的情况——
 * BMC 的 web 会话表被占满时（错误码 15000）经典接口全线拒绝、连登录都被拒，
 * 而 Redfish 仍能建会话，所以这条路是自己救自己。凭据由 BMC 校验，代理不存。
 */
function onReset() {
  if (!username.value || !password.value) {
    message.warning('请先填写用户名与密码——重置会用这组凭据向 BMC 认证');
    return;
  }
  const d = dialog.warning({
    title: '确认重置 BMC？',
    content:
      '将重启 BMC 的管理控制器（约 2.5 分钟）：期间 Web 界面、KVM、Redfish 都会失联，' +
      '主机与其上的虚拟机不受影响。' +
      '常用于清空被占满的会话表（症状：登录报「BMC 的 web 会话表已满」）。',
    positiveText: '重置 BMC',
    negativeText: '取消',
    onPositiveClick: async () => {
      d.loading = true;
      resetting.value = true;
      try {
        const msg = await resetBmc(username.value, password.value);
        message.success(msg, { duration: 8000 });
      } catch (e) {
        message.error((e as Error).message, { duration: 8000 });
      } finally {
        d.loading = false;
        resetting.value = false;
      }
    },
  });
}

onMounted(async () => {
  try {
    const res = await fetch('/api/auth/me');
    const data = (await res.json()) as { loggedIn: boolean; username?: string };
    if (data.loggedIn) {
      auth.loggedIn = true;
      auth.username = data.username ?? '';
      router.push('/dashboard');
    }
  } catch {
    /* 代理未启动 */
  }
});
</script>

<template>
  <div style="height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box">
    <n-card title="MegaRAC Next · 登录" style="width: min(380px, 100%)" :bordered="true">
      <n-form @submit.prevent="onSubmit">
        <n-form-item label="BMC 用户名">
          <n-input v-model:value="username" placeholder="admin" />
        </n-form-item>
        <n-form-item label="BMC 密码">
          <n-input v-model:value="password" type="password" show-password-on="click" placeholder="密码" @keyup.enter="onSubmit" />
        </n-form-item>
        <n-button type="primary" block :loading="loading" attr-type="submit">登录</n-button>

        <n-divider style="margin: 14px 0 10px" />

        <!-- 用外框线样式（不带填充）：这是个救援操作，视觉上不该抢登录按钮的注意力 -->
        <n-button block size="small" :bordered="true" :loading="resetting" @click="onReset">重置 BMC</n-button>
        <n-text depth="3" style="display: block; margin-top: 6px; font-size: 12px; line-height: 1.6">
          登录不上时用（例如提示「BMC 的 web 会话表已满」）：用上面这组账密向 BMC 认证后重启它的管理控制器，约 2.5 分钟恢复，主机与虚拟机不受影响。
        </n-text>
      </n-form>
    </n-card>
  </div>
</template>
