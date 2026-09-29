<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed } from 'vue';
import {
  NAlert, NButton, NCard, NPopconfirm, NSelect, NSpace, NStatistic, NTag, NText,
  useMessage,
} from 'naive-ui';
import { bmcSend } from '../api';
import { KvmClient, type KvmState, type VideoFrame } from '../kvm/client';
import { HID_CODES, MODIFIER_CODES, mouseButtons } from '../kvm/keymap';

const message = useMessage();

const canvasEl = ref<HTMLCanvasElement>();
const wrapEl = ref<HTMLDivElement>();
const state = ref<KvmState>('idle');
const detail = ref('');
const width = ref(0);
const height = ref(0);
const frames = ref(0);
const fps = ref(0);
const mouseMode = ref<'absolute' | 'relative'>('absolute');
/** 缩放：fit = 适应宽度；其余为百分比 */
const scaling = ref<'fit' | '50' | '75' | '100' | '125' | '150'>('fit');
const powerBusy = ref(false);

let client: KvmClient | null = null;
let ctx: CanvasRenderingContext2D | null = null;
/** 修饰键位掩码与按下的普通键（按按下顺序） */
let modifiers = 0;
const pressed: string[] = [];
/** 相对模式下的累计位移基准 */
let relBase = { x: 0, y: 0 };

const stateText = computed(() => {
  const map: Record<KvmState, string> = {
    idle: '未连接',
    connecting: '连接中',
    handshaking: '握手中',
    'waiting-permission': '等待主控权',
    streaming: '画面传输中',
    closed: '已断开',
    failed: '连接失败',
  };
  return map[state.value] ?? state.value;
});

const stateType = computed(() => {
  if (state.value === 'streaming') return 'success';
  if (state.value === 'failed' || state.value === 'closed') return 'error';
  if (state.value === 'idle') return 'default';
  return 'warning';
});

function onFrame(frame: VideoFrame) {
  const canvas = canvasEl.value;
  if (!canvas || !ctx) return;
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  ctx.putImageData(frame.image, 0, 0);
  frames.value = frame.frames;
  fps.value = Math.round(frame.fps * 10) / 10;
}

function onResolution(w: number, h: number) {
  width.value = w;
  height.value = h;
  const canvas = canvasEl.value;
  if (canvas) {
    canvas.width = w;
    canvas.height = h;
  }
}

function onState(next: KvmState, nextDetail: string) {
  state.value = next;
  detail.value = nextDetail;
  if (next === 'failed') message.error(nextDetail || 'KVM 连接失败');
}

function startClient() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  ctx = canvas.getContext('2d', { alpha: false });
  frames.value = 0;
  fps.value = 0;
  client = new KvmClient({ onState, onFrame, onResolution });
  client.start().catch((e: Error) => {
    state.value = 'failed';
    detail.value = e.message;
    message.error('启动失败: ' + e.message);
  });
}

function connect() {
  if (client) return;
  startClient();
}

function disconnect() {
  client?.stop();
  client = null;
  pressed.length = 0;
  modifiers = 0;
  state.value = 'idle';
  detail.value = '';
  frames.value = 0;
  fps.value = 0;
}

function refresh() {
  client?.refresh();
}

/** 截图：把当前画布存成 PNG */
function captureScreen() {
  const canvas = canvasEl.value;
  if (!canvas || frames.value === 0) {
    message.warning('还没有收到画面，无法截图');
    return;
  }
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kvm-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('已保存截图');
  }, 'image/png');
}

/** 全屏显示画面区域（按 Esc 退出） */
function toggleFullscreen() {
  const el = wrapEl.value;
  if (!el) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen();
}

/**
 * 一键发送特殊键。
 * 浏览器里按不出 Ctrl+Alt+Del（会被操作系统截走），Win 键同理，
 * 所以这几个键必须做成按钮从 KVM 侧发出去。
 */
async function sendSpecial(name: 'cad' | 'win' | 'prtscn' | 'context') {
  if (!client || state.value !== 'streaming') {
    message.warning('连接未就绪');
    return;
  }
  const map: Record<typeof name, { modifiers: number; keys: number[]; label: string }> = {
    // Delete = 0x4c；Ctrl+Alt 作为修饰键位掩码
    cad: { modifiers: 0x01 | 0x04, keys: [0x4c], label: 'Ctrl+Alt+Del' },
    win: { modifiers: 0x08, keys: [], label: 'Win 键' },
    prtscn: { modifiers: 0, keys: [0x46], label: 'PrintScreen' },
    context: { modifiers: 0, keys: [0x65], label: '右键菜单键' },
  };
  const k = map[name];
  client.sendKeyboard(k.modifiers, k.keys);
  await new Promise((r) => setTimeout(r, 120));
  client.sendKeyboard(0, []);
  message.success(`已发送 ${k.label}`);
}

/** KVM 页内的电源控制（与电源页同一套 API） */
async function power(cmd: number, label: string) {
  powerBusy.value = true;
  try {
    await bmcSend('POST', 'actions/power', { power_command: cmd });
    message.success(`已发送：${label}`);
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    powerBusy.value = false;
  }
}

// ---------- 输入 ----------

/** 浏览器自带、不能吞掉的按键组合 */
const RESERVED_KEYS = new Set(['F5', 'F11', 'F12']);
const RESERVED_CTRL = new Set(['r', 'w', 't', 'n', 'R', 'W', 'T', 'N']);

function shouldSkipKey(ev: KeyboardEvent): boolean {
  const el = ev.target as HTMLElement | null;
  const tag = el?.tagName;
  // 页面里自己的输入控件优先
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return true;
  if (RESERVED_KEYS.has(ev.key)) return true;
  if ((ev.ctrlKey || ev.metaKey) && RESERVED_CTRL.has(ev.key)) return true;
  if (ev.altKey && ['ArrowLeft', 'ArrowRight', 'Tab'].includes(ev.key)) return true;
  return false;
}

function onKeyDown(ev: KeyboardEvent) {
  if (!client || state.value !== 'streaming') return;
  if (shouldSkipKey(ev)) return;
  const mod = MODIFIER_CODES[ev.code];
  if (mod !== undefined) {
    modifiers |= mod;
    ev.preventDefault();
    client.sendKeyboard(modifiers, pressed.map((c) => HID_CODES[c]));
    return;
  }
  const code = HID_CODES[ev.code];
  if (code === undefined) return;
  ev.preventDefault();
  if (!pressed.includes(ev.code)) pressed.push(ev.code);
  client.sendKeyboard(modifiers, pressed.slice(0, 6).map((c) => HID_CODES[c]));
}

function onKeyUp(ev: KeyboardEvent) {
  if (!client || shouldSkipKey(ev)) return;
  const mod = MODIFIER_CODES[ev.code];
  if (mod !== undefined) {
    modifiers &= ~mod;
    client.sendKeyboard(modifiers, pressed.slice(0, 6).map((c) => HID_CODES[c]));
    return;
  }
  if (HID_CODES[ev.code] === undefined) return;
  const i = pressed.indexOf(ev.code);
  if (i >= 0) pressed.splice(i, 1);
  client.sendKeyboard(modifiers, pressed.slice(0, 6).map((c) => HID_CODES[c]));
}

/** 画面上的浏览器坐标 → 主机坐标 */
function toHost(ev: MouseEvent): { x: number; y: number } {
  const canvas = canvasEl.value!;
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round(Math.max(0, Math.min(width.value, (ev.clientX - rect.left) * (width.value / rect.width)))),
    y: Math.round(Math.max(0, Math.min(height.value, (ev.clientY - rect.top) * (height.value / rect.height)))),
  };
}

function onMouse(ev: MouseEvent, wheel = 0) {
  if (!client || state.value !== 'streaming') return;
  const canvas = canvasEl.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (mouseMode.value === 'relative') {
    relBase = { x: relBase.x + (ev.movementX || 0), y: relBase.y + (ev.movementY || 0) };
    client.sendMouse(mouseButtons(ev), relBase.x, relBase.y, wheel, rect.width, rect.height);
    return;
  }
  const p = toHost(ev);
  client.sendMouse(mouseButtons(ev), p.x, p.y, wheel, width.value, height.value);
}

function onMouseDown(ev: MouseEvent) {
  ev.preventDefault();
  (ev.currentTarget as HTMLElement).focus();
  onMouse(ev);
}

function onWheel(ev: WheelEvent) {
  ev.preventDefault();
  onMouse(ev, ev.deltaY > 0 ? -1 : 1);
}

/** 触屏：触点当作绝对定位鼠标，单击即左键单击 */
function onTouch(ev: TouchEvent) {
  if (!client || state.value !== 'streaming') return;
  ev.preventDefault();
  const touch = ev.touches[0] ?? ev.changedTouches[0];
  if (!touch) return;
  const canvas = canvasEl.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(Math.max(0, Math.min(width.value, (touch.clientX - rect.left) * (width.value / rect.width))));
  const y = Math.round(Math.max(0, Math.min(height.value, (touch.clientY - rect.top) * (height.value / rect.height))));
  const isDown = ev.type !== 'touchend';
  client.sendMouse(isDown ? 1 : 0, x, y, 0, width.value, height.value);
}

function reconnect() {
  disconnect();
  startClient();
}



onMounted(() => {
  connect();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  disconnect();
});
</script>

<template>
  <n-space vertical size="large">
    <n-card>
      <template #header>
        <n-space align="center" :size="12">
          <span>KVM 远程控制台</span>
          <n-tag :type="stateType" size="small">{{ stateText }}</n-tag>
          <n-text v-if="width" depth="3" style="font-size: 13px">{{ width }}×{{ height }}</n-text>
        </n-space>
      </template>
      <template #header-extra>
        <n-space :size="8">
          <n-select
            v-model:value="scaling"
            size="small"
            style="width: 108px"
            :options="[
              { label: '适应宽度', value: 'fit' },
              { label: '50%', value: '50' },
              { label: '75%', value: '75' },
              { label: '100%', value: '100' },
              { label: '125%', value: '125' },
              { label: '150%', value: '150' },
            ]"
          />
          <n-select
            v-model:value="mouseMode"
            size="small"
            style="width: 118px"
            :options="[
              { label: '绝对定位', value: 'absolute' },
              { label: '相对移动', value: 'relative' },
            ]"
          />
          <n-button size="small" @click="refresh">刷新画面</n-button>
          <n-button size="small" @click="captureScreen">截图</n-button>
          <n-button size="small" @click="toggleFullscreen">全屏</n-button>
          <n-button
            v-if="state === 'idle' || state === 'closed' || state === 'failed'"
            size="small"
            type="primary"
            @click="reconnect"
          >
            连接
          </n-button>
          <n-button v-else size="small" type="error" quaternary @click="disconnect">断开</n-button>
        </n-space>
      </template>

      <n-space vertical size="small">
        <n-alert v-if="detail && state !== 'streaming'" type="info" size="small">{{ detail }}</n-alert>

        <div
          ref="wrapEl"
          class="kvm-stage"
          tabindex="0"
          @mousedown="onMouseDown"
          @mouseup="onMouse($event)"
          @mousemove="onMouse($event)"
          @wheel="onWheel"
          @touchstart="onTouch"
          @touchmove="onTouch"
          @touchend="onTouch"
          @contextmenu.prevent
        >
          <canvas
            ref="canvasEl"
            class="kvm-canvas"
            :style="scaling === 'fit' ? undefined : { width: (width * Number(scaling)) / 100 + 'px', height: 'auto' }"
            :class="scaling === 'fit' ? 'kvm-fit' : 'kvm-actual'"
          />
          <div v-if="fps === 0 && state === 'streaming'" class="kvm-overlay">
            已连接，等待主机画面…
          </div>
        </div>

        <n-space align="center" :size="8" :wrap="true">
          <n-text depth="3" style="font-size: 13px">特殊键：</n-text>
          <n-button size="tiny" :disabled="state !== 'streaming'" @click="sendSpecial('cad')">
            Ctrl+Alt+Del
          </n-button>
          <n-button size="tiny" :disabled="state !== 'streaming'" @click="sendSpecial('win')">Win</n-button>
          <n-button size="tiny" :disabled="state !== 'streaming'" @click="sendSpecial('prtscn')">PrintScreen</n-button>
          <n-button size="tiny" :disabled="state !== 'streaming'" @click="sendSpecial('context')">菜单键</n-button>
        </n-space>

        <n-space align="center" :size="8" :wrap="true">
          <n-text depth="3" style="font-size: 13px">电源：</n-text>
          <n-popconfirm @positive-click="power(1, '开启电源')">
            <template #trigger><n-button size="tiny" :loading="powerBusy">开启</n-button></template>
            确认开启主机电源？
          </n-popconfirm>
          <n-popconfirm @positive-click="power(5, 'ACPI 关闭')">
            <template #trigger><n-button size="tiny" :loading="powerBusy">软关机</n-button></template>
            向操作系统发送软关机（ACPI）？
          </n-popconfirm>
          <n-popconfirm @positive-click="power(3, '硬重启')">
            <template #trigger><n-button size="tiny" type="warning" :loading="powerBusy">硬重启</n-button></template>
            硬重启等效按 reset 键，未保存的数据会丢失，确认执行？
          </n-popconfirm>
          <n-popconfirm @positive-click="power(2, '电源循环')">
            <template #trigger><n-button size="tiny" type="warning" :loading="powerBusy">电源循环</n-button></template>
            断电再上电。适用于「BMC 显示在线但系统无响应」，确认执行？
          </n-popconfirm>
          <n-popconfirm @positive-click="power(0, '关闭电源')">
            <template #trigger><n-button size="tiny" type="error" :loading="powerBusy">强制断电</n-button></template>
            立即切断主机电源（等同拔电），确认执行？
          </n-popconfirm>
        </n-space>

        <n-text depth="3" style="font-size: 13px">
          键盘已全局接管（F5 / Ctrl+R / Ctrl+W 等浏览器快捷键仍保留）。主机画面静止时不推送新帧，此时帧率为 0 属正常。
        </n-text>
        <n-space :size="24">
          <n-statistic label="已收帧数" :value="frames" />
          <n-statistic label="帧率" :value="fps" />
        </n-space>
      </n-space>
    </n-card>
  </n-space>
</template>

<style scoped>
.kvm-stage {
  position: relative;
  width: 100%;
  min-height: 320px;
  max-height: 74vh;
  overflow: auto;
  background: #000;
  border-radius: 4px;
  outline: none;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}
.kvm-canvas {
  display: block;
  cursor: crosshair;
  touch-action: none;
}
.kvm-fit {
  max-width: 100%;
  height: auto;
}
.kvm-actual {
  flex: none;
  max-width: none;
}
.kvm-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #bbb;
  font-size: 14px;
  pointer-events: none;
}
</style>
