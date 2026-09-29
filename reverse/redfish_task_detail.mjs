import { Agent, fetch as uFetch } from 'undici';
const HOST='192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req=(p,o={})=>uFetch(`https://${HOST}${p}`,{...o,dispatcher:agent,headers:{'content-type':'application/json',...(o.headers||{})},signal:AbortSignal.timeout(40000)});
const r=await req('/redfish/v1/SessionService/Sessions',{method:'POST',body:JSON.stringify({UserName:'admin',Password:process.env.BMC_PASS||''})});
const h={'x-auth-token':r.headers.get('x-auth-token')};
const d=await (await req('/redfish/v1/TaskService/Tasks/1',{headers:h})).json();
console.log('TaskState:', d.TaskState, '| Percent:', d.PercentComplete);
for (const m of d.Messages || []) console.log(' -', m.MessageId, '|', m.Message);
// 还看看 UpdateService 有没有留下线索
const u=await (await req('/redfish/v1/UpdateService',{headers:h})).json();
console.log('UpdateService 状态:', JSON.stringify({ServiceEnabled:u.ServiceEnabled,Status:u.Status,FirmwareInventory:!!u.FirmwareInventory}));
process.exit(0);
