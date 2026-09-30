// 控制台日志格式化。
//
// 为什么自己写而不用 pino-pretty：只为可读性引入一个生产依赖不划算，
// 而且我们要的形状很具体——**每个请求一行**（含客户端 IP、状态码、耗时），
// 这用 pino 的内置 req/res 两条日志凑不出来（它们分别是 "incoming request" 与
// "request completed"，且后者的 bindings 里没有 URL）。
//
// 两种模式，用 LOG_FORMAT 选：
//   pretty（默认）——人看的：  `16:20:31.123 INF GET /api/health 200 5ms ip=192.168.0.101 peer=… reqId=req-1`
//   json           —— 机器看的：与原来的 pino 行同构（level 数字 + time + msg + 字段），
//                     便于 journald/日志管道用 jq 过滤；这次改造前的解析脚本仍然可用。
//
// 级别用 LOG_LEVEL 控制（trace/debug/info/warn/error/fatal，默认 info）。
import { hostname } from 'node:os';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_NUM: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LEVEL_TAG: Record<LogLevel, string> = { trace: 'TRC', debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' };
const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[35m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[90m';

/** pino 里 silent 表示"什么都不输出"，用一个大阈值表示 */
const SILENT = 100;

const isLevel = (v: string): v is LogLevel => v in LEVEL_NUM;

/** 结构与 Fastify 期望的 pino 接口对齐（含 silent），否则 loggerInstance 类型不通过 */
export interface LoggerLike {
  level: string;
  child(bindings: Record<string, unknown>): LoggerLike;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  silent(...args: unknown[]): void;
}

/** 值 → 单行文本（太长就截断，避免一条日志刷屏） */
function fmtValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return /[\s"']/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Error) return v.message;
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  } catch {
    return String(v);
  }
}

function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 把 pino 风格的调用（msg, obj / obj, msg / Error, msg）揉成 消息 + 字段 */
function splitArgs(args: unknown[]): { msg: string; fields: Record<string, unknown>; err?: Error } {
  const fields: Record<string, unknown> = {};
  let msg = '';
  let err: Error | undefined;
  for (const a of args) {
    if (a instanceof Error) {
      err = a;
      if (!msg) msg = a.message;
    } else if (typeof a === 'string') {
      msg = msg ? `${msg} ${a}` : a;
    } else if (a && typeof a === 'object') {
      Object.assign(fields, a as Record<string, unknown>);
    } else if (a !== undefined) {
      msg = msg ? `${msg} ${String(a)}` : String(a);
    }
  }
  return { msg, fields, err };
}

export interface LoggerOptions {
  level?: string;
  /** 由 LOG_FORMAT 决定；pretty 时若 stdout 不是 TTY 会自动去掉颜色 */
  pretty?: boolean;
  /** 显式指定是否带颜色（child 继承父的决定，避免子 logger 重算时与父不一致） */
  color?: boolean;
  bindings?: Record<string, unknown>;
}

class ConsoleLogger implements LoggerLike {
  private threshold: number;
  private readonly pretty: boolean;
  private readonly color: boolean;
  private readonly bindings: Record<string, unknown>;

  constructor(opts: LoggerOptions = {}) {
    const lvl = String(opts.level ?? 'info').toLowerCase();
    this.threshold = lvl === 'silent' ? SILENT : LEVEL_NUM[isLevel(lvl) ? lvl : 'info'];
    this.pretty = opts.pretty ?? true;
    // 重定向到文件/管道时不该塞 ANSI 颜色（`docker logs` 到终端时有颜色，重定向后没有）
    this.color = opts.color ?? (this.pretty && !!process.stdout.isTTY && process.env.NO_COLOR === undefined);
    this.bindings = opts.bindings ?? {};
  }

  get level(): string {
    if (this.threshold >= SILENT) return 'silent';
    return (Object.keys(LEVEL_NUM) as LogLevel[]).find((l) => LEVEL_NUM[l] === this.threshold) ?? 'info';
  }
  set level(v: string) {
    const lvl = String(v).toLowerCase();
    if (lvl === 'silent') this.threshold = SILENT;
    else if (isLevel(lvl)) this.threshold = LEVEL_NUM[lvl];
  }

  child(bindings: Record<string, unknown>): LoggerLike {
    // 子 logger 继承格式、颜色与级别；带上自己的 bindings（Fastify 会给每个请求挂 reqId）
    return new ConsoleLogger({
      pretty: this.pretty,
      color: this.color,
      level: this.level,
      bindings: { ...this.bindings, ...bindings },
    });
  }

  private write(level: LogLevel, args: unknown[]): void {
    if (LEVEL_NUM[level] < this.threshold) return;
    const { msg, fields, err } = splitArgs(args);
    const all = { ...this.bindings, ...fields };
    if (this.pretty) {
      const tag = `${this.color ? LEVEL_COLOR[level] : ''}${LEVEL_TAG[level]}${this.color ? RESET : ''}`;
      const head = `${this.color ? DIM : ''}${stamp()}${this.color ? RESET : ''} ${tag} ${msg}`;
      const tail = Object.entries(all)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${this.color ? DIM : ''}${k}=${this.color ? RESET : ''}${fmtValue(v)}`)
        .join(' ');
      process.stdout.write(`${head}${tail ? '  ' + tail : ''}\n`);
      if (err?.stack) {
        // 栈单独缩进输出：一行日志里塞整个栈就没法读了
        const stack = err.stack.split('\n').slice(1, 6).join('\n    ');
        process.stdout.write(`    ${stack}\n`);
      }
    } else {
      // json 模式：与改造前的 pino 行同构（level 是数字、time 是毫秒）
      const line = JSON.stringify({
        level: LEVEL_NUM[level],
        time: Date.now(),
        pid: process.pid,
        hostname: hostname(),
        msg,
        ...all,
        ...(err ? { err: { type: err.name, message: err.message, stack: err.stack } } : {}),
      });
      process.stdout.write(`${line}\n`);
    }
  }

  trace(...a: unknown[]) {
    this.write('trace', a);
  }
  debug(...a: unknown[]) {
    this.write('debug', a);
  }
  info(...a: unknown[]) {
    this.write('info', a);
  }
  warn(...a: unknown[]) {
    this.write('warn', a);
  }
  error(...a: unknown[]) {
    this.write('error', a);
  }
  fatal(...a: unknown[]) {
    this.write('fatal', a);
  }
  /** pino 的 silent：什么都不输出（Fastify 的接口里有它） */
  silent(..._a: unknown[]) {
    /* 按定义不输出 */
  }
}

/** 是否输出给人看的格式（LOG_FORMAT=json 时输出机器可读的 JSON 行） */
export const LOG_PRETTY = String(process.env.LOG_FORMAT ?? 'pretty').toLowerCase() !== 'json';

export function createLogger(opts: LoggerOptions = {}): LoggerLike {
  return new ConsoleLogger({ pretty: LOG_PRETTY, level: process.env.LOG_LEVEL, ...opts });
}
