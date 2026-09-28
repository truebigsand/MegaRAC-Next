<script setup lang="ts">
import { NCard, NAlert, NList, NListItem } from 'naive-ui';
</script>

<template>
  <n-space vertical size="large">
    <n-card title="设置">
      <n-alert type="info" :bordered="false">设置页在阶段⑥实现（FRU / 用户 / 网络 / NTP / 服务）。</n-alert>
      <n-list style="margin-top: 12px">
        <n-list-item>FRU 信息 — <code>GET /api/fru</code>（已实测可用）</n-list-item>
        <n-list-item>用户管理 — <code>GET /api/settings/users</code>（已实测可用）</n-list-item>
        <n-list-item>网络设置 — <code>GET /api/settings/network</code>（已实测可用）</n-list-item>
        <n-list-item>日期时间 / NTP — <code>GET /api/settings/date-time</code>（已实测可用）</n-list-item>
        <n-list-item>服务管理 — <code>GET /api/settings/services</code>（已实测可用）</n-list-item>
      </n-list>
    </n-card>
  </n-space>
</template>
