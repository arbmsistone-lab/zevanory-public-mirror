// IndexNow only for changed, repository-backed canonical pages. No sitemap fan-out.
import {execFileSync} from 'node:child_process';
import {readFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const sha=x=>createHash('sha256').update(x).digest('hex');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:8*1024*1024});
const hosts=['zevanory.api.br','vendas.zevanory.api.br'];
export function canonical(input){const u=new URL(input);if(u.protocol!=='https:'||!hosts.includes(u.hostname)||u.port||u.username||u.password||u.search||u.hash)throw Error('invalid_url');return u.href;}
export function changedPublications({before,after,changed,readBlob}){
 const out=new Map();
 for(const [host,sitemap] of [[hosts[0],'sitemap.xml'],[hosts[1],'sales-public/sitemap.xml']]){
  const xml=readBlob(after,sitemap)||'';
  for(const match of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)){
   let url;try{url=canonical(match[1].trim());}catch{continue;}
   const u=new URL(url);if(u.hostname!==host)continue;
   const path=decodeURIComponent(u.pathname),prefix=host===hosts[1]?'sales-public/':'';
   if(path.includes('..')||path.includes('\\'))continue;
   const bare=prefix+path.replace(/^\//,'');
   const candidates=path.endsWith('/')?[bare+'index.html',bare+'index.md']:[bare,bare+'.html',bare+'/index.html',bare+'.md'];
   const file=candidates.find(p=>/\.(?:html|md)$/.test(p)&&changed.includes(p)&&readBlob(after,p)!==null);
   if(!file)continue;
   const current=readBlob(after,file),old=readBlob(before,file);
   if(current===old)continue;
   out.set(url,{url,id:sha(url),revision:sha(current)});
  }
 }
 return [...out.values()].sort((a,b)=>a.url.localeCompare(b.url));
}
export function validateUrls(urls){
 if(!Array.isArray(urls)||urls.length<1||urls.length>10)throw Error("url_limit");
 return urls.map(canonical);
}
export async function submitPublication({url,key,urls=[url]},fetchImpl=fetch){
 validateUrls(urls);
 // One publication = one URL, even though IndexNow permits more.
 if(urls.length!==1||urls[0]!==url)throw Error('one_publication_only');
 url=canonical(url);if(!/^[a-f0-9]{64}$/.test(key))throw Error('invalid_public_key');
 const response=await fetchImpl('https://api.indexnow.org/indexnow',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({host:new URL(url).hostname,key,keyLocation:'https://'+new URL(url).hostname+'/'+key+'.txt',urlList:[url]}),signal:AbortSignal.timeout(15000)});
 if(![200,202].includes(response.status))throw Error('indexnow_not_accepted');
 return {accepted:true};
}
// GitHub job history is the attempt journal, including failed/cancelled jobs.
// URL concurrency serializes jobs across runs; even an unknown result is never resent.
export async function priorAttempt({repo,runId,attempt,url,revision,day,now=Date.now()},fetchImpl=fetch){
 const id=sha(canonical(url));
 const get=async path=>{const r=await fetchImpl('https://api.github.com/repos/'+repo+path,{headers:{accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});if(r.status!==200)throw Error('journal_unreadable');return r.json();};
 const since=new Date(now-48*3600000).toISOString();
 for(let page=1;page<=10;page++){
  const result=await get('/actions/workflows/indexnow-submit.yml/runs?per_page=100&page='+page+'&created='+encodeURIComponent('>='+since));
  if(!Array.isArray(result.workflow_runs))throw Error('journal_shape');
  for(const run of result.workflow_runs){
   if(!Number.isSafeInteger(run.id)||!Number.isFinite(Date.parse(run.created_at)))throw Error('journal_shape');
   if(run.id===runId&&attempt===1)continue;
   for(let jp=1;jp<=10;jp++){
    const endpoint=run.id===runId?'/attempts/'+(attempt-1)+'/jobs?':'/jobs?filter=all&';
    const items=await get('/actions/runs/'+run.id+endpoint+'per_page=100&page='+jp);
    if(!Array.isArray(items.jobs))throw Error('journal_shape');
    for(const job of items.jobs){
     if(typeof job.name!=='string')throw Error('journal_shape');
     if(job.status==='queued'||job.started_at===null)continue;
     if(!['completed','in_progress','waiting'].includes(job.status)||!Number.isFinite(Date.parse(job.started_at)))throw Error('journal_shape');
     const sameDay=job.name.endsWith('-'+day);
     const legacySameDay=run.created_at.slice(0,10)===day;
     if(job.name==='submit'&&legacySameDay)return true; // conservative migration from the legacy batch sender
     if(job.name.startsWith('indexnow-'+id+'-')&&(sameDay||job.name.startsWith('indexnow-'+id+'-'+revision+'-')))return true;
    }
    if(items.jobs.length<100)break;if(jp===10)throw Error('journal_limit');
   }
  }
  if(result.workflow_runs.length<100)return false;
 }
 throw Error('journal_limit');
}
function main(){
 const mode=process.argv[2];
 if(mode==='plan'){
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const after=git('rev-parse','HEAD').trim();let before;
  if(Date.now()-Number(git('show','-s','--format=%ct',after).trim())*1000>48*3600000){appendFileSync(process.env.GITHUB_OUTPUT,'matrix={"include":[]}\nhas_work=false\nday='+new Date().toISOString().slice(0,10)+'\n');return;}
  if(process.env.GITHUB_EVENT_NAME==='push')before=event.before;
  else {const commits=git('rev-list','--since=48 hours ago','--first-parent','HEAD').trim().split('\n').filter(Boolean);before=commits.length?git('rev-parse',commits.at(-1)+'^').trim():after;}
  if(!/^[a-f0-9]{40}$/.test(before)||/^0+$/.test(before))throw Error('baseline_unavailable');
  const changed=git('diff','--name-only',before,after).trim().split('\n');
  const readBlob=(ref,path)=>{const found=git('ls-tree','--name-only',ref,'--',path).trim();if(found!==path)return null;return git('show',ref+':'+path);};
  const matrix=changedPublications({before,after,changed,readBlob});
  if(matrix.length>200)throw Error('publication_plan_too_large');
  appendFileSync(process.env.GITHUB_OUTPUT,'matrix='+JSON.stringify({include:matrix})+'\nhas_work='+(matrix.length>0)+'\nday='+new Date().toISOString().slice(0,10)+'\n');
 }else if(mode==='prepare'){
  return priorAttempt({repo:process.env.GITHUB_REPOSITORY,runId:Number(process.env.GITHUB_RUN_ID),attempt:Number(process.env.GITHUB_RUN_ATTEMPT),url:process.env.PUBLICATION_URL,revision:process.env.PUBLICATION_REVISION,day:process.env.PUBLICATION_DAY}).then(seen=>appendFileSync(process.env.GITHUB_OUTPUT,'ready='+!seen+'\n'));
 }else if(mode==='submit')return submitPublication({url:process.env.PUBLICATION_URL,key:process.env.KEY}).then(()=>console.log('INDEXNOW_ACCEPTED one publication'));
 else throw Error('unknown_mode');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
