import https from 'node:https';
const base=new URL(process.env.DAST_BASE_URL||'https://zevanory.api.br');
const findings=[];
const probes=[];
const marker='ZEVANORY_DAST_<script>alert(1)</script>';

async function probe(path,options={}){
  const url=new URL(path,base);
  const started=Date.now();
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(12_000),...options});
  const body=options.method==='HEAD'?'':await response.text();
  probes.push({path:url.pathname,status:response.status,ms:Date.now()-started});
  return {url,response,body};
}

const root=await probe('/');
if(root.response.status!==200)findings.push(`root_status:${root.response.status}`);
for(const name of ['content-security-policy','x-content-type-options','referrer-policy']){
  if(!root.response.headers.get(name))findings.push(`missing_header:${name}`);
}

const cors=await probe('/',{method:'OPTIONS',headers:{origin:'https://attacker.invalid','access-control-request-method':'POST'}});
const acao=cors.response.headers.get('access-control-allow-origin');
if(acao==='*'||acao==='https://attacker.invalid')findings.push(`permissive_cors:${acao}`);

const traceStatus=await new Promise((resolve,reject)=>{
  const req=https.request(base,{method:'TRACE',timeout:12_000},res=>{res.resume();resolve(res.statusCode||0);});
  req.on('timeout',()=>req.destroy(new Error('trace_timeout')));req.on('error',reject);req.end();
});
probes.push({path:'/',status:traceStatus,method:'TRACE'});
if(traceStatus>=200&&traceStatus<300)findings.push(`trace_enabled:${traceStatus}`);
const xss=await probe(`/?q=${encodeURIComponent(marker)}`);
if(xss.body.includes(marker))findings.push('reflected_xss_marker');
if(/<script>\s*alert\(1\)\s*<\/script>/i.test(xss.body))findings.push('reflected_script_payload');

const redirect=await probe('/?next=https%3A%2F%2Fattacker.invalid');
if(redirect.response.status>=300&&redirect.response.status<400){
  const location=redirect.response.headers.get('location');
  if(location&&new URL(location,base).origin!==base.origin)findings.push(`open_redirect:${location}`);
}

const traversal=await probe('/%2e%2e/%2e%2e/etc/passwd');
if(/root:x:0:0:/.test(traversal.body))findings.push('path_traversal_disclosure');

const invalidProvider=await probe('/api/webhooks?provider=invalid');
if(invalidProvider.response.status!==400)findings.push(`webhook_invalid_provider_status:${invalidProvider.response.status}`);
if(/token|secret|api[_-]?key/i.test(invalidProvider.body)&&!/webhook_provider_invalid/.test(invalidProvider.body))findings.push('webhook_error_secret_hint');

const status=await probe('/api/status');
if(status.response.status>=500)findings.push(`status_server_error:${status.response.status}`);

const result={status:findings.length?'FAIL':'PASS',base:base.origin,probes,findings};
console.log(JSON.stringify(result,null,2));
if(findings.length)process.exit(1);
