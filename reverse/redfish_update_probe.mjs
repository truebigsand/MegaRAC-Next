import { Agent, fetch as uFetch } from 'undici';
const HOST='192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req=(p,o={})=>uFetch(`https://${HOST}${p}`,{...o,dispatcher:agent,headers:{'content-type':'application/json',...(o.headers||{})},signal:AbortSignal.timeout(60000)});
const r=await req('/redfish/v1/SessionService/Sessions',{method:'POST',body:JSON.stringify({UserName:'admin',Password:process.env.BMC_PASS||''})});
const h={'x-auth-token':r.headers.get('x-auth-token')};
const d=await (await req('/redfish/v1/UpdateService',{headers:h})).json();
console.log(JSON.stringify({ServiceEnabled:d.ServiceEnabled,FirmwareInventoryUpdate:d.FirmwareInventoryUpdate,HttpPushUri:d.HttpPushUri,HttpPushUriTargets:d.HttpPushUriTargets,TransferProtocol:d.TransferProtocol,Actions:d.Actions,MultipartHttpPushUri:d.MultipartHttpPushUri},null,1));
const inv=await (await req('/redfish/v1/UpdateService/FirmwareInventory',{headers:h})).json().catch(()=>null);
if(inv) console.log('FirmwareInventory:', (inv.Members||[]).map(m=>m['@odata.id']));
for (const m of (inv?.Members||[])) { const dd=await (await req(m['@odata.id'],{headers:h})).json().catch(()=>null); if(dd) console.log('  ', dd.Name||dd.Id, dd.Version); }
try{const s=await (await req('/redfish/v1/SessionService/Sessions',{headers:h})).json();for(const m of s.Members||[])await req(m['@odata.id'],{method:'DELETE',headers:h});console.log('会话已注销');}catch{}
process.exit(0);
