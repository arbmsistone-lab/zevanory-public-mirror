import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as mod from '../scripts/indexnow-publication.mjs';
import {readTextNormalized} from './helpers/text.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const source=new URL('../scripts/indexnow-publication.mjs',import.meta.url),day='2026-11-11',token='synthetic-github-read-token',context={repo:'arbmsistone-lab/zevanory-public-mirror',runId:20,runNumber:3,continuity:{schema:1,authorized:true,anchorRunId:9,anchorRunNumber:1,rows:[],pending:[]},attempt:1,token,now:Date.parse(day+'T15:00:00Z')};
const sha=x=>createHash('sha256').update(x).digest('hex');
const publication=i=>({url:'https://zevanory.api.br/p'+i,id:sha('https://zevanory.api.br/p'+i),revision:'a'.repeat(64),file:'p'+i+'.html'});
function api({pending=[],rows=[],bad=false}={}){const headers=[];const fetchImpl=async(url,req)=>{headers.push(req.headers.authorization);if(bad)throw Error('failure '+token);if(url.endsWith('/logs'))return {status:200,text:async()=>'timestamp INDEXNOW_PENDING_V1='+JSON.stringify(pending)};if(url.includes('/jobs?'))return {status:200,json:async()=>({jobs:[{id:1,name:'submit',status:'completed',started_at:'2026-11-10T12:00:00Z',steps:[{name:'Plan changed publications'}]},...rows]})};return {status:200,json:async()=>({workflow_runs:[{id:10,run_number:2,created_at:'2026-11-10T12:00:00Z'},{id:9,run_number:1,created_at:'2026-11-09T12:00:00Z'}]})};};return {fetchImpl,headers};}
async function auth(m){const fake=api(),out=await m.readAttemptJournal(context,fake.fetchImpl);assert.deepEqual(out.pending,[]);assert.ok(fake.headers.length>=3);assert.ok(fake.headers.every(h=>h==='Bearer '+token));}
function cap(m){const fresh=Array.from({length:125},(_,i)=>publication(i)),warnings=[];
 const first=m.selectDailyPublications(fresh,{rows:[],pending:[]},day,x=>warnings.push(x));assert.equal(first.selected.length,50);assert.equal(first.pending.length,125);assert.ok(warnings.some(x=>x.includes('daily_limit_deferred')));
 const rows=first.selected.map(p=>({id:p.id,revision:p.revision,day}));
 const second=m.selectDailyPublications([],{rows,pending:first.pending},'2026-11-12',()=>{});assert.equal(second.selected.length,50);assert.equal(second.pending.length,75);assert.ok(second.selected.every(p=>!first.selected.some(a=>a.url===p.url)));
 const third=m.selectDailyPublications([],{rows:[...rows,...second.selected.map(p=>({id:p.id,revision:p.revision,day:'2026-11-12'}))],pending:second.pending},'2026-11-13',()=>{});assert.equal(third.selected.length,25);
 const sameDay=m.selectDailyPublications([publication(500)],{rows,pending:first.pending},day,()=>{});assert.equal(sameDay.selected.length,0);assert.ok(sameDay.pending.some(p=>p.url===publication(500).url));
}
test('CL1026-01: every journal request has bearer authorization',()=>auth(mod));
test('CL1026-01: failure emits fixed warning without token and never authorizes submission',async()=>{const fake=api({bad:true}),messages=[];await assert.rejects(()=>mod.readAttemptJournal(context,fake.fetchImpl,x=>messages.push(x)),/journal_unreadable/);assert.deepEqual(messages,['::warning title=INDEXNOW::journal_unreadable']);assert.equal(messages.some(x=>x.includes(token)),false);});
test('CL1026-01: no token means fail closed before any network call',async()=>{let calls=0;await assert.rejects(()=>mod.readAttemptJournal({...context,token:''},async()=>{calls++;},()=>{}));assert.equal(calls,0);});
test('CL1026: at most 50 URLs/day; excess survives subsequent days',()=>cap(mod));
test('CL1026: durable backlog is restored from authenticated planner logs after the fresh window',async()=>{const fake=api({pending:[publication(90)]});const restored=await mod.readAttemptJournal({...context,now:context.now+7*86400000},fake.fetchImpl);assert.deepEqual(restored.pending,[publication(90)]);const selected=mod.selectDailyPublications([],restored,'2026-11-18',()=>{});assert.equal(selected.selected.length,1);});
test('CL1026: invalid backlog blocks instead of becoming empty',async()=>{const fake=api({pending:[{url:'https://evil.example'}]});await assert.rejects(()=>mod.readAttemptJournal(context,fake.fetchImpl,()=>{}),/journal_unreadable/);});
test('CL1026: actions:read only in submit; no other secret or permission expansion',()=>{const text=readTextNormalized(new URL('../.github/workflows/indexnow-submit.yml',import.meta.url));assert.match(text,/submit:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      actions: read/);assert.match(text,/GITHUB_TOKEN: \$\{\{ github.token \}\}/);assert.equal((text.match(/actions: read/g)||[]).length,1);assert.equal(text.includes('secrets.'),false);assert.equal(text.slice(text.indexOf('  notify:')).includes('permissions:'),false);});
test('CL1026 mutant: authorization removed',async()=>{await auth(mod);await killedMutation(source,[[",authorization:'Bearer '+token",'']],auth);});
test('CL1026 mutant: daily cap raised to 200',async()=>{cap(mod);await killedMutation(source,[["Math.max(0,50-used)","Math.max(0,200-used)"]],async m=>cap(m));});
test('CL1026 mutant: deferred URLs discarded',async()=>{cap(mod);await killedMutation(source,[["return {selected,pending};","return {selected,pending:selected};"]],async m=>cap(m));});
function replay(m){assert.equal(m.submissionMatchesPlan({day,plannedAttempt:1,runAttempt:1,now:context.now}),true);assert.equal(m.submissionMatchesPlan({day,plannedAttempt:1,runAttempt:2,now:context.now}),false);assert.equal(m.submissionMatchesPlan({day,plannedAttempt:2,runAttempt:2,now:context.now}),true);assert.equal(m.submissionMatchesPlan({day,plannedAttempt:1,runAttempt:1,now:context.now+86400000}),false);}
test('CL1026: rerun failed notify cannot replay an old plan; a new planner can resume backlog',()=>replay(mod));
test('CL1026 mutant: failed job rerun reuses a past plan',async()=>{replay(mod);await killedMutation(source,[["plannedAttempt===runAttempt","true"]],async m=>replay(m));});
