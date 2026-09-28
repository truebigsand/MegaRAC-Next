<script setup lang="ts">
import { NCard, NButton, NSpace, NText } from 'naive-ui';

function openKvm() {
  window.open('https://192.168.0.200/#remote_control', '_blank', 'noopener');
}
</script>

<template>
  <n-space vertical size="large">
    <n-card title="KVM 远程控制台">
      <n-space vertical>
        <n-text depth="3">远程查看主机画面并操作键鼠，通过 BMC 在新窗口打开。</n-text>
        <div>
          <n-button type="primary" @click="openKvm">打开远程控制台</n-button>
        </div>
      </n-space>
    </n-card>
  </n-space>
</template>
