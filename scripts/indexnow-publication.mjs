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
   out.set(url,{url,id:sha(url),revision:sha(current),file});
  }
 }
 return [...out.values()].sort((a,b)=>a.url.localeCompare(b.url));
}
export function validateUrls(urls){
 if(!Array.isArray(urls)||urls.length<1||urls.length>10)throw Error("url_limit");
 return urls.map(canonical);
}
export function submissionMatchesPlan({day,plannedAttempt,runAttempt,now=Date.now()}){
 return day===new Date(now).toISOString().slice(0,10)&&Number.isSafeInteger(plannedAttempt)&&plannedAttempt>0&&plannedAttempt===runAttempt;
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
const PENDING_MARKER='INDEXNOW_PENDING_V1=';
const validItem=p=>p&&typeof p.url==='string'&&p.id===sha(canonical(p.url))&&/^[a-f0-9]{64}$/.test(p.revision)&&typeof p.file==='string'&&/^[A-Za-z0-9_./-]+\.(html|md)$/.test(p.file)&&!p.file.includes('..');
export async function readAttemptJournal({repo,runId,attempt,token,now=Date.now()},fetchImpl=fetch,warn=console.warn){
 try{
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)||!Number.isSafeInteger(runId)||!Number.isSafeInteger(attempt)||!token)throw Error('journal_config');
  const request=async path=>{const r=await fetchImpl('https://api.github.com/repos/'+repo+path,{headers:{accept:'application/vnd.github+json',authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});if(r.status!==200)throw Error('journal_http');return r;};
  const rows=[];let pending=null,backlogAt=-Infinity;
  const since=now-48*3600000;
  for(let page=1;page<=10;page++){
   const result=await (await request('/actions/workflows/indexnow-submit.yml/runs?per_page=100&page='+page)).json();
   if(!Array.isArray(result.workflow_runs))throw Error('journal_shape');
   for(const run of result.workflow_runs){
    if(!Number.isSafeInteger(run.id)||!Number.isFinite(Date.parse(run.created_at)))throw Error('journal_shape');
    if(run.id===runId&&attempt===1)continue;
    const attempts=run.id===runId?Array.from({length:attempt-1},(_,i)=>'/attempts/'+(i+1)+'/jobs?'):['/jobs?filter=all&'];
    for(const endpoint of attempts){
     for(let jp=1;jp<=10;jp++){
      const items=await (await request('/actions/runs/'+run.id+endpoint+'per_page=100&page='+jp)).json();
      if(!Array.isArray(items.jobs))throw Error('journal_shape');
      for(const job of items.jobs){
       if(typeof job.name!=='string')throw Error('journal_shape');
       if(job.status==='queued'||job.started_at===null)continue;
       if(!['completed','in_progress','waiting'].includes(job.status)||!Number.isFinite(Date.parse(job.started_at)))throw Error('journal_shape');
       const m=/^indexnow-([a-f0-9]{64})-([a-f0-9]{64})-(\d{4}-\d{2}-\d{2})$/.exec(job.name);
       if(m)rows.push({id:m[1],revision:m[2],day:m[3]});
       if(job.name==='submit'){
        const planner=Array.isArray(job.steps)&&job.steps.some(s=>s.name==='Plan changed publications');
        if(!planner){rows.push({legacy:true,day:run.created_at.slice(0,10)});continue;}
        const started=Date.parse(job.started_at);
        if(job.status==='completed'&&started>backlogAt){
         if(!Number.isSafeInteger(job.id))throw Error('journal_shape');
         const logs=await (await request('/actions/jobs/'+job.id+'/logs')).text();
         const lines=logs.split('\n').filter(line=>line.includes(PENDING_MARKER));
         if(lines.length){
          const raw=lines.at(-1).slice(lines.at(-1).indexOf(PENDING_MARKER)+PENDING_MARKER.length).trim();
          const value=JSON.parse(raw);if(!Array.isArray(value)||value.length>5000||!value.every(validItem))throw Error('pending_shape');
          pending=value;backlogAt=started;
         }
        }
       }
      }
      if(items.jobs.length<100)break;if(jp===10)throw Error('journal_limit');
     }
    }
    // Keep recent attempts, plus the last durable backlog and that run's attempts.
    if(Date.parse(run.created_at)<since&&(pending!==null||rows.some(x=>x.legacy)))return {rows,pending:pending||[]};
   }
   if(result.workflow_runs.length<100)return {rows,pending:pending||[]};
  }
  throw Error('journal_limit');
 }catch{warn('::warning title=INDEXNOW::journal_unreadable');throw Error('journal_unreadable');}
}
export async function priorAttempt(context,fetchImpl=fetch){
 const journal=await readAttemptJournal(context,fetchImpl),id=sha(canonical(context.url));
 return journal.rows.some(row=>(row.legacy&&row.day===context.day)||(row.id===id&&(row.day===context.day||row.revision===context.revision)));
}
export function selectDailyPublications(fresh,journal,day,warn=console.warn){
 const byUrl=new Map();
 for(const p of [...journal.pending,...fresh]){if(!validItem(p))throw Error('pending_shape');byUrl.set(p.url,p);}
 const pending=[...byUrl.values()].filter(p=>!journal.rows.some(r=>r.id===p.id&&r.revision===p.revision)).sort((a,b)=>a.url.localeCompare(b.url));
 const used=journal.rows.some(r=>r.legacy&&r.day===day)?50:new Set(journal.rows.filter(r=>r.day===day&&r.id).map(r=>r.id)).size;
 const eligible=pending.filter(p=>!journal.rows.some(r=>r.id===p.id&&r.day===day));
 const selected=eligible.slice(0,Math.max(0,50-used));
 if(eligible.length>selected.length)warn('::warning title=INDEXNOW::daily_limit_deferred '+(eligible.length-selected.length));
 return {selected,pending};
}
async function main(){
 const mode=process.argv[2];
 if(mode==='plan'){
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const after=git('rev-parse','HEAD').trim(),now=Date.now(),day=new Date(now).toISOString().slice(0,10);
  let before=after;
  const readBlob=(ref,path)=>{const found=git('ls-tree','--name-only',ref,'--',path).trim();if(found!==path)return null;return git('show',ref+':'+path);};
  let fresh=[];
  if(now-Number(git('show','-s','--format=%ct',after).trim())*1000<=48*3600000){
   if(process.env.GITHUB_EVENT_NAME==='push')before=event.before;
   else {const commits=git('rev-list','--since=48 hours ago','--first-parent','HEAD').trim().split('\n').filter(Boolean);before=commits.length?git('rev-parse',commits.at(-1)+'^').trim():after;}
   if(!/^[a-f0-9]{40}$/.test(before)||/^0+$/.test(before))throw Error('baseline_unavailable');
   fresh=changedPublications({before,after,changed:git('diff','--name-only',before,after).trim().split('\n'),readBlob});
  }
  const journal=await readAttemptJournal({repo:process.env.GITHUB_REPOSITORY,runId:Number(process.env.GITHUB_RUN_ID),attempt:Number(process.env.GITHUB_RUN_ATTEMPT),token:process.env.GITHUB_TOKEN,now});
  // Resolve old backlog against current files; removed files are never announced.
  journal.pending=journal.pending.flatMap(p=>{const body=readBlob(after,p.file);return body===null?[]:[{...p,revision:sha(body)}];});
  const {selected,pending}=selectDailyPublications(fresh,journal,day);
  if(pending.length>5000)throw Error('pending_limit');
  // Public URL/revision backlog, never authentication. The next planner reads this
  // durable log before selecting work, so >50 URLs survive the 48h fresh window.
  console.log(PENDING_MARKER+JSON.stringify(pending));
  appendFileSync(process.env.GITHUB_OUTPUT,'matrix='+JSON.stringify({include:selected})+'\nhas_work='+(selected.length>0)+'\nday='+day+'\nattempt='+process.env.GITHUB_RUN_ATTEMPT+'\n');
 }else if(mode==='submit'){
  if(!submissionMatchesPlan({day:process.env.PUBLICATION_DAY,plannedAttempt:Number(process.env.PUBLICATION_PLANNED_ATTEMPT),runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT)})){console.warn('::warning title=INDEXNOW::replay_or_day_changed_no_submission');return;}
  await submitPublication({url:process.env.PUBLICATION_URL,key:process.env.KEY});console.log('INDEXNOW_ACCEPTED one publication');
 }else throw Error('unknown_mode');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await main();}catch{process.exitCode=1;console.warn('::warning title=INDEXNOW::submission_blocked');}}
