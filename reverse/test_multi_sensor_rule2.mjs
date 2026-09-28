// 补充实验：曲线 30→50% / 70→100%，arrSensor=[1,12]
//   取第一个(CPU0_TEMP=32) → 54%   ｜ 取平均(50) → 75% ｜ 取最大(DTS=68) → 96%
// 三档占空比差异明显且都远离低转速平台，可同时证明"档案已生效"与"按哪条规则合并"。
// finally 恢复原档案并删除测试档案。
const PROXY = 'http://127.0.0.1:5177';
const TEST_NAME = 'ZZ_MULTISENSOR';
let cookie = '';
async function req(method, path, body) {
  const h = {};
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(PROXY + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const t = await res.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t };
}
const sense = async () => {
  const r = await req('GET', '/bmc/sensors');
  const p = (n) => r.json?.find((x) => x.name === n)?.reading ?? NaN;
  return { temp: p('CPU0_TEMP'), dts: p('CPU0_DTS'), cpuFan: p('CPU0_FAN'), sysFan1: p('SYS_FAN1') };
};

await req('POST', '/api/auth/login', { username: 'admin', password: 'REDACTED_BMC_PASSWORD' });
const modeBefore = (await req('GET', '/bmc/settings/fanprofile/mode')).json?.strMode;
const before = await sense();
console.log('原运行档案:', modeBefore, '| 当前:', JSON.stringify(before));

try {
  const A = before.temp - 2, B = before.dts + 2;
  const base = (await req('GET', '/bmc/settings/fanprofile/collection')).json.find((p) => p.strName === 'default');
  const policy = {
    ...base.arrPolicy[0],
    arrSensor: [1, 12],
    arrRef: [A, B],
    arrDuty: [50, 100],
    iInitDuty: 50,
  };
  const profile = { strVersion: '1.00', strName: TEST_NAME, arrPolicy: [policy] };
  console.log(`曲线: ${A}→50%  ${B}→100%  ⇒  读${before.temp}(CPU0_TEMP)→约54%  读${Math.round((before.temp + before.dts) / 2)}→约75%  读${before.dts}(CPU0_DTS)→约96%`);
  console.log('写入:', (await req('POST', '/bmc/settings/fanprofile/collection', profile)).status);
  console.log('应用:', (await req('POST', '/bmc/settings/fanprofile/mode', { strMode: TEST_NAME })).status);

  console.log('\n--- 观察 30s ---');
  const fans = [];
  for (let i = 0; i < 6; i++) {
    const s = await sense();
    fans.push(s.cpuFan);
    console.log(`  ${String(i * 5).padStart(2)}s  CPU0_TEMP=${s.temp}  CPU0_DTS=${s.dts}  CPU0_FAN=${s.cpuFan}  SYS_FAN1=${s.sysFan1}`);
    if (i < 5) await new Promise((r) => setTimeout(r, 5000));
  }
  const settled = fans.slice(2); // 后 4 个样本视为稳态
  const avg = Math.round(settled.reduce((a, b) => a + b, 0) / settled.length);
  console.log(`\n稳态均值: CPU0_FAN ${avg} RPM`);
  console.log('对照: 54%占空比≈3000 RPM ｜ 75%≈4000 ｜ 96%≈5000（按本机 30%→2250、86%→4650 外推）');
} finally {
  console.log('\n--- 恢复 ---');
  if (modeBefore) console.log(`切回 ${modeBefore}:`, (await req('POST', '/bmc/settings/fanprofile/mode', { strMode: modeBefore })).status);
  console.log(`删除测试档案:`, (await req('DELETE', `/bmc/settings/fanprofile/collection/${TEST_NAME}`)).status);
  await new Promise((r) => setTimeout(r, 6000));
  console.log('恢复后:', JSON.stringify(await sense()));
  await req('POST', '/api/auth/logout');
}
