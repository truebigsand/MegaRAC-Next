// 等 BMC 从刷写模式恢复：轮询 HTTPS 443 与 IPMI(UDP623)，最多等 12 分钟。
import { Agent, fetch as uFetch } from 'undici';
import { spawnSync } from 'node:child_process';

const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const t0 = Date.now();
let webUp = false;

const ipmiAlive = () => {
  const r = spawnSync('python', ['-c', `
from pyghmi.ipmi import command
import os, sys
try:
    c = command.Command(bmc='${HOST}', userid=os.environ.get('BMC_USER','admin'), password=os.environ.get('BMC_PASS',''), timeout=8)
    p = c.get_power()
    print('ok', p.get('powerstate'))
except Exception as e:
    print('fail', type(e).__name__)
`], { env: process.env, encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
};

while (Date.now() - t0 < 12 * 60 * 1000) {
  const elapsed = Math.round((Date.now() - t0) / 1000);
  let web = 'down';
  try {
    const r = await uFetch(`https://${HOST}/redfish/v1`, { dispatcher: agent, signal: AbortSignal.timeout(8000) });
    web = String(r.status);
    await r.text();
  } catch {
    web = 'down';
  }
  const ipmi = ipmiAlive();
  console.log(`[${elapsed}s] web=${web} ipmi=${ipmi}`);
  if (web === '200') {
    console.log('\n✓ BMC 已恢复（web 200）');
    webUp = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 20000));
}
if (!webUp) console.log('\n✗ 12 分钟内未恢复，可能需要人工断电重启 BMC');
process.exit(webUp ? 0 : 1);
