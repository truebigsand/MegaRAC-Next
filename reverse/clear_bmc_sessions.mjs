// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';
// ⚠️ 用完务必注销：该 BMC 的 web 会话上限很小（148），泄漏会占满后
// 导致登录被拒（Maximum number of sessions already in use）且 KVM 升级被降级。
// 清理 BMC 泄漏会话：按服务列出会话并逐个 DELETE（原版"服务"页的同一套接口）
//   GET    /api/settings/service-sessions?service_id=<id>
//   DELETE /api/settings/service-sessions/<会话id>
// 只清会话、不改任何配置；我们自己被清掉后重新登录即可。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PROXY = 'http://127.0.0.1:5177';
const SERVICES = [
  { id: 1, name: 'web' },
  { id: 2, name: 'kvm' },
  { id: 4, name: 'cd-media' },
  { id: 16, name: 'hd-media' },
];

let cookie = '';
async function req(method, path) {
  const h = cookie ? { cookie } : {};
  const res = await fetch(PROXY + path, { method, headers: h });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function login() {
  const res = await fetch(PROXY + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS }),
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return res.status;
}

const counts = async (label) => {
  const r = await req('GET', '/bmc/settings/services');
  if (Array.isArray(r.json)) {
    console.log(`${label}: ` + r.json.map((s) => `${s.service_name} ${s.active_session}/${s.maximum_sessions}`).join('  '));
  }
};

console.log('登录:', await login());
await counts('清理前');

for (const svc of SERVICES) {
  // 自己的会话可能在上一步被清掉，列清单前先确保已登录
  let list = await req('GET', `/bmc/settings/service-sessions?service_id=${svc.id}`);
  if (!Array.isArray(list.json)) {
    console.log(`${svc.name}: 会话已失效，重新登录后重试`);
    console.log(`${svc.name}: 重新登录 → ${await login()}`);
    list = await req('GET', `/bmc/settings/service-sessions?service_id=${svc.id}`);
  }
  if (!list.json || !Array.isArray(list.json)) {
    console.log(`${svc.name}: 列表失败（${list.status} ${list.text.slice(0, 60)}）`);
    continue;
  }
  console.log(`${svc.name}: ${list.json.length} 个会话` + (list.json[0] ? ` 示例=${JSON.stringify(list.json[0]).slice(0, 160)}` : ''));
  let killed = 0;
  for (const s of list.json) {
    const id = s.id ?? s.session_id ?? s.sessionId;
    if (id === undefined) continue;
    const del = await req('DELETE', `/bmc/settings/service-sessions/${id}`);
    if (del.status < 400 && !/not_logged_in/.test(del.text)) killed++;
    else if (/not_logged_in/.test(del.text)) {
      // 自己的会话被清掉后重新登录，继续清剩下的
      await login();
      const again = await req('DELETE', `/bmc/settings/service-sessions/${id}`);
      if (again.status < 400 && !/not_logged_in/.test(again.text)) killed++;
    }
  }
  console.log(`${svc.name}: 已清除 ${killed} 个`);
}

await counts('清理后');
