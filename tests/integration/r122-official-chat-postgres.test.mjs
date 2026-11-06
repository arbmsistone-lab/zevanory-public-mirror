// Chat do site contra PostgreSQL REAL e descartável (SQL de worker/site-chat.mjs sem fakes): contadores de limite
// (unnest + upsert), sessão -> mensagem -> escalonamento -> handoff idempotente, fila do proprietário e retenção
// (30 dias / 180 dias após encerramento / retenção legal / contadores 2 dias). Sandbox + sink: nenhum e-mail real.
// Opcional: só roda com SITE_CHAT_PG_HOST (cluster local/CI descartável). Parâmetros viram literais SÓ no teste.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { handleSiteChat, handleSiteChatAdmin, runSiteChatRetention, resetSiteChatState, CHAT } from "../../worker/site-chat.mjs";
import { fakeKv, sinkMailer, SANDBOX_ENV, chatRequest } from "../helpers/site-chat-fakes.mjs";

const HOST = process.env.SITE_CHAT_PG_HOST;
const PORT = process.env.SITE_CHAT_PG_PORT || "5432";
const DB = process.env.SITE_CHAT_PG_DB || "postgres";
const USER = process.env.SITE_CHAT_PG_USER || "postgres";
const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return "'{" + v.map((x) => '"' + String(x).replace(/["\\]/g, "\\$&") + '"').join(",") + "}'";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function psql(sqlText) {
  const out = execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", USER, "-d", DB, "-v", "ON_ERROR_STOP=1", "--csv", "-c", sqlText], { encoding: "utf8" });
  const lines = out.trim().split("\n").filter(Boolean);
  if (!lines.length || /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE) /.test(lines[0])) return [];
  const parse = (line) => { const cells = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ",") { cells.push(cur); cur = ""; } else cur += c; } cells.push(cur); return cells; };
  const [head, ...rows] = lines;
  const cols = parse(head);
  return rows.filter((r) => !/^(INSERT|UPDATE|DELETE) \d/.test(r)).map((r) => Object.fromEntries(parse(r).map((v, i) => [cols[i], v === "" ? null : v])));
}
const sqlFactory = () => ({ query: async (text, params = []) => psql(text.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]))) });
const skip = !HOST && "SITE_CHAT_PG_HOST not set";

test("R122 PostgreSQL efêmero: chat -> protocolo oficial ZEV -> outbox real -> confirmação e alerta simulados", { skip }, async () => {
  psql("drop table if exists zevanory_site_chat_messages, zevanory_site_chat_tickets, zevanory_site_chat_sessions, zevanory_site_chat_counters, zevanory_atendimento_outbox, zevanory_atendimento_quota, zevanory_atendimento_monitor");
  resetSiteChatState();
  const sent = new Map();
  const fetchImpl = async (_url,init) => {
    const key=String(init?.headers?.["idempotency-key"]||"");
    if(!sent.has(key))sent.set(key,JSON.parse(init.body));
    return Response.json({id:"synthetic-"+sent.size});
  };
  const env={
    ...SANDBOX_ENV,ZEVANORY_PRIVATE_ARTIFACTS:fakeKv(),SITE_CHAT_OFFICIAL_PROTOCOLS:"true",
    LEAD_PRIVACY_SECRET:"r122-isolated-privacy-secret-40-characters-minimum",
    RESEND_API_KEY:"re_synthetic_sink_only",
    SUPPORT_FORWARD_TO:"owner@example.org",OWNER_ALERT_EMAIL:"alerts@example.org",
  };
  const chatMailer=sinkMailer();
  const deps={sqlFactory,fetchImpl,salesOpen:async()=>false,mailer:chatMailer};
  const call=async(path,body)=>{
    const result=await handleSiteChat(chatRequest(path,body),env,deps);
    return {status:result.status,body:await result.json()};
  };
  const sid=(await call("/api/chat/session",{})).body.session;
  assert.match(sid,/^sbx_/);
  const r=await call("/api/chat",{session:sid,message:"Quero reembolso, não tive acesso ao guia que comprei"});
  assert.equal(r.status,200);
  assert.equal(r.body.escalation.protocol,null,"ZC provisório não exposto no modo oficial");
  assert.doesNotMatch(r.body.reply,/SBX-|ZC-/);
  const refused=await call("/api/chat/handoff",{session:sid,email:"buyer@example.com"});
  assert.equal(refused.status,400);
  const first=await call("/api/chat/handoff",{session:sid,email:"buyer@example.com",privacy_ack:true});
  assert.equal(first.status,200);
  assert.match(first.body.protocol,/^ZEV-\d{8}-[A-F0-9]{10}$/);
  assert.equal(first.body.official,true);
  assert.equal(first.body.email_confirmation,"sent");
  assert.equal(psql("select count(*)::int as n from zevanory_atendimento_outbox")[0].n,"1");
  assert.equal(psql("select count(*)::int as n from zevanory_site_chat_tickets")[0].n,"0","no parallel ZC/SBX ticket in official mode");
  assert.equal(psql("select owner_status from zevanory_atendimento_outbox")[0].owner_status,"sent");
  assert.equal(psql("select customer_status from zevanory_atendimento_outbox")[0].customer_status,"sent");
  assert.equal(chatMailer.sent.length,0,"nenhum e-mail paralelo do chat");
  assert.equal(sent.size,2,"um alerta ao dono e uma confirmação ao cliente");
  assert.ok([...sent.values()].some(v=>v.to?.includes("buyer@example.com")));
  const again=await call("/api/chat/handoff",{session:sid,email:"buyer@example.com",privacy_ack:true});
  assert.equal(again.body.protocol,first.body.protocol);
  assert.equal(sent.size,2,"segunda chamada não duplica avisos");
});

// R142: actual PostgreSQL writes and the unsent durable official ZEV outbox are inspected.
// Deliberately reject the fake Resend request so the outbox payload remains queryable.
test("R142 PostgreSQL: sensitive topic removed from message body AND pending ZEV outbox payload", { skip }, async () => {
  const env={
    ...SANDBOX_ENV,ZEVANORY_PRIVATE_ARTIFACTS:fakeKv(),SITE_CHAT_OFFICIAL_PROTOCOLS:"true",
    LEAD_PRIVACY_SECRET:"r142-isolated-privacy-secret-40-characters-minimum",
    RESEND_API_KEY:"re_r142_test_sink_only",SUPPORT_FORWARD_TO:"owner@example.org",
  };
  const fetchImpl=async()=>new Response(JSON.stringify({error:"temporary"}),{status:503,headers:{"content-type":"application/json"}});
  const deps={sqlFactory,fetchImpl,salesOpen:async()=>false,mailer:sinkMailer()};
  const call=async(path,body)=>{const response=await handleSiteChat(chatRequest(path,body),env,deps);return {status:response.status,body:await response.json()};};
  const secrets=[
    ["Tenho um diagnóstico de r142doencasecreta que quero tratar", "r142doencasecreta"],
    ["Minha religião r142religiaoprivada é informação particular", "r142religiaoprivada"],
  ];
  for(const [message,forbidden] of secrets){
    const sid=(await call("/api/chat/session",{})).body.session;
    const reply=await call("/api/chat",{session:sid,message});
    assert.equal(reply.status,200);
    assert.equal(reply.body.category,"sensitive_data");
    const handoff=await call("/api/chat/handoff",{session:sid,email:"r142buyer@example.com",privacy_ack:true});
    assert.equal(handoff.status,200);
    assert.equal(handoff.body.official,true);
    const messages=psql("select body from zevanory_site_chat_messages where role='u' order by id desc limit 1");
    assert.equal(messages[0].body,"[conteúdo sensível removido]");
    const payload=psql("select payload::text as body from zevanory_atendimento_outbox where protocolo="+lit(handoff.body.protocol))[0];
    assert.ok(payload&&payload.body, "outbox must keep payload while provider is unavailable");
    assert.match(payload.body,/conteúdo sensível removido/);
    assert.ok(!payload.body.includes(forbidden), "no sensitive literal in ZEV outbox");
    assert.ok(!messages[0].body.includes(forbidden), "no sensitive literal in chat message row");
  }
  const sid=(await call("/api/chat/session",{})).body.session;
  await call("/api/chat",{session:sid,message:"Meu CPF 123.456.789-09 cartao 4111 1111 1111 1111 senha: segredoR142"});
  const masked=psql("select body from zevanory_site_chat_messages where role='u' order by id desc limit 1")[0].body;
  for(const bad of ["123.456.789-09","4111 1111 1111 1111","segredoR142"])assert.ok(!masked.includes(bad),"structured sensitive literal persisted");
  assert.match(masked,/\[removido\]/);
});
