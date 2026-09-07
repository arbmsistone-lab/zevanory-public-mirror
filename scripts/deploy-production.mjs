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

export function verifyDeploymentInspection(body,expectedSha){
  if(String(body?.readyState||'').toUpperCase()!=='READY') throw new Error('deploy_not_ready');
  const meta=body?.meta||{};
  const actual=String(meta.gitCommitSha||meta.githubCommitSha||'').trim().toLowerCase();
  if(actual!==String(expectedSha||'').trim().toLowerCase()) throw new Error('deploy_inspection_sha_mismatch');
  return true;
}
export function verifyPromotedDeployment(body,expectedId){
  if(String(body?.id||'')!==String(expectedId||'')) throw new Error('deploy_promoted_id_mismatch');
  if(String(body?.readyState||'').toUpperCase()!=='READY') throw new Error('deploy_promoted_not_ready');
  return true;
}
export function extractDeploymentUrl(output){
  const matches=String(output||'').match(/https:\/\/[A-Za-z0-9.-]+\.vercel\.app/g)||[];
  const url=matches.at(-1)||'';
  if(!url) throw new Error('deploy_url_missing');
  return url;
}
export function vercelRunnerConfig(platform=process.platform){
  return {command:'npx',shell:platform==='win32'};
}

export function buildDeployArgs(meta){
  return ['vercel','deploy','--prod','--yes','--scope',SCOPE,'--skip-domain','--archive=tgz','--no-wait',
    '--env',`ZEVANORY_RELEASE_SHA=${meta.sha}`,
    '--env',`ZEVANORY_RELEASE_REF=${meta.ref}`];
}
export function buildInspectArgs(target){
  return ['vercel','inspect',target,'--scope',SCOPE,'--wait','--timeout','3m','--json'];
}
export function buildApiArgs(deploymentId){
  return ['vercel','api',`/v13/deployments/${deploymentId}`,'--scope',SCOPE];
}
export function buildPromoteArgs(target){
  return ['vercel','promote',target,'--scope',SCOPE,'--yes'];
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
  const deployOutput=run(runner.command,buildDeployArgs(meta),{capture:true,shell:runner.shell});
  const deploymentUrl=extractDeploymentUrl(deployOutput);
  const inspected=JSON.parse(run(runner.command,buildInspectArgs(deploymentUrl),{capture:true,shell:runner.shell}));
  const deployment=JSON.parse(run(runner.command,buildApiArgs(inspected.id),{capture:true,shell:runner.shell}));
  verifyDeploymentInspection(deployment,meta.sha);
  run('git',['fetch','origin','main']);
  const latestRemote=run('git',['rev-parse','origin/main'],{capture:true});
  if(latestRemote!==meta.sha) throw new Error('deploy_origin_main_advanced_during_deploy');
  run(runner.command,buildPromoteArgs(deploymentUrl),{shell:runner.shell});
  const promoted=JSON.parse(run(runner.command,buildInspectArgs('zevanory.api.br'),{capture:true,shell:runner.shell}));
  verifyPromotedDeployment(promoted,inspected.id);
  console.log(`DEPLOY_PRODUCTION_COMPLETE sha=${meta.sha} ref=${meta.ref} deployment=${inspected.id}`);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await main();}catch(error){console.error(String(error?.message||error));process.exit(1);}
}
