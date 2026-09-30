// 用**登录页填的账号密码**重置 BMC（BMC 管理控制器冷复位）。
//
// 为什么走 Redfish 而不是 IPMI：
//   · 这个功能就是给"web 会话表满、连登录都进不去"准备的救援口（错误码 15000），
//     而实测此时**经典接口全线被拒、Redfish 仍能正常建会话**（2026-09-30 实测），
//     所以 Redfish 是唯一还能用的通道；
//   · 也省掉了在 Node 侧实现 IPMI 协议的麻烦（scripts 里的 ipmi_reset_bmc.py 需要 Python）。
//
// 动作规格取自 BMC 自己宣告的 ResetActionInfo：
//   target /redfish/v1/Managers/Self/Actions/Manager.Reset
//   ResetType 必填，AllowableValues = ["ForceRestart"]
//
// ⚠️ 重置只影响 BMC 自身（约 2.5 分钟），主机与其上的虚拟机不受影响。
import { Agent, fetch as undiciFetch } from 'undici';
import { BMC_BASE } from './redfish.js';

const agent = new Agent({ connect: { rejectUnauthorized: false } });
const RESET_TARGET = '/redfish/v1/Managers/Self/Actions/Manager.Reset';
/** 两次重置之间的最小间隔：重置期间 BMC 会失联，重复请求既无意义又可能把状态搞乱 */
const COOLDOWN_MS = Number(process.env.BMC_RESET_COOLDOWN_MS || 60_000);

export interface ResetResult {
  ok: boolean;
  status: number;
  message: string;
}

let lastResetAt = 0;
let inFlight = false;

export async function resetBmcWithCredentials(username: string, password: string): Promise<ResetResult> {
  if (inFlight) {
    return { ok: false, status: 429, message: '上一次重置还在进行中，请稍候' };
  }
  const since = Date.now() - lastResetAt;
  if (since < COOLDOWN_MS) {
    return { ok: false, status: 429, message: `重置过于频繁（${Math.ceil((COOLDOWN_MS - since) / 1000)} 秒后可再试）` };
  }

  inFlight = true;
  try {
    // 1) 用填写的凭据建 Redfish 会话——这一步同时就是对凭据的校验
    const login = await undiciFetch(`${BMC_BASE}/redfish/v1/SessionService/Sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ UserName: username, Password: password }),
      dispatcher: agent,
      signal: AbortSignal.timeout(45_000),
    });
    const token = login.headers.get('x-auth-token');
    if (!token) {
      const text = (await login.text()).slice(0, 200).replace(/\s+/g, ' ');
      return {
        ok: false,
        status: 401,
        message: login.status === 401 ? '用户名或密码不正确' : `BMC 拒绝建立 Redfish 会话（HTTP ${login.status}）${text}`,
      };
    }

    // 2) 触发重置。BMC 会立刻开始重启，这个请求通常收不到回应（连接被切断），
    //    所以超时/连接中断都按"已发出"处理——这正是我们想要的结果。
    try {
      const res = await undiciFetch(`${BMC_BASE}${RESET_TARGET}`, {
        method: 'POST',
        headers: { 'x-auth-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ ResetType: 'ForceRestart' }),
        dispatcher: agent,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status >= 400) {
        const text = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
        return { ok: false, status: res.status, message: `BMC 拒绝重置（HTTP ${res.status}）${text}` };
      }
    } catch (e) {
      // 连接被切断 = BMC 已经开始重启，属预期
      const name = (e as Error).name;
      if (name !== 'TimeoutError' && name !== 'TypeError') throw e;
    }

    lastResetAt = Date.now();
    return {
      ok: true,
      status: 200,
      message: 'BMC 重置指令已发出：管理控制器将重启约 2.5 分钟，主机与其上的虚拟机不受影响；期间界面会失联，稍后重新登录即可。',
    };
  } catch (e) {
    return { ok: false, status: 502, message: `无法连接 BMC：${(e as Error).message}` };
  } finally {
    inFlight = false;
  }
}
