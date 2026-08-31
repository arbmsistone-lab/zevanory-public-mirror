import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SCOPE='arbmsistone-labs-projects';
const SHA=/^[0-9a-f]{40}$/i;
const REF=/^[A-Za-z0-9._/-]{1,120}$/;

export function validateReleaseMetadata({sha,ref,status}){
  const cleanSha=String(sha||'').trim().toLowerCase();
  const cleanRef=String(ref||'').trim();
  const dirty=String(status||'').trim();
  if(!SHA.test(cleanSha)) throw new Error('deploy_release_sha_invalid');
  if(!REF.test(cleanRef)) throw new Error('deploy_release_ref_invalid');
  if(cleanRef!=='main') throw new Error('deploy_requires_main_branch');
  if(dirty) throw new Error('deploy_requires_clean_worktree');
  return {sha:cleanSha,ref:cleanRef};
}

function run(command,args,{capture=false}={}){
  const result=spawnSync(command,args,{
    encoding:'utf8', shell:false,
    stdio:capture?['ignore','pipe','pipe']:'inherit',
  });
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(`command_failed:${command}:${result.status}`);
  return capture ? String(result.stdout||'').trim() : '';
}

export function main(){
  const sha=run('git',['rev-parse','HEAD'],{capture:true});  const ref=run('git',['branch','--show-current'],{capture:true});
  const status=run('git',['status','--porcelain'],{capture:true});
  const meta=validateReleaseMetadata({sha,ref,status});
  const npx=process.platform==='win32'?'npx.cmd':'npx';
  const common=['--no-sensitive','--force','--yes','--scope',SCOPE];
  run(npx,['vercel','env','add','ZEVANORY_RELEASE_SHA','production','--value',meta.sha,...common]);
  run(npx,['vercel','env','add','ZEVANORY_RELEASE_REF','production','--value',meta.ref,...common]);
  run(npx,['vercel','deploy','--prod','--yes','--scope',SCOPE]);
  console.log(`DEPLOY_PRODUCTION_COMPLETE sha=${meta.sha} ref=${meta.ref}`);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{main();}catch(error){console.error(String(error?.message||error));process.exit(1);}
}
