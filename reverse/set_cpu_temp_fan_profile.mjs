// 把风扇调速策略设置为「等效 CPU0_TEMP」曲线并应用。
//
// 背景：运行中的 default 档案以 CPU0_DTS（AMD 温度余量，= 100 − CPU温度）为源，
// 曲线 arrRef=[43,30,20,7] → arrDuty=[30,75,90,100]。
// 实测 60/60 样本满足 CPU0_TEMP + CPU0_DTS = 100 恒等，故等效换算：
//   arrRef = 100 − [43,30,20,7] = [57,70,80,93]，arrDuty 不变。
//
// 做法：新增档案 CPU_TEMP（含度最高的 default 原样保留，用于随时回退），
//      再把运行模式切到 CPU_TEMP。
import fs from 'node:fs';

const PROXY = 'http://127.0.0.1:5177';
const USER = process.env.BMC_USER || 'admin';
const PASS = process.env.BMC_PASS || 'REDACTED_BMC_PASSWORD';
const APPLY = process.argv.includes('--apply');

let cookie = '';
async function req(method, path, body) {
  const res = await fetch(PROXY + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

const log = (...a) => console.log(...a);

// ---------- 1. 登录 ----------
const login = await req('POST', '/api/auth/login', { username: USER, password: PASS });
if (login.status !== 200) {
  console.error('登录失败', login.status, login.text.slice(0, 200));
  process.exit(1);
}
log('✓ 登录代理成功（BMC 会话已建立）');

try {
  // ---------- 2. 备份现状 ----------
  const before = await req('GET', '/bmc/settings/fanprofile/collection');
  const modeBefore = await req('GET', '/bmc/settings/fanprofile/mode');
  fs.mkdirSync('reverse/profiles', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(`reverse/profiles/backup-collection-${stamp}.json`, JSON.stringify(before.json, null, 2));
  fs.writeFileSync(`reverse/profiles/backup-mode-${stamp}.json`, JSON.stringify(modeBefore.json, null, 2));
  log(`✓ 已备份现状 → reverse/profiles/backup-*-${stamp}.json`);
  log('  当前运行档案:', JSON.stringify(modeBefore.json));
  log('  现有档案:', (before.json ?? []).map((p) => p.strName).join(', '));

  const base = (before.json ?? []).find((p) => p.strName === 'default');
  if (!base) {
    console.error('✗ 未找到 default 档案，中止');
    process.exit(1);
  }
  const src = base.arrPolicy[0];
  log('  default 曲线:', JSON.stringify({ arrSensor: src.arrSensor, arrRef: src.arrRef, arrDuty: src.arrDuty }));

  // ---------- 3. 构造等效 CPU_TEMP 档案 ----------
  const profile = {
    strVersion: base.strVersion ?? '1.00',
    strName: 'CPU_TEMP',
    arrPolicy: [
      {
        ...src,                                   // 保留全部字段（含 OEM 隐藏字段）
        arrSensor: [1],                           // 1 = CPU0_TEMP 的 sensor_number
        arrRef: src.arrRef.map((r) => 100 - r),   // 43/30/20/7 → 57/70/80/93
        // arrDuty 不变：30/75/90/100
      },
    ],
  };
  log('\n待写入档案:');
  log('  名称: CPU_TEMP');
  log('  源传感器:', JSON.stringify(profile.arrPolicy[0].arrSensor), '(CPU0_TEMP)');
  log('  曲线:', profile.arrPolicy[0].arrRef.map((r, i) => `${r}°C→${profile.arrPolicy[0].arrDuty[i]}%`).join('  '));
  log('  被控风扇:', JSON.stringify(profile.arrPolicy[0].arrFanSensor));

  if (!APPLY) {
    log('\n[演练模式] 未写入。加 --apply 实际执行。');
    process.exit(0);
  }

  // ---------- 4. 写入新档案 ----------
  const post = await req('POST', '/bmc/settings/fanprofile/collection', profile);
  log(`\n→ POST collection: HTTP ${post.status} ${post.text.slice(0, 200)}`);
  if (post.status >= 400) {
    console.error('✗ 写入失败，未改动运行模式，default 仍在运行');
    process.exit(1);
  }

  // ---------- 5. 校验档案已存在 ----------
  const after = await req('GET', '/bmc/settings/fanprofile/collection');
  const names = (after.json ?? []).map((p) => p.strName);
  log('  写入后档案列表:', names.join(', '));
  if (!names.includes('CPU_TEMP')) {
    console.error('✗ 档案未出现在列表中，中止（不切换运行模式）');
    process.exit(1);
  }
  const saved = (after.json ?? []).find((p) => p.strName === 'CPU_TEMP');
  log('  已存曲线:', JSON.stringify({ arrSensor: saved.arrPolicy[0].arrSensor, arrRef: saved.arrPolicy[0].arrRef, arrDuty: saved.arrPolicy[0].arrDuty }));

  // ---------- 6. 应用（切换运行模式） ----------
  const apply = await req('POST', '/bmc/settings/fanprofile/mode', { strMode: 'CPU_TEMP' });
  log(`\n→ POST mode=CPU_TEMP: HTTP ${apply.status} ${apply.text.slice(0, 200)}`);

  const modeAfter = await req('GET', '/bmc/settings/fanprofile/mode');
  log('  当前运行档案:', JSON.stringify(modeAfter.json));

  // ---------- 7. 观察风扇与温度 ----------
  log('\n观察 30 秒（CPU 温度 / 风扇转速）...');
  for (let i = 0; i < 6; i++) {
    const s = await req('GET', '/bmc/sensors');
    const pick = (n) => s.json?.find((x) => x.name === n)?.reading ?? '?';
    log(`  ${String(i * 5).padStart(2)}s  CPU0_TEMP=${pick('CPU0_TEMP')}°C  CPU0_DTS=${pick('CPU0_DTS')}  CPU0_FAN=${pick('CPU0_FAN')}  SYS_FAN1=${pick('SYS_FAN1')}`);
    if (i < 5) await new Promise((r) => setTimeout(r, 5000));
  }

  log('\n完成。回退方式：POST /bmc/settings/fanprofile/mode {"strMode":"default"}');
} finally {
  await req('POST', '/api/auth/logout');
  log('✓ 已注销（BMC 会话已释放）');
}
