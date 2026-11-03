// NC-010 F1–F3: assertion-driven mutation suite; no real provider calls.
import {mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const files=['worker/kit-release-192h.mjs','worker/kit-hotmart-identity.mjs','worker/kit-nc015-token.mjs','scripts/kit-192h-fixes.test.mjs'];
function execute(mutant){
 const dir=mkdtempSync(join(tmpdir(),'nc010-fix-'));
 try{
  for(const file of files){mkdirSync(resolve(dir,file,'..'),{recursive:true});cpSync(join(root,file),join(dir,file));}
  if(mutant){
   const path=join(dir,'worker/kit-release-192h.mjs'),raw=readFileSync(path,'utf8');
   if(!raw.includes(mutant.from))throw Error('MUTANT_ANCHOR_NOT_FOUND '+mutant.name);
   writeFileSync(path,raw.replace(mutant.from,mutant.to));
  }
  const r=spawnSync(process.execPath,['--test','--test-reporter=tap','scripts/kit-192h-fixes.test.mjs'],
   {cwd:dir,encoding:'utf8',timeout:35000,maxBuffer:5*1024*1024});
  return {code:r.status??1,output:(r.stdout||'')+'\n'+(r.stderr||'')};
 }finally{rmSync(dir,{recursive:true,force:true})}
}
const good=execute(null);
if(good.code!==0||!/# pass 5\b/.test(good.output)){console.error(good.output.slice(-6000));throw Error('FIXES_BASELINE_FAIL')}
const variants=[
 {name:'F1_EXTERNAL_REFUND_IGNORED',from:'if(!this.validApprovedProof(now,proof))return false;',to:'if(false)return false;'},
 {name:'F2_VERIFIED_ALARM_REQUERIES_PROVIDER',from:'if(policy.status==="queued"||policy.status==="stalled")return;',to:'if(false)return;'},
 {name:'F3_REQUEST_NEVER_HELD',from:'event_type==="REFUND_REQUESTED" && state.state!=="revoked"',to:'event_type==="REFUND_IGNORED" && state.state!=="revoked"'}
];
for(const m of variants){
 const res=execute(m);
 if(res.code===0||!/# fail [1-9]/.test(res.output)){console.error(res.output.slice(-3000));throw Error('MUTANT_SURVIVED '+m.name)}
 console.log('MUTANT '+m.name+' KILLED');
}
console.log('NC010_F1_F2_F3_MUTANTS=PASS killed=3/3');
