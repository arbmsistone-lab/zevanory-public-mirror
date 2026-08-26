import { spawn } from 'node:child_process';
const port=4293;
const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['src/server-v2.mjs'],{
  cwd:new URL('../',import.meta.url),
  env:{...process.env,PORT:String(port),WHATSAPP_NUMBER:'',OPERATOR_TOKEN:'resilience-token-not-used-123456'},
  stdio:'ignore',
});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function waitReady(){
  for(let i=0;i<50;i+=1){
    try{const r=await fetch(`${base}/api/config`);if(r.ok)return;}catch{}
    await sleep(80);
  }
  throw new Error('resilience_server_not_ready');
}
let result;
try{
  await waitReady();
  const concurrent=await Promise.all(Array.from({length:100},()=>fetch(`${base}/api/config`)));
  const configOk=concurrent.every(r=>r.status===200);
  const malformed=await fetch(`${base}/api/events/public`,{method:'POST',headers:{'content-type':'application/json'},body:'{bad'});
  const oversized=await fetch(`${base}/api/events/public`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x:'x'.repeat(20000)})});
  const unauthorized=await fetch(`${base}/api/events/operator`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'lead_qualified',session_id:'550e8400-e29b-41d4-a716-446655440000'})});
  result={config_100_ok:configOk,malformed_status:malformed.status,oversized_status:oversized.status,unauthorized_status:unauthorized.status};
  if(!configOk||malformed.status!==400||oversized.status!==413||unauthorized.status!==401) throw new Error(`resilience_failed:${JSON.stringify(result)}`);
} finally {
  child.kill();
}
console.log(JSON.stringify({ok:true,...result}));
