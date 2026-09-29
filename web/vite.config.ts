import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // /api/kvm 是 WebSocket 中继，必须显式打开 ws 升级转发
      '/api': { target: 'http://127.0.0.1:5177', ws: true },
      '/bmc': 'http://127.0.0.1:5177',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
  },
});
