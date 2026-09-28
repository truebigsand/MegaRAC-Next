<script setup lang="ts">
import { darkTheme, zhCN, dateZhCN } from 'naive-ui';
import { NConfigProvider, NGlobalStyle, NMessageProvider } from 'naive-ui';
</script>

<template>
  <n-config-provider :theme="darkTheme" :locale="zhCN" :date-locale="dateZhCN">
    <n-global-style />
    <n-message-provider>
      <router-view />
    </n-message-provider>
  </n-config-provider>
</template>
