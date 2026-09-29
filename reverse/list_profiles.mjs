// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';
const PROXY = 'http://127.0.0.1:5177';
let cookie = '';
async function req(method, path, body) {
  const h = {};
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(PROXY + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, text: await res.text() };
}
await req('POST', '/api/auth/login', { username: 'admin', password: PASS });
const r = await req('GET', '/bmc/settings/fanprofile/collection');
const m = await req('GET', '/bmc/settings/fanprofile/mode');
console.log('档案列表:', JSON.parse(r.text).map((p) => `${p.strName}(init=${p.arrPolicy[0].iInitDuty})`).join(', '));
console.log('运行中:', m.text.trim());
await req('POST', '/api/auth/logout');
