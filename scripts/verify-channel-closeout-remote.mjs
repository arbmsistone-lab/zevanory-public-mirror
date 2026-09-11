import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ZEVANORY_PRODUCTS } from '../src/offerCatalog.mjs';

if(process.platform==='win32'||!(process.env.VERCEL||process.env.CI))throw new Error('remote_execution_required');
mkdirSync('.verification',{recursive:true});
mkdirSync('.audit-artifacts',{recursive:true});
for(const product of ZEVANORY_PRODUCTS)copyFileSync(`products/releases/v1.1/${product.artifact_name}`,`.audit-artifacts/${product.artifact_name}`);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_ALL|NODE_OPTIONS|VERCEL|CI|npm_|NPM_)/.test(key)));
Object.assign(env,{SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false',CHECKOUT_ENABLED:'false',FINANCIAL_EVENTS_ENABLED:'false',WHATSAPP_SALES_ENABLED:'false'});
const evidence={schema:'zevanory-channel-closeout-remote-v1',source_sha:process.env.VERCEL_GIT_COMMIT_SHA||null,started_at:new Date().toISOString(),remote_only:true,commercial_execution:false,checks:[]};
function run(name,command,args){
  const r=spawnSync(command,args,{env,encoding:'utf8',timeout:420000,maxBuffer:16*1024*1024});
  const output=String(r.stdout||'')+String(r.stderr||'');
  writeFileSync(`.verification/${name}.log`,output);
  const check={name,exit:r.status,status:r.status===0?'PASS':'FAIL',timed_out:r.error?.code==='ETIMEDOUT'};
  evidence.checks.push(check);
  console.log('ZEVANORY_REMOTE_CHECK '+JSON.stringify(check));
  if(r.status!==0)console.log(output.slice(-16000));
}
run('complete-tests','npm',['test']);
for(const [name,script] of [
  ['product-20x','audit-zevanory-products-20x.mjs'],
  ['distribution-20x','audit-store-distribution-20x.mjs'],
  ['social-20x','audit-social-channel-closeout-20x.mjs'],
  ['provider-confirmation-20x','audit-provider-confirmation-20x.mjs'],
  ['security-10x','audit-security-10x.mjs'],
  ['supply-chain','secret-scan.mjs'],
  ['distribution-contract-10x','audit-commercial-distribution-10x.mjs'],
  ['execution-fabric-3x','audit-universal-execution-fabric-3x.mjs'],
])run(name,process.execPath,[`scripts/${script}`]);
for(let i=1;i<=3;i++)run(`global-structural-${i}`,process.execPath,['scripts/audit-3x.mjs']);
evidence.finished_at=new Date().toISOString();
evidence.pass=evidence.checks.every(x=>x.status==='PASS');
writeFileSync('.verification/result.json',JSON.stringify(evidence,null,2));
console.log('ZEVANORY_REMOTE_RESULT '+JSON.stringify(evidence));
if(!evidence.pass)process.exit(1);
