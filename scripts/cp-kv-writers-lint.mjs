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
const files=readdirSync(resolve(root,"worker")).filter(f=>/\.(?:mjs|js)$/.test(f)&&f!=="content-service.mjs");
const exempt=new Set(["sales-ledger.mjs","data-backup.mjs"]); // M3 is out of CP cutover; documented separately.
for(const file of files){
 const text=readFileSync(resolve(root,"worker",file),"utf8");
 if(exempt.has(file))continue;
 // Any new CP-prefixed writer, alias or direct store invocation must be explicitly reviewed.
 if(/zpc:cp:/.test(text) && /\b(?:kv|store|storage|raw|this\.kv)\s*\.\s*(?:put|delete)\s*\(|\bputJson\s*\(/.test(text))
   throw Error("CP_KV_WRITER_NEW_FILE:"+file);
}
// Track consistency: baseline is reviewable and the real existing legacy writes block cutover.
// gate success here means NO NEW unsanctioned writes; it is NOT a cutover green light.
console.log(JSON.stringify({G00_KV_LINT:"PASS",baseline:expected.length,actual:actual.length,cutover:actual.length===0?"READY_FOR_INTEGRATION_REVIEW":"NO_GO_LEGACY_KV_WRITERS"}));
