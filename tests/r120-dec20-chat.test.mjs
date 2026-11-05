// R120 / DEC-20: local, side-effect-free contract tests. No network, mail or production KV.
import test from "node:test";
import assert from "node:assert/strict";
import {readTextNormalized} from "./helpers/text.mjs";
import {composeReply,guardReply, CATALOG, CLOSED_PRICE_ANSWER, CHAT} from "../worker/site-chat.mjs";
const read=p=>readTextNormalized(new URL("../"+p,import.meta.url));
test("R120 absent official knowledge escalates to human rather than improvises",async()=>{
  const missing={...CATALOG,ok:false};
  const answer=await composeReply({message:"O que vem no Vendas na Prática?",catalog:missing,salesOpen:false});
  assert.equal(answer.escalate?.category,"source_conflict");
  assert.doesNotMatch(answer.body,/R\$\s*197/);
});
test("R120 rejects fabricated price and all checkout links with sales closed",async()=>{
  const bad={body:"Compre agora por R$ 197,00 em https://pay.hotmart.com/falso",actions:[]};
  const fixed=guardReply(bad,{salesOpen:false});
  assert.equal(fixed.mode,"guard_blocked");
  assert.doesNotMatch(fixed.body,/197|pay\.hotmart|\/comprar/);
  const closed=await composeReply({message:"Qual preço do Lucro & Caixa?",salesOpen:false});
  assert.equal(closed.body,CLOSED_PRICE_ANSWER);
  assert.equal(CLOSED_PRICE_ANSWER.includes("R$"),false);
});
test("R120 Workers AI exhausted free quota falls back to official human protocol form",async()=>{
  const ai={async run(){throw new Error("daily quota exceeded: neurons")}};
  const result=await composeReply({message:"O que vem no Vendas na Prática?",salesOpen:false,ai,generative:true});
  assert.equal(result.mode,"ai_quota_fallback");
  assert.match(result.body,/zevanory\.api\.br\/atendimento/);
  assert.doesNotMatch(result.body,/checkout|\/comprar|pay\.hotmart/);
  assert.ok(result.actions.some(a=>a.type==="form"));
});
test("R120 candidate is disabled by default with privacy retention and accessible native widget",()=>{
  assert.equal(CHAT.enabled_default,false);
  assert.equal(CHAT.retention.transcript_days,30);
  assert.equal(CHAT.retention.ticket_days_after_closure,180);
  const widget=read("sales-overlay/site-chat.js");
  assert.match(widget,/role: "dialog"/);
  assert.match(widget,/aria-live/);
  assert.match(widget,/Falar com uma pessoa/);
  assert.match(widget,/assistente automático/);
  assert.match(read("worker/site-chat.mjs"),/siteChatLog/);
});
