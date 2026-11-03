// NC-009 N3 mutation gate. Never invokes providers or production.
import {mkdtempSync,mkdirSync,cpSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
const root=resolve(import.meta.dirname,"..");
const testPath="scripts/kit-192h-release.test.mjs";
const files=["worker/kit-release-192h.mjs","worker/kit-hotmart-identity.mjs","worker/kit-nc015-token.mjs",testPath];
function run(mutant){
 const tmp=mkdtempSync(join(tmpdir(),"kit192-"));
 try{
  for(const file of files){mkdirSync(resolve(tmp,file,".."),{recursive:true});cpSync(join(root,file),join(tmp,file));}
  if(mutant){
   const target=join(tmp,mutant.file);
   const s=readFileSync(target,"utf8");
   if(!s.includes(mutant.from))throw Error("MUTATION_ANCHOR_MISSING "+mutant.name);
   writeFileSync(target,s.replace(mutant.from,mutant.to));
  }
  const p=spawnSync(process.execPath,["--test","--test-reporter=tap",testPath],
   {cwd:tmp,encoding:"utf8",timeout:25000,maxBuffer:5*1024*1024});
  return {rc:p.status??1,output:String(p.stdout||"")+"\n"+String(p.stderr||"")};
 }finally{rmSync(tmp,{recursive:true,force:true});}
}
const baseline=run();
if(baseline.rc!==0||!/# tests 12\b/.test(baseline.output)||!/# pass 12\b/.test(baseline.output))
 {console.log(baseline.output.slice(-5000));throw Error("BASELINE_NOT_GREEN");}
const candidates=[
 {name:"N3_TIME_191_HOURS",file:"worker/kit-release-192h.mjs",
 from:"export const RELEASE_DELAY_MS=192*60*60*1000;",to:"export const RELEASE_DELAY_MS=191*60*60*1000;"},
 {name:"N3_REFUND_GATE_REMOVED",file:"worker/kit-release-192h.mjs",
 from:'const BLOCKING=new Set(["PURCHASE_REFUNDED",',to:'const BLOCKING=new Set(["PURCHASE_UNKNOWN",'},
 {name:"N3_DOWNLOAD_EARLY",file:"worker/kit-release-192h.mjs",
 from:"now<st.release_at_ms||now>st.token_expires_at_ms",to:"false||now>st.token_expires_at_ms"},
 {name:"N3_DEDUPE_BYPASS",file:"worker/kit-release-192h.mjs",
 from:'if(this.one("SELECT event_key FROM kit_events WHERE event_key=?",event_key))',to:'if(false&&this.one("SELECT event_key FROM kit_events WHERE event_key=?",event_key))'},
 {name:"N3_HOTTOK_BYPASS",file:"worker/kit-hotmart-identity.mjs",
 from:'if(token.length<16||!cteq(token,request.headers.get("x-hotmart-hottok")))',to:'if(false)'}
];
for(const m of candidates){
 const res=run(m);
 if(res.rc===0||!/# fail [1-9]/.test(res.output)){console.error(res.output.slice(-3000));throw Error("MUTANT_SURVIVED_OR_INCONCLUSIVE "+m.name)}
 console.log("MUTANT "+m.name+" KILLED");
}
console.log("NC009_KIT_MUTANTS=PASS killed="+candidates.length+"/"+candidates.length);
