import { Agent, fetch as uFetch } from 'undici';
const HOST='192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req=(p,o={})=>uFetch(`https://${HOST}${p}`,{...o,dispatcher:agent,headers:{'content-type':'application/json',...(o.headers||{})},signal:AbortSignal.timeout(60000)});
const r=await req('/redfish/v1/SessionService/Sessions',{method:'POST',body:JSON.stringify({UserName:'admin',Password:process.env.BMC_PASS||''})});
const h={'x-auth-token':r.headers.get('x-auth-token')};
const d=await (await req('/redfish/v1/UpdateService/SimpleUpdateActionInfo',{headers:h})).json();
console.log('=== SimpleUpdate 参数规格 ===');
for (const p of d.Parameters || []) {
  console.log(`  ${p.Name}: 必填=${p.Required} 类型=${p.DataType}${p.AllowableValues ? ' 允许值=' + JSON.stringify(p.AllowableValues) : ''}`);
}
try{const s=await (await req('/redfish/v1/SessionService/Sessions',{headers:h})).json();for(const m of s.Members||[])await req(m['@odata.id'],{method:'DELETE',headers:h});console.log('会话已注销');}catch{}
process.exit(0);
