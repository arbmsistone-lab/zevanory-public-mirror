import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const ROOT=resolve(import.meta.dirname,".."),CHECK="scripts/cp-kv-writers-lint.mjs";
function run(mutator){
 const tmp=mkdtempSync(join(tmpdir(),"cp-g00-"));
 try {
  for(const x of ["worker","scripts", "docs/ops/cp-kv-allowlist-NC009.json"]){
   const target=join(tmp,x);mkdirSync(resolve(target,".."),{recursive:true});cpSync(join(ROOT,x),target,{recursive:true});
  }
  mutator(tmp);
  return spawnSync(process.execPath,[CHECK],{cwd:tmp,encoding:"utf8",timeout:10000});
 }finally{rmSync(tmp,{recursive:true,force:true})}
}
test("G00 DEC-14(b) inventory 37 to 0 passes and the content-service holds no legacy KV writer",()=>{
 const r=run(()=>{});
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/"baseline":0/);
 assert.match(r.stdout,/"actual":0/);
 assert.match(r.stdout,/READY_FOR_INTEGRATION_REVIEW/);
});
test("G00 mutant new direct KV writer in content-service is killed",()=>{
 const r=run(root=>{
  const p=join(root,"worker/content-service.mjs");
  // DEC-14(b): with a zero baseline, any reintroduced direct KV write is a count increase.
  writeFileSync(p,readFileSync(p,"utf8")+'\nexport async function mutant(kv){ await kv.put("zpc:cp:sub:x", "{}"); }\n');
 });
 assert.notEqual(r.status,0,"mutant reintroduced a legacy writer, must fail");
 assert.match(r.stderr,/CP_CANONICAL_KV_WRITE_COUNT_INCREASED/);
});
test("G00 mutant newly created file with zpc:cp: and put is killed",()=>{
 const r=run(root=>writeFileSync(join(root,"worker/cp-mutant.mjs"),'const KEY="zpc:cp:sub:"; export async function unsafe(kv){await kv.put(KEY+"x","bad");}\n'));
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/CP_KV_WRITER_NEW_FILE/);
});
