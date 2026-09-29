import { Agent, fetch as uFetch } from 'undici';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';
const BMC = 'https://192.168.0.200';
// 每次都用**新连接**（不复用连接池）
const fresh = () => new Agent({ connect: { rejectUnauthorized: false, keepAliveTimeout: 1 } });
const reuse = new Agent({ connect: { rejectUnauthorized: false } });

const login = async (dispatcher) => {
  const t0 = Date.now();
  const res = await uFetch(BMC + '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: PASS }).toString(),
    dispatcher,
  });
  const d = JSON.parse(await res.text());
  return { ms: Date.now() - t0, cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '), csrf: d.CSRFToken };
};

for (const [label, mk] of [['复用连接', () => reuse], ['每次新连接', () => fresh()]]) {
  const agent = mk();
  const l = await login(agent);
  const h = { cookie: l.cookie, 'x-csrftoken': l.csrf };
  const times = [];
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const r = await uFetch(BMC + '/api/settings/services', { headers: h, dispatcher: agent });
    await r.text();
    times.push(Date.now() - t0);
  }
  console.log(`${label}: 登录 ${l.ms}ms，4 次 GET 分别 ${times.join(' / ')} ms`);
  await uFetch(BMC + '/api/session', { method: 'DELETE', headers: h, dispatcher: agent }).catch(() => {});
}
process.exit(0);
