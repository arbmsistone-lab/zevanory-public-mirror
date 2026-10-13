import test from "node:test";
import assert from "node:assert/strict";
import worker,{leadSource} from "../worker/sales-public-worker.mjs";

function setup(coreStatus){
  const hits=[],subs=[];
  const env={CORE:{fetch:async(u,init)=>{const url=String(u);
    if(url.startsWith("https://funnel.internal/")){hits.push(JSON.parse(init.body));return new Response(null,{status:204});}
    subs.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:coreStatus===200,message:"Quase lá! Enviamos um link de confirmação para o seu e-mail."}),{status:coreStatus});}}};
  const ctx={waitUntil(p){this.p=p}};
  return {env,ctx,hits,subs};
}
const post=(referer)=>{const f=new FormData();f.set("email","pessoa@example.test");f.set("consentimento","sim");
  return new Request("https://vendas.zevanory.api.br/material-gratuito/inscrever",{method:"POST",body:f,headers:{"user-agent":"Mozilla/5.0 Chrome/130","cf-connecting-ip":"198.51.100.9",referer}});};

test("accepted lead form counts one lead_submit with the page's utm_source and no personal data",async()=>{
  const {env,ctx,hits}=setup(200);
  const r=await worker.fetch(post("https://vendas.zevanory.api.br/material-gratuito?utm_source=youtube&utm_campaign=x"),env,ctx);
  assert.equal(r.status,200); await ctx.p;
  assert.equal(hits.length,1);
  assert.equal(hits[0].metric,"lead_submit"); assert.equal(hits[0].page,"material-gratuito"); assert.equal(hits[0].src,"youtube");
  assert.doesNotMatch(JSON.stringify(hits[0]),/pessoa@|example\.test/);
});
test("rejected lead form is not counted",async()=>{
  const {env,ctx,hits}=setup(400);
  await worker.fetch(post("https://vendas.zevanory.api.br/material-gratuito"),env,ctx);
  assert.equal(hits.length,0);
});
test("source label: same-site utm only, sanitized, else sem_tag",()=>{
  const r=ref=>new Request("https://vendas.zevanory.api.br/material-gratuito/inscrever",{headers:ref?{referer:ref}:{}});
  assert.equal(leadSource(r("https://vendas.zevanory.api.br/material-gratuito?utm_source=Bluesky")),"bluesky");
  assert.equal(leadSource(r("https://evil.example/?utm_source=youtube")),"sem_tag");
  assert.equal(leadSource(r("https://vendas.zevanory.api.br/material-gratuito?utm_source=%3Cx%3E")),"sem_tag");
  assert.equal(leadSource(r("")),"sem_tag");
});
