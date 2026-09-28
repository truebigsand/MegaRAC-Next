// 实验：确定风扇策略在选中多个源传感器时如何合并读数
//
// 方法：曲线 refs=[A,B] duty=[10,90]（A=CPU0_TEMP-2，B=CPU0_DTS+2），
// 于是当前温度下三种可能规则对应明显不同的占空比：
//   取第一个/第二个传感器 → 低占空比；取平均 → 中等；取最大 → 高占空比
// 两阶段：arrSensor=[1,12] 与 [12,1]，顺序对调可区分"取第一个"与"取最大"。
// 观测风扇转速（占空比 → RPM 映射：1%≈1950、30%≈2250 RPM，差异可分辨）。
// 无论成功失败，finally 都会切回原运行档案并删除测试档案。
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
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const readSensors = async () => {
  const r = await req('GET', '/bmc/sensors');
  const pick = (n) => r.json?.find((x) => x.name === n)?.reading ?? NaN;
  return { temp: pick('CPU0_TEMP'), dts: pick('CPU0_DTS'), cpuFan: pick('CPU0_FAN'), sysFan1: pick('SYS_FAN1') };
};

const observe = async (label, seconds) => {
  console.log(`\n--- 观察 ${label}（${seconds}s）---`);
  const samples = [];
  for (let i = 0; i < seconds / 5; i++) {
    const s = await readSensors();
    samples.push(s);
    console.log(`  ${String(i * 5).padStart(2)}s  CPU0_TEMP=${s.temp}  CPU0_DTS=${s.dts}  CPU0_FAN=${s.cpuFan}  SYS_FAN1=${s.sysFan1}`);
  }
  const avg = (k) => Math.round(samples.reduce((a, b) => a + b[k], 0) / samples.length);
  return { cpuFan: avg('cpuFan'), sysFan1: avg('sysFan1'), temp: avg('temp'), dts: avg('dts') };
};

await req('POST', '/api/auth/login', { username: 'admin', password: 'REDACTED_BMC_PASSWORD' });

const modeBefore = (await req('GET', '/bmc/settings/fanprofile/mode')).json?.strMode;
const before = await readSensors();
console.log('原运行档案:', modeBefore, '| 当前读数:', JSON.stringify(before));

let createdName = null;
try {
  // 动态构造曲线：让"低/中/高"三档明显分开
  const A = before.temp - 2;
  const B = before.dts + 2;
  const base = (await req('GET', '/bmc/settings/fanprofile/collection')).json.find((p) => p.strName === 'default') ?? null;
  const policyTemplate = base?.arrPolicy?.[0] ?? {
    iPolicyType: 2, iInSDR: 1, iSensorCode: 1, iInitDuty: 10, iCpuTdp: 0, iAmbientSensor: 0,
    iAmbientSensorTemp: 0, arrFanSensor: [184, 186, 187, 188, 189, 190],
    arrHexVendorID: [], arrHexDeviceID: [], iPCIEDeviceEnable: 0, iHysteresis: 0,
  };
  const makeProfile = (sensors) => ({
    strVersion: '1.00',
    strName: TEST_NAME,
    arrPolicy: [{ ...policyTemplate, arrSensor: sensors, arrRef: [A, B], arrDuty: [10, 90], iInitDuty: 10 }],
  });
  console.log(`\n测试曲线: ${A}→10%  ${B}→90%（线性插值下：读${before.temp}→约14%、读${Math.round((before.temp + before.dts) / 2)}→约50%、读${before.dts}→约86%）`);

  // 阶段 1：[CPU0_TEMP, CPU0_DTS]
  const p1 = await req('POST', '/bmc/settings/fanprofile/collection', makeProfile([1, 12]));
  console.log('\n创建测试档案 [1,12]:', p1.status);
  createdName = TEST_NAME;
  console.log('切换运行:', (await req('POST', '/bmc/settings/fanprofile/mode', { strMode: TEST_NAME })).status);
  const r1 = await observe('arrSensor=[1, 12]（CPU0_TEMP 在前）', 40);

  // 阶段 2：顺序对调 [CPU0_DTS, CPU0_TEMP]
  const p2 = await req('PUT', `/bmc/settings/fanprofile/collection/${TEST_NAME}`, makeProfile([12, 1]));
  console.log('\n更新测试档案 [12,1]:', p2.status);
  console.log('重新应用:', (await req('POST', '/bmc/settings/fanprofile/mode', { strMode: TEST_NAME })).status);
  const r2 = await observe('arrSensor=[12, 1]（CPU0_DTS 在前）', 40);

  console.log('\n================ 结果 ================');
  console.log(`阶段1 [1,12] → CPU0_FAN 均值 ${r1.cpuFan} RPM, SYS_FAN1 ${r1.sysFan1} RPM（温度 ${r1.temp}/${r1.dts}）`);
  console.log(`阶段2 [12,1] → CPU0_FAN 均值 ${r2.cpuFan} RPM, SYS_FAN1 ${r2.sysFan1} RPM（温度 ${r2.temp}/${r2.dts}）`);
  console.log('参考：本机同风扇 1% 占空比≈1950 RPM、30%≈2250 RPM');
} finally {
  console.log('\n--- 恢复 ---');
  if (modeBefore) {
    const r = await req('POST', '/bmc/settings/fanprofile/mode', { strMode: modeBefore });
    console.log(`切回原档案 ${modeBefore}:`, r.status, r.text.slice(0, 80));
  }
  if (createdName) {
    const d = await req('DELETE', `/bmc/settings/fanprofile/collection/${createdName}`);
    console.log(`删除测试档案 ${createdName}:`, d.status);
  }
  const after = await readSensors();
  console.log('恢复后读数:', JSON.stringify(after));
  await req('POST', '/api/auth/logout');
}
