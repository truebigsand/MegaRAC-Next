// 等 BMC 会话表腾出槽位后再跑 KVM 握手实测；最多尝试 N 次，每次间隔 45s。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { spawn } from 'node:child_process';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';

const PROXY = 'http://127.0.0.1:5177';
const MAX_TRIES = 20;

for (let i = 1; i <= MAX_TRIES; i++) {
  const res = await fetch(PROXY + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS }),
  });
  const text = await res.text();
  console.log(`[${new Date().toLocaleTimeString()}] 第 ${i} 次登录: ${res.status} ${res.status === 200 ? '' : text.slice(0, 80)}`);
  if (res.status === 200) {
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    // 立刻跑握手实测（复用这次的浏览器会话）
    await new Promise((resolve) => {
      const p = spawn(process.execPath, ['reverse/kvm_handshake_probe.mjs'], {
        cwd: process.cwd(),
        env: { ...process.env, REUSE_COOKIE: cookie },
        stdio: 'inherit',
      });
      p.on('exit', resolve);
    });
    break;
  }
  if (i < MAX_TRIES) await new Promise((r) => setTimeout(r, 45000));
}
