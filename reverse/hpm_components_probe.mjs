import { Agent, fetch as uFetch } from 'undici';
const HOST='192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw=(p,o={})=>uFetch(`https://${HOST}${p}`,{...o,dispatcher:agent,signal:AbortSignal.timeout(o.timeoutMs||40000)});
const lr=await raw('/api/session',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password:process.env.BMC_PASS||''}).toString()});
const login=await lr.json();
const cookie=(lr.headers.getSetCookie?.()??[]).map(c=>c.split(';')[0]).join('; ');
const h={cookie,'x-csrftoken':login.CSRFToken};
for (const p of ['maintenance/hpm/componentversions','maintenance/hpm/freemem']) {
  const r=await raw('/api/'+p,{headers:h});
  const t=await r.text();
  console.log(`\n=== ${p} → ${r.status} ===`);
  console.log(t.slice(0, 1200));
}
process.exit(0);
