import test from "node:test";
import assert from "node:assert/strict";
import worker,{leadSource,leadHitBody} from "../worker/sales-public-worker.mjs";

const NEW="Quase lá! Enviamos um link de confirmação para o seu e-mail.";
function setup(coreStatus,message=NEW){
  const hits=[];
  const env={CORE:{fetch:async(u,init)=>{const url=String(u);
    if(url.startsWith("https://funnel.internal/")){hits.push(JSON.parse(init.body));return new Response(null,{status:204});}
    return new Response(JSON.stringify({ok:coreStatus===200,message}),{status:coreStatus});}}};
  const ctx={waitUntil(p){this.p=p}};
  return {env,ctx,hits};
}
const post=(referer,{ua="Mozilla/5.0 Chrome/130",honeypot=""}={})=>{const f=new FormData();f.set("email","pessoa@example.test");f.set("nome","Pessoa Teste");f.set("consentimento","sim");if(honeypot)f.set("website",honeypot);
  return new Request("https://vendas.zevanory.api.br/material-gratuito/inscrever",{method:"POST",body:f,headers:{"user-agent":ua,"cf-connecting-ip":"198.51.100.9","accept-language":"pt-BR",referer}});};
const REF="https://vendas.zevanory.api.br/material-gratuito?utm_source=youtube&utm_campaign=x";

test("new sign-up counts one lead_submit with only page, metric, source, UA and ASN",async()=>{
  const {env,ctx,hits}=setup(200);
  const r=await worker.fetch(post(REF),env,ctx);
  assert.equal(r.status,200); await ctx.p;
  assert.equal(hits.length,1);
  assert.deepEqual(Object.keys(hits[0]).sort(),["asn","metric","page","src","ua"]);
  assert.equal(hits[0].metric,"lead_submit"); assert.equal(hits[0].src,"youtube");
  assert.doesNotMatch(JSON.stringify(hits[0]),/pessoa@|example\.test|Pessoa Teste|198\.51\.100\.9|pt-BR/);
});
test("not counted: rejected form, resend to already confirmed e-mail, honeypot, automation",async()=>{
  for(const [status,msg] of [[400,"Confira o e-mail."],[200,"Enviamos o checklist para o seu e-mail."],[503,"Não conseguimos enviar agora. Tente de novo em instantes."]]){
    const {env,ctx,hits}=setup(status,msg); await worker.fetch(post(REF),env,ctx); await ctx.p; assert.equal(hits.length,0,msg);
  }
  let s=setup(200); await worker.fetch(post(REF,{honeypot:"spam"}),s.env,s.ctx); assert.equal(s.hits.length,0,"honeypot");
  s=setup(200); const r=await worker.fetch(post(REF,{ua:"python-requests/2"}),s.env,s.ctx); assert.equal(r.status,403); assert.equal(s.hits.length,0,"bot ua");
});
test("source label: same-site utm only, sanitized, else sem_tag; body builder has no personal fields",()=>{
  const r=ref=>new Request("https://vendas.zevanory.api.br/material-gratuito/inscrever",{headers:ref?{referer:ref,"cf-connecting-ip":"1.2.3.4"}:{}});
  assert.equal(leadSource(r("https://vendas.zevanory.api.br/material-gratuito?utm_source=Bluesky")),"bluesky");
  assert.equal(leadSource(r("https://evil.example/?utm_source=youtube")),"sem_tag");
  assert.equal(leadSource(r("https://vendas.zevanory.api.br/material-gratuito?utm_source=%3Cx%3E")),"sem_tag");
  assert.equal(leadSource(r("")),"sem_tag");
  assert.equal("ip" in leadHitBody(r(REF)),false);
});
