// NC-009 G00: exact allowlist, no regression to legacy canonical KV writes.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
const root=resolve(import.meta.dirname,"..");
const manifest=JSON.parse(readFileSync(resolve(root,"docs/ops/cp-kv-allowlist-NC009.json"),"utf8"));
const source=readFileSync(resolve(root,manifest.scope),"utf8").split(/\r?\n/);
const direct=/\b(?:kv|kv0|raw)\.(?:put|delete)\s*\(|\bputJson\s*\(/;
const actual=source.flatMap((line,i)=>direct.test(line)?[{line:i+1,text:line.trim()}]:[]);
const expected=manifest.allowlist;
if(actual.length>manifest.remaining_baseline || expected.length!==manifest.remaining_baseline)
 throw Error("CP_CANONICAL_KV_WRITE_COUNT_INCREASED");
const want=new Map(expected.map(o=>[o.line,o.text]));
for(const item of actual)if(want.get(item.line)!==item.text)
 throw Error("CP_UNAPPROVED_KV_WRITER:"+manifest.scope+":"+item.line);
if(actual.length!==expected.length)throw Error("CP_MANIFEST_REVIEW_REQUIRED_FOR_REDUCTION");
// NC-011: recursively inspect all runtime code roots, not just worker/*.mjs.
// Unit tests and generated output are deliberately not production entrypoints;
// migration/deploy scripts remain in scope and must not hide canonical CP writes.
const runtimeRoots=["worker","cf-worker","backend","src","functions","api","pages","scripts/deploy","scripts/migrations"];
const codeExt=/\.(?:mjs|cjs|js|jsx|ts|tsx|py|ps1|sh)$/;
const skipDirs=new Set(["node_modules",".git","dist","build","coverage",".next",".wrangler","__pycache__"]);
function walk(relative,acc=[]){
 const dir=resolve(root,relative);
 try{
  for(const ent of readdirSync(dir,{withFileTypes:true})){
   const next=relative+"/"+ent.name;
   if(ent.isDirectory()&&!skipDirs.has(ent.name))walk(next,acc);
   else if(ent.isFile()&&codeExt.test(ent.name))acc.push(next);
  }
 }catch(e){if(e.code!=="ENOENT")throw e}
 return acc;
}
const files=runtimeRoots.flatMap(dir=>walk(dir));
const exempt=new Set(["worker/sales-ledger.mjs","worker/data-backup.mjs"]); // M3 excluded from CP only.
const unsafe=[];
for(const file of files){
 if(file==="worker/content-service.mjs"||exempt.has(file))continue;
 const content=readFileSync(resolve(root,file),"utf8");
 // Co-location is conservative: any CP key with a write/alias in the same
 // production file requires human audit. No extra writers may be introduced.
 if(/zpc:cp:/.test(content)&&/(?:\b(?:kv|store|storage|raw|this\.kv)\s*\.\s*(?:put|delete)\s*\(|\bputJson\s*\(|\bwrangler\s+kv\s+key\s+(?:put|delete)\b)/.test(content))
  unsafe.push(file);
}
if(unsafe.length)throw Error("CP_KV_WRITER_NEW_FILE:"+unsafe.join(","));
// Track consistency: baseline is reviewable and the real existing legacy writes block cutover.
// gate success here means NO NEW unsanctioned writes; it is NOT a cutover green light.
console.log(JSON.stringify({G00_KV_LINT:"PASS",baseline:expected.length,actual:actual.length,scanned_code_files:files.length,cutover:actual.length===0?"READY_FOR_INTEGRATION_REVIEW":"NO_GO_LEGACY_KV_WRITERS"}));
