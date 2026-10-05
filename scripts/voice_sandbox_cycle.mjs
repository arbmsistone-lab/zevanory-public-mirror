// Runs once after the tagged deployment; dispatches existing manual workflows.
import {mkdirSync,writeFileSync} from 'node:fs';
const repo=process.env.GITHUB_REPOSITORY,sha=process.env.CYCLE_SHA,root=`https://api.github.com/repos/${repo}`;
const headers={authorization:`Bearer ${process.env.GH_TOKEN}`,accept:'application/vnd.github+json','content-type':'application/json','x-github-api-version':'2022-11-28'};
const dir='/tmp/voice-sandbox-cycle';mkdirSync(dir,{recursive:true});
const checkpoint={sha,cycle:process.env.GITHUB_RUN_ID,workflows:{},sale_globally_enabled:false};
const save=()=>writeFileSync(dir+'/checkpoint.json',JSON.stringify(checkpoint,null,2));
async function api(path,method='GET',body){const r=await fetch(root+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(`github_${r.status}:${path}`);return r.status===204?null:r.json();}
async function dispatch(file,inputs={}){
 const cycle=sha+'-'+process.env.GITHUB_RUN_ID;
 // Ref may not move while this cycle is running.
 const ref=await api('/git/ref/heads/gh-pages');if(ref.object.sha!==sha)throw Error('canonical_ref_moved');
 const started=new Date().toISOString();
 await api('/actions/workflows/'+file+'/dispatches','POST',{ref:'gh-pages',inputs:{cycle,...inputs}});
 checkpoint.workflows[file]={dispatched_at:started};save();
 for(let n=0;n<30;n++){
  const runs=await api('/actions/workflows/'+file+'/runs?event=workflow_dispatch&per_page=30');
  const found=runs.workflow_runs.find(x=>x.head_sha===sha&&x.created_at>=started.slice(0,19)+'Z'&&x.display_title.includes(cycle));
  if(found){checkpoint.workflows[file]={...checkpoint.workflows[file],id:found.id,url:found.html_url};save();return found.id;}
  await new Promise(r=>setTimeout(r,10000));
 }
 throw Error(file+':dispatch_run_not_found_no_retry');
}
async function wait(file,id){
 for(let n=0;n<60;n++){
  const run=await api('/actions/runs/'+id);
  if(run.status==='completed'){checkpoint.workflows[file].conclusion=run.conclusion;save();if(run.conclusion!=='success')throw Error(`${file}:${run.conclusion}:${run.html_url}`);return;}
  await new Promise(r=>setTimeout(r,20000));
 }
 throw Error(file+':timeout');
}
try{
 const warm='voice-cache-warm.yml',audit='whatsapp-operational-audit.yml',purchase='mercadopago-combo-sandbox.yml';
 let warmError=null;
 const id=await dispatch(warm,{max_voices:'7'});
 try{await wait(warm,id);}catch(error){warmError=error;console.log('::warning title=WARM_FAILED::'+error.message+'; independent proofs continue');}
 // One dispatch for each proof, never auto-rerun a purchase or warm call.
 const aid=await dispatch(audit),pid=await dispatch(purchase,{expected_sha:sha});
 const outcomes=await Promise.allSettled([wait(audit,aid),wait(purchase,pid)]);
 for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason;
 if(warmError)throw warmError;
 checkpoint.complete=true;save();console.log(JSON.stringify(checkpoint));
}catch(error){checkpoint.error=error.message;save();console.error('::error title=VOICE_SANDBOX_CYCLE::'+error.message);process.exitCode=1;}
