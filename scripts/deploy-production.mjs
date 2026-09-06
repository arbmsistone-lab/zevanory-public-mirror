import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SCOPE='arbmsistone-labs-projects';
const SHA=/^[0-9a-f]{40}$/i;
const REF=/^[A-Za-z0-9._/-]{1,120}$/;

export function validateReleaseMetadata({sha,ref,status,remoteSha}){
  const cleanSha=String(sha||'').trim().toLowerCase();
  const cleanRef=String(ref||'').trim();
  const cleanRemote=String(remoteSha||'').trim().toLowerCase();
  const dirty=String(status||'').trim();
  if(!SHA.test(cleanSha)) throw new Error('deploy_release_sha_invalid');
  if(!REF.test(cleanRef)) throw new Error('deploy_release_ref_invalid');
  if(cleanRef!=='main') throw new Error('deploy_requires_main_branch');
  if(dirty) throw new Error('deploy_requires_clean_worktree');
  if(!SHA.test(cleanRemote)) throw new Error('deploy_remote_main_sha_invalid');
  if(cleanSha!==cleanRemote) throw new Error('deploy_head_not_origin_main');
  return {sha:cleanSha,ref:cleanRef};
}

export function verifyProductionRelease(body,expectedSha){
  const actual=String(body?.deployment?.commit_sha||'').trim().toLowerCase();
  if(actual!==String(expectedSha||'').trim().toLowerCase()) throw new Error('deploy_public_sha_mismatch');
  return true;
}

export function vercelRunnerConfig(platform=process.platform){
  return {command:'npx',shell:platform==='win32'};
}
function run(command,args,{capture=false,shell=false}={}){
  const result=spawnSync(command,args,{encoding:'utf8',shell,stdio:capture?['ignore','pipe','pipe']:'inherit'});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(`command_failed:${command}:${result.status}`);
  return capture ? String(result.stdout||'').trim() : '';
}

export async function main(){
  run('git',['fetch','origin','main']);
  const sha=run('git',['rev-parse','HEAD'],{capture:true});
  const ref=run('git',['branch','--show-current'],{capture:true});
  const status=run('git',['status','--porcelain'],{capture:true});
  const remoteSha=run('git',['rev-parse','origin/main'],{capture:true});
  const meta=validateReleaseMetadata({sha,ref,status,remoteSha});
  const runner=vercelRunnerConfig();
  const common=['--no-sensitive','--force','--yes','--scope',SCOPE];
  run(runner.command,['vercel','env','add','ZEVANORY_RELEASE_SHA','production','--value',meta.sha,...common],{shell:runner.shell});
  run(runner.command,['vercel','env','add','ZEVANORY_RELEASE_REF','production','--value',meta.ref,...common],{shell:runner.shell});
  run(runner.command,['vercel','deploy','--prod','--yes','--scope',SCOPE],{shell:runner.shell});
  const response=await fetch('https://zevanory.api.br/api/release',{cache:'no-store'});
  if(!response.ok) throw new Error(`deploy_public_release_unavailable:${response.status}`);
  verifyProductionRelease(await response.json(),meta.sha);
  console.log(`DEPLOY_PRODUCTION_COMPLETE sha=${meta.sha} ref=${meta.ref}`);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await main();}catch(error){console.error(String(error?.message||error));process.exit(1);}
}
