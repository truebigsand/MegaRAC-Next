import { createRouter, createWebHashHistory } from 'vue-router';
import MainLayout from './layouts/MainLayout.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./pages/Login.vue'),
    },
    {
      path: '/',
      component: MainLayout,
      children: [
        { path: '', redirect: '/dashboard' },
        { path: 'dashboard', name: 'dashboard', component: () => import('./pages/Dashboard.vue') },
        { path: 'sensors', name: 'sensors', component: () => import('./pages/Sensors.vue') },
        { path: 'power', name: 'power', component: () => import('./pages/PowerControl.vue') },
        { path: 'fans', name: 'fans', component: () => import('./pages/FanControl.vue') },
        { path: 'logs', name: 'logs', component: () => import('./pages/EventLog.vue') },
        { path: 'history', name: 'history', component: () => import('./pages/History.vue') },
        { path: 'inventory', name: 'inventory', component: () => import('./pages/Inventory.vue') },
        { path: 'kvm', name: 'kvm', component: () => import('./pages/Kvm.vue') },
        { path: 'settings', name: 'settings', component: () => import('./pages/Settings.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
  ],
});
