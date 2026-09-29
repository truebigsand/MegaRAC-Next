// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
// 验证档案更新协议：POST 是否只能创建、PUT 是否能更新、DELETE 路径是否有效。
// 全程只创建一个一次性测试档案 ZZ_TEST_UI，最后删除；不改动运行模式。
const PROXY = 'http://127.0.0.1:5177';
const USER = process.env.BMC_USER || 'admin';
const PASS = process.env.BMC_PASS || '';
let cookie = '';

async function req(method, path, body) {
  const res = await fetch(PROXY + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 300) };
}

const T = 'ZZ_TEST_UI';
console.log('login:', (await req('POST', '/api/auth/login', { username: USER, password: PASS })).status);

const base = (await req('GET', '/bmc/settings/fanprofile/collection')).json.find((p) => p.strName === 'default');
const mk = (duty) => ({
  strVersion: base.strVersion ?? '1.00',
  strName: T,
  arrPolicy: [{ ...base.arrPolicy[0], iInitDuty: duty }],
});

// 1) 创建
const create = await req('POST', '/bmc/settings/fanprofile/collection', mk(33));
console.log('\n[1] POST 创建新档案:', create.status, create.text);
console.log('    列表中是否出现:', (await req('GET', '/bmc/settings/fanprofile/collection')).json.map((p) => p.strName).join(', '));

// 2) 重复 POST（复现用户看到的报错）
const dup = await req('POST', '/bmc/settings/fanprofile/collection', mk(34));
console.log('\n[2] 重复 POST 同名:', dup.status, dup.text);

// 3) PUT 到带名称的路径
const put = await req('PUT', `/bmc/settings/fanprofile/collection/${T}`, mk(35));
console.log('\n[3] PUT /collection/<名称>:', put.status, put.text);
const after = (await req('GET', '/bmc/settings/fanprofile/collection')).json.find((p) => p.strName === T);
console.log('    PUT 后 iInitDuty =', after?.arrPolicy?.[0]?.iInitDuty, '（期望 35）');

// 4) PUT 到集合路径（Backbone 另一种可能的形态）
const put2 = await req('PUT', '/bmc/settings/fanprofile/collection', mk(36));
console.log('\n[4] PUT /collection:', put2.status, put2.text);
const after2 = (await req('GET', '/bmc/settings/fanprofile/collection')).json.find((p) => p.strName === T);
console.log('    PUT 后 iInitDuty =', after2?.arrPolicy?.[0]?.iInitDuty, '（若为 36 说明集合路径也可）');

// 5) DELETE 清理
const del = await req('DELETE', `/bmc/settings/fanprofile/collection/${T}`);
console.log('\n[5] DELETE /collection/<名称>:', del.status, del.text);
const names = (await req('GET', '/bmc/settings/fanprofile/collection')).json.map((p) => p.strName);
console.log('    剩余档案:', names.join(', '), names.includes(T) ? '（⚠️ 未删掉）' : '（✓ 已清理）');

await req('POST', '/api/auth/logout');
console.log('\nlogout done');
