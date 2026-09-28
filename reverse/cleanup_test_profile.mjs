// 清理测试档案 ZZ_TEST_UI，顺带验证 DELETE 路径（代理修复后）
const PROXY = 'http://127.0.0.1:5177';
let cookie = '';
async function req(method, path, body) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(PROXY + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, text: await res.text() };
}
const names = (r) => { try { return JSON.parse(r).map((p) => p.strName).join(', '); } catch { return '(解析失败) ' + r.slice(0, 80); } };

console.log('login:', (await req('POST', '/api/auth/login', { username: 'admin', password: 'REDACTED_BMC_PASSWORD' })).status);
console.log('清理前:', names((await req('GET', '/bmc/settings/fanprofile/collection')).text));

const del = await req('DELETE', '/bmc/settings/fanprofile/collection/ZZ_TEST_UI');
console.log('DELETE ZZ_TEST_UI:', del.status, del.text.slice(0, 150));

const after = (await req('GET', '/bmc/settings/fanprofile/collection')).text;
console.log('清理后:', names(after), after.includes('ZZ_TEST_UI') ? '（⚠️ 仍在）' : '（✓ 已删除）');
await req('POST', '/api/auth/logout');
