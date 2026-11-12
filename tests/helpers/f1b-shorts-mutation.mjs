// Mutation harness: only local source copies, no credentials or external services.
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {readTextNormalized} from "./text.mjs";
export async function killedMutation(url, edits, scenario){
  let source=readTextNormalized(url);
  for(const [from,to] of edits){assert.equal(source.split(from).length-1,1,"unique mutation anchor: "+from);source=source.replace(from,to);}
  source=source.replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,q,spec)=>"from "+q+new URL(spec,url).href+q);
  source=source.replace(/new URL\((["'])(\.\.?\/[^"']+)\1,\s*import.meta.url\)/g,(_,q,spec)=>"new URL("+JSON.stringify(new URL(spec,url).href)+")");
  const dir=mkdtempSync(join(tmpdir(),"zev-f1-mutation-"));
  try{
    const file=join(dir,"mutant.mjs");writeFileSync(file,source);
    const mod=await import(pathToFileURL(file).href);
    await assert.rejects(()=>scenario(mod),{code:"ERR_ASSERTION"},"mutant must die by scenario assertion");
  }finally{rmSync(dir,{recursive:true,force:true});}
}
