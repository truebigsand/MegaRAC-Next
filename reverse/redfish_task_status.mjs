import { Agent, fetch as uFetch } from 'undici';
const HOST='192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req=(p,o={})=>uFetch(`https://${HOST}${p}`,{...o,dispatcher:agent,headers:{'content-type':'application/json',...(o.headers||{})},signal:AbortSignal.timeout(30000)});
try {
  const r=await req('/redfish/v1/SessionService/Sessions',{method:'POST',body:JSON.stringify({UserName:'admin',Password:process.env.BMC_PASS||''})});
  if (!r.headers.get('x-auth-token')) { console.log('建会话失败:', r.status, (await r.text()).slice(0,120)); process.exit(0); }
  const h={'x-auth-token':r.headers.get('x-auth-token')};
  const t=await req('/redfish/v1/TaskService/Tasks/1',{headers:h});
  console.log('Task:', t.status);
  const d=await t.json();
  console.log(JSON.stringify({TaskState:d.TaskState,PercentComplete:d.PercentComplete,TaskStatus:d.TaskStatus,Messages:d.Messages},null,1).slice(0,700));
} catch(e){ console.log('查询异常:', e.name, e.message.slice(0,80)); }
process.exit(0);
