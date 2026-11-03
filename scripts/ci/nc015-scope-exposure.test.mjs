import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import worker from "../../worker/sales-public-worker.mjs";
import {CP_SALES_ENABLED,isCpPublicRoute} from "../../worker/nc015-sales-scope.mjs";
import {KIT_DOWNLOAD_ENABLED} from "../../worker/kit-nc015-download.mjs";
import {KIT_RESEND_CONSUMER_ENABLED} from "../../worker/kit-nc015-resend.mjs";
import {KIT_ORDER_INGEST_ENABLED} from "../../worker/kit-nc015-ingress.mjs";
import {inspectPublicMaterial} from "./nc015-public-download-census.mjs";
const root=fileURLToPath(new URL("../..",import.meta.url));
const read=p=>readFileSync(join(root,p),"utf8");

test("DEC-04 CP cannot be opened by the common sales switch, old links or checkout",async()=>{
 assert.equal(CP_SALES_ENABLED,false);
 const paths=["/conteudo-pronto","/conteudo-pronto/","/conteudo-pronto.html",
  "/assinar/conteudo-pronto","/hotmart/conteudo-pronto","/conteudo-pronto/briefing",
  "/conteudo-pronto/pacote"];
 for(const path of paths)assert.equal(isCpPublicRoute(path),true);
 const env={CORE:{fetch:async()=>Response.json({open:true})},ASSETS:{
  fetch:async()=>new Response("SENTINEL_CP_ASSET",{status:200})}};
 for(const path of paths.slice(0,5)){
  const r=await worker.fetch(new Request("https://vendas.zevanory.api.br"+path),env,{waitUntil(){}});
  assert.equal(r.status,404,path);
  assert.equal(r.headers.get("x-robots-tag"),"noindex, nofollow");
  assert.doesNotMatch(await r.text(),/SENTINEL_CP_ASSET|pay\.hotmart\.com/);
 }
 assert.equal(KIT_DOWNLOAD_ENABLED,false);
 assert.equal(KIT_RESEND_CONSUMER_ENABLED,false);
 assert.equal(KIT_ORDER_INGEST_ENABLED,false);
});
test("DEC-04 public catalog and llms contain no CP links or subscription offer",()=>{
 for(const path of ["solucoes/index.html","sales-public/solucoes.html",
  "sales-public/index.html","sales-overlay/llms.txt","sales-public/llms.txt"]){
  const body=read(path);
  assert.doesNotMatch(body,/conteudo-pronto|Conteúdo Pronto/i,path);
 }
 for(const path of ["sales-public/conteudo-pronto.html","pages-mirror/conteudo-pronto.html",
  "pages-mirror/sales-public__conteudo-pronto.html"]){
  const body=read(path);
  assert.match(body,/noindex,nofollow/);
  assert.doesNotMatch(body,/assinar|pay\.hotmart\.com|data-zev-sub/);
 }
});
test("N2 public repository census has no directly downloadable PDF ZIP or public archive",()=>{
 const result=inspectPublicMaterial({root});
 assert.equal(result.findings.length,0,JSON.stringify(result.findings).slice(0,2000));
 assert.ok(result.scanned_text_files>20);
 assert.equal(result.result,"NO_DIRECT_PUBLIC_BINARY_OR_LINK_IN_REPOSITORY");
});
test("N2 scanner kills a direct PDF link and exposed ZIP binary mutant",()=>{
 const dir=mkdtempSync(join(tmpdir(),"nc015-public-"));
 try{
  const target=join(dir,"sales-public");mkdirSync(target);
  writeFileSync(join(target,"index.html"),'<a href="/files/guia.pdf">Baixar</a>');
  writeFileSync(join(target,"material.zip"),"ZIP_TEST");
  const x=inspectPublicMaterial({root:dir});
  assert.ok(x.findings.some(f=>f.kind==="direct_download_url"));
  assert.ok(x.findings.some(f=>f.kind==="public_binary"));
 }finally{rmSync(dir,{recursive:true,force:true})}
});
