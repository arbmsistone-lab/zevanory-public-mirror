import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA=/^[0-9a-f]{40}$/i;
const REF=/^[A-Za-z0-9._/-]{1,120}$/;
const TEMP_CONFIG='wrangler.release.runtime.jsonc';

export function validateCloudflareReleaseMetadata({sha,ref,status,githubSha,gitlabSha}){
  const cleanSha=String(sha||'').trim().toLowerCase();
  const cleanRef=String(ref||'').trim();
  const gh=String(githubSha||'').trim().toLowerCase();
  const gl=String(gitlabSha||'').trim().toLowerCase();
  if(!SHA.test(cleanSha)) throw new Error('deploy_release_sha_invalid');
  if(!REF.test(cleanRef)||cleanRef!=='main') throw new Error('deploy_requires_main_branch');
  if(String(status||'').trim()) throw new Error('deploy_requires_clean_worktree');
  if(!SHA.test(gh)||!SHA.test(gl)) throw new Error('deploy_remote_main_sha_invalid');
  if(cleanSha!==gh||cleanSha!==gl) throw new Error('deploy_requires_github_gitlab_head_parity');
  return Object.freeze({sha:cleanSha,ref:cleanRef});
}

export function buildWranglerArgs(meta){
  return ['wrangler','deploy','--config',TEMP_CONFIG,'--keep-vars','--strict',`--tag=${meta.sha}`,`--message=ZEVANORY-production-${meta.sha}`];
}
function run(command,args,{capture=false,shell=false}={}){
  const result=spawnSync(command,args,{encoding:'utf8',shell,stdio:capture?['ignore','pipe','pipe']:'inherit'});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(`command_failed:${command}:${result.status}:${String(result.stderr||'').trim()}`);
  return capture ? String(result.stdout||'').trim() : '';
}

export function buildRuntimeConfig(baseText,meta){
  const cfg=JSON.parse(baseText);
  cfg.vars={...(cfg.vars||{}),ZEVANORY_RELEASE_SHA:meta.sha,ZEVANORY_RELEASE_REF:meta.ref,ZEVANORY_DEPLOYMENT_ENV:'production'};
  return JSON.stringify(cfg,null,2);
}

export function verifyLiveRelease(body,meta){
  if(String(body?.deployment?.commit_sha||'').toLowerCase()!==meta.sha) throw new Error('live_release_sha_mismatch');
  if(String(body?.deployment?.branch||'')!==meta.ref) throw new Error('live_release_ref_mismatch');
  if(String(body?.sales_mode||'')!=='globally-blocked') throw new Error('sales_must_remain_blocked_during_closeout');
  return true;
}
export async function main(){
  run('git',['fetch','origin','main']); run('git',['fetch','gitlab','main']);
  const sha=run('git',['rev-parse','HEAD'],{capture:true});
  const ref=run('git',['branch','--show-current'],{capture:true});
  const status=run('git',['status','--porcelain'],{capture:true});
  const githubSha=run('git',['rev-parse','origin/main'],{capture:true});
  const gitlabSha=run('git',['rev-parse','gitlab/main'],{capture:true});
  const meta=validateCloudflareReleaseMetadata({sha,ref,status,githubSha,gitlabSha});
  const base=readFileSync('wrangler.jsonc','utf8');
  writeFileSync(TEMP_CONFIG,buildRuntimeConfig(base,meta),'utf8');
  try{
    const args=buildWranglerArgs(meta);
    if(process.platform==='win32') run(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`npx ${args.join(' ')}`],{shell:false});
    else run('npx',args,{shell:false});
    const body=JSON.parse(run('curl',['-fsS','https://zevanory.api.br/api/release'],{capture:true}));
    verifyLiveRelease(body,meta);
    console.log(`CLOUDFLARE_PRODUCTION_COMPLETE sha=${meta.sha} ref=${meta.ref}`);
  } finally { rmSync(TEMP_CONFIG,{force:true}); }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await main();}catch(error){console.error(String(error?.message||error));process.exit(1);}
}
