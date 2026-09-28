// 复测：曲线 30→10% / 70→100%，arrSensor=[1,12]
//   取第一个(32)→约14%(低≈1950) ｜ 取平均(50)→约55%(中≈3300) ｜ 取最大(68)→约96%(高≈4950)
// 观察 50s；finally 恢复原档案并删除测试档案。
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
  return { temp: p('CPU0_TEMP'), dts: p('CPU0_DTS'), cpuFan: p('CPU0_FAN') };
};

await req('POST', '/api/auth/login', { username: 'admin', password: 'REDACTED_BMC_PASSWORD' });
const modeBefore = (await req('GET', '/bmc/settings/fanprofile/mode')).json?.strMode;
const before = await sense();
console.log('原档案:', modeBefore, '| 当前:', JSON.stringify(before));

try {
  const base = (await req('GET', '/bmc/settings/fanprofile/collection')).json.find((p) => p.strName === 'default');
  const profile = {
    strVersion: '1.00',
    strName: TEST_NAME,
    arrPolicy: [{ ...base.arrPolicy[0], arrSensor: [1, 12], arrRef: [30, 70], arrDuty: [10, 100], iInitDuty: 10 }],
  };
  console.log('曲线 30→10% / 70→100%；写入', (await req('POST', '/bmc/settings/fanprofile/collection', profile)).status,
              '应用', (await req('POST', '/bmc/settings/fanprofile/mode', { strMode: TEST_NAME })).status);
  const fans = [];
  for (let i = 0; i < 10; i++) {
    const s = await sense();
    fans.push(s.cpuFan);
    console.log(`  ${String(i * 5).padStart(2)}s  TEMP=${s.temp} DTS=${s.dts}  CPU0_FAN=${s.cpuFan}`);
    if (i < 9) await new Promise((r) => setTimeout(r, 5000));
  }
  const settled = fans.slice(4);
  console.log(`\n稳态均值 ${Math.round(settled.reduce((a, b) => a + b, 0) / settled.length)} RPM`);
  console.log('判读: ≈1950→取第一个 ｜ ≈3300→取平均 ｜ ≈4950→取最大');
} finally {
  if (modeBefore) console.log('\n切回', modeBefore, (await req('POST', '/bmc/settings/fanprofile/mode', { strMode: modeBefore })).status);
  console.log('删除测试档案', (await req('DELETE', `/bmc/settings/fanprofile/collection/${TEST_NAME}`)).status);
  await new Promise((r) => setTimeout(r, 6000));
  console.log('恢复后:', JSON.stringify(await sense()));
  await req('POST', '/api/auth/logout');
}
