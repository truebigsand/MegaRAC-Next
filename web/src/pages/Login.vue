<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NCard, NForm, NFormItem, NInput, NButton, useMessage } from 'naive-ui';
import { login } from '../api';
import { auth } from '../store';

const router = useRouter();
const message = useMessage();
const username = ref('admin');
const password = ref('');
const loading = ref(false);

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
  <div style="height: 100vh; display: flex; align-items: center; justify-content: center">
    <n-card title="MegaRAC Next · 登录" style="width: 380px" :bordered="true">
      <n-form @submit.prevent="onSubmit">
        <n-form-item label="BMC 用户名">
          <n-input v-model:value="username" placeholder="admin" />
        </n-form-item>
        <n-form-item label="BMC 密码">
          <n-input v-model:value="password" type="password" show-password-on="click" placeholder="密码" @keyup.enter="onSubmit" />
        </n-form-item>
        <n-button type="primary" block :loading="loading" attr-type="submit">登录</n-button>
      </n-form>
    </n-card>
  </div>
</template>
