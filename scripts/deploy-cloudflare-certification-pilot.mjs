import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateCloudflareReleaseMetadata } from './deploy-cloudflare-production.mjs';

const TEMP_CONFIG='wrangler.pilot.runtime.jsonc';
function run(command,args,{capture=false}={}){
  const r=spawnSync(command,args,{encoding:'utf8',shell:false,stdio:capture?['ignore','pipe','pipe']:'inherit'});
  if(r.error) throw r.error;
  if(r.status!==0) throw new Error(`command_failed:${command}:${r.status}:${String(r.stderr||'').trim()}`);
  return capture?String(r.stdout||'').trim():'';
}
export function buildPilotRuntimeConfig(baseText,meta){
  const cfg=JSON.parse(baseText); const vars={...(cfg.vars||{})}; delete vars.AFFILIATE_TERMS_VERSION;
  vars.CERTIFICATION_PILOT_ENABLED='true'; vars.CHECKOUT_ENABLED='true'; vars.FINANCIAL_EVENTS_ENABLED='true';
  vars.SALE_GLOBALLY_ENABLED='false'; vars.PRE_SALE_GATES_APPROVED='false'; vars.WHATSAPP_SALES_ENABLED='false';
  vars.ZEVANORY_RELEASE_SHA=meta.sha; vars.ZEVANORY_RELEASE_REF=meta.ref; vars.ZEVANORY_DEPLOYMENT_ENV='production';
  cfg.vars=vars; return JSON.stringify(cfg,null,2);
}
export function verifyPilotState({release,health,provider},meta){
  if(release?.deployment?.commit_sha!==meta.sha||release?.deployment?.branch!==meta.ref) throw new Error('pilot_release_provenance_mismatch');
  if(release?.sales_mode!=='globally-blocked') throw new Error('pilot_sales_must_remain_blocked');
  if(health?.ready!==true) throw new Error('pilot_health_not_ready');
  if(provider?.authenticated!==true||provider?.pre_sale_ready!==true) throw new Error('pilot_provider_not_ready');
  return true;
}
export async function main(){
  run('git',['fetch','origin','main']); run('git',['fetch','gitlab','main']);
  const meta=validateCloudflareReleaseMetadata({
    sha:run('git',['rev-parse','HEAD'],{capture:true}),
    ref:run('git',['branch','--show-current'],{capture:true}),
    status:run('git',['status','--porcelain'],{capture:true}),
    githubSha:run('git',['rev-parse','origin/main'],{capture:true}),
    gitlabSha:run('git',['rev-parse','gitlab/main'],{capture:true}),
  });
  writeFileSync(TEMP_CONFIG,buildPilotRuntimeConfig(readFileSync('wrangler.jsonc','utf8'),meta),'utf8');
  try{
    const args=['wrangler','deploy','--config',TEMP_CONFIG,'--keep-vars','--strict',`--tag=${meta.sha}`,`--message=ZEVANORY-certification-pilot-${meta.sha}`];
    if(process.platform==='win32') run(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`npx ${args.join(' ')}`]); else run('npx',args);
    const read=(path)=>JSON.parse(run('curl',['-fsS',`https://zevanory.api.br${path}`],{capture:true}));
    verifyPilotState({release:read('/api/release'),health:read('/api/health'),provider:read('/api/provider-health')},meta);
    console.log(`CLOUDFLARE_PILOT_COMPLETE sha=${meta.sha} ref=${meta.ref}`);
  } finally { rmSync(TEMP_CONFIG,{force:true}); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await main();}catch(error){console.error(String(error?.message||error));process.exit(1);}
}
