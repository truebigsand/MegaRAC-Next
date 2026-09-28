import { reactive } from 'vue';

export const auth = reactive({
  loggedIn: false,
  username: '',
});

export function onUnauthorized(): void {
  auth.loggedIn = false;
  auth.username = '';
  if (location.hash !== '#/login') location.hash = '#/login';
}
