import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {ContentProntoSubscriberDO} from "../worker/cp-durable-ledger.mjs";
import {issueCpFormTokenCandidate} from "../worker/cp-g03-g04-candidate.mjs";
import {routeHotmartNc011,routeBriefingNc011,routePackageNc011,routeOperatorNc011} from "../worker/cp-nc011-routing.mjs";
import {CP_BRIEFING_FIELDS,CAMPANHA,CAMPANHA_CAMPOS} from "../worker/content-service.mjs";

function harness(){
 const db=new DatabaseSync(":memory:");
 const sql={exec(q,...args){
  const s=q.trim();
  if(/^SELECT\b/i.test(s))return {toArray:()=>db.prepare(s).all(...args)};
  if(/^CREATE\s+(TABLE|INDEX)/i.test(s)){db.exec(s);return {toArray:()=>[]}};
  db.prepare(s).run(...args);return {toArray:()=>[]};
 }};
 const storage={sql,transactionSync(fn){db.exec("BEGIN IMMEDIATE");try{const v=fn();db.exec("COMMIT");return v}catch(e){db.exec("ROLLBACK");throw e}}};
 const doObj=new ContentProntoSubscriberDO({storage,id:{toString:()=>"test"}});
 const hits=[],failKV={get(){throw Error("legacy KV read forbidden")},put(){throw Error("legacy KV write forbidden")}};
 const env={
  HOTMART_HOTTOK:"TEST_TEST_TEST_HOTTOK_SECRET_123456",
  HOTMART_SERVICE_PRODUCT_IDS:"8704905",
  CP_DO_ROUTING_KEY:"TEST_TEST_TEST_CP_DO_ROUTING_KEY_123456789",
  CP_FORM_SIGNING_KEY:"TEST_TEST_TEST_CP_FORM_SIGNING_KEY_123456789",
  ZEVANORY_PRIVATE_ARTIFACTS:failKV,
  CP_SUBSCRIBER_DO:{idFromName(n){return n},get(){return {fetch(url,init){hits.push({url,method:init.method});return doObj.fetch(new Request(url,init))}}}}
 };
 const data={version:"2.0.0",event:"PURCHASE_APPROVED",data:{product:{id:8704905,name:"ZEVANORY Conteúdo Pronto"},
  subscription:{subscriber:{code:"sub-000000001"}},
  purchase:{transaction:"HP-00000000001",recurrence_number:1,status:"APPROVED"}}};
 const req=(tok=env.HOTMART_HOTTOK)=>new Request("https://example.invalid/api/webhooks/hotmart",{method:"POST",
  headers:{"x-hotmart-hottok":tok,"content-type":"application/json"},body:JSON.stringify(data)});
 return {db,doObj,env,req,hits};
}
test("NC011 CP real route commits into DO, no legacy KV and bad Hottok rejected",async()=>{
 const h=harness();
 assert.equal((await routeHotmartNc011(h.req("wrong"),h.env)).status,401);
 assert.equal(h.hits.length,0);
 const r=await routeHotmartNc011(h.req(),h.env);
 assert.equal(r.status,202,await r.text());
 assert.equal(h.doObj.ledger.snapshot().status,"active");
 assert.equal((await routeHotmartNc011(h.req(),h.env)).status,202);
 assert.equal(h.doObj.ledger.snapshot().event_count,1);
});
test("NC011 missing DO binding fails closed and never uses CP KV",async()=>{
 const h=harness(),env={...h.env,CP_SUBSCRIBER_DO:null};
 const x=await routeHotmartNc011(h.req(),env);
 assert.equal(x.status,503);
 assert.equal(h.hits.length,0);
});
test("NC011 GET reads the real SQLite token, POST validates and consumes it once",async()=>{
 const h=harness();await routeHotmartNc011(h.req(),h.env);
 const issued=await issueCpFormTokenCandidate({opaqueRoutingId:"a".repeat(64),cycle:1,
  expires_at_ms:Date.now()+3600000,env:h.env,event_key:"form:issued-00000000001"});
 const link="https://example.invalid/conteudo-pronto/briefing?t="+encodeURIComponent(issued.token);
 const get=await routeBriefingNc011(new Request(link),h.env);
 assert.equal(get.status,200,await get.text());
 const html=await get.text();
 assert.match(html,/campanha do mês/i);
 const start=new Date(Date.now()+2*86400000);
 const finish=new Date(start.getTime()+(Math.max(1,CAMPANHA.periodo_dias_min)-1)*86400000);
 const values={
  objetivo_comercial:"apresentar os servicos",oferta:"manutencao de bicicletas",
  condicao_comercial:"orcamento mediante consulta",
  periodo_inicio:start.toISOString().slice(0,10),periodo_fim:finish.toISOString().slice(0,10)
 };
 const params=new URLSearchParams();
 for(const f of CAMPANHA_CAMPOS)params.set(f.id,values[f.id]||"campanha de negocio local");
 for(const [id] of CP_BRIEFING_FIELDS)params.set(id,"Atendimento local de alta qualidade");
 const form=new Request(link,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:params.toString()});
 const sent=await routeBriefingNc011(form,h.env);
 assert.equal(sent.status,202,await sent.text());
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM cp_form_submissions").get().n,1);
 const replay=await routeBriefingNc011(new Request(link),h.env);
 assert.equal(replay.status,404);
});
test("NC011 unsupplied token and mutable legacy operator/package routes remain fail-closed",async()=>{
 const h=harness();
 assert.equal((await routeBriefingNc011(new Request("https://example.invalid/conteudo-pronto/briefing?t=bad"),h.env)).status,404);
 assert.equal(routeOperatorNc011().status,503);
 assert.equal(routePackageNc011().status,503);
});
test("NC011 mounted router is the active route and old KV retry cron disconnected",()=>{
 const s=readFileSync(new URL("../worker/cloudflare-worker.compat.mjs",import.meta.url),"utf8");
 assert.match(s,/routeHotmartNc011\(request,normalized,ctx\)/);
 assert.match(s,/routeBriefingNc011\(request,normalized\)/);
 assert.match(s,/routePackageNc011\(request,normalized\)/);
 assert.match(s,/routeOperatorNc011\(request, normalized\)/);
 assert.doesNotMatch(s,/retryPendingPackages\(normalized\)/);
});
