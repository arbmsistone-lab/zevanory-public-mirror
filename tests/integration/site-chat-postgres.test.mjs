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

test("PostgreSQL real: limites, escalonamento idempotente, handoff com sink e fila autenticada", { skip }, async () => {
  psql("drop table if exists zevanory_site_chat_sessions, zevanory_site_chat_messages, zevanory_site_chat_tickets, zevanory_site_chat_counters");
  resetSiteChatState();
  const mailer = sinkMailer();
  const env = { ...SANDBOX_ENV, ZEVANORY_PRIVATE_ARTIFACTS: fakeKv() };
  const deps = { sqlFactory, salesOpen: async () => false, mailer };
  const call = async (path, body) => { const r = await handleSiteChat(chatRequest(path, body), env, deps); return { status: r.status, body: await r.json() }; };
  const s = (await call("/api/chat/session", {})).body.session;
  assert.match(s, /^sbx_/);
  const price = await call("/api/chat", { session: s, message: "Quanto custa o Lucro & Caixa?" });
  assert.equal(price.body.reply, CHAT.closed_price_answer);
  const esc = await call("/api/chat", { session: s, message: "quero reembolso, meu cpf é 529.982.247-25" });
  const proto = esc.body.escalation.protocol;
  assert.match(proto, /^SBX-\d{8}-[A-Z2-9]{6}$/);
  const again = await call("/api/chat", { session: s, message: "vou reclamar no procon" });
  assert.equal(again.body.escalation.protocol, proto);
  const h1 = await call("/api/chat/handoff", { session: s, email: "cliente@exemplo.com.br" });
  const h2 = await call("/api/chat/handoff", { session: s, email: "cliente@exemplo.com.br" });
  assert.equal(h1.body.protocol, proto);
  assert.equal(h2.body.protocol, proto);
  assert.equal(mailer.sent.length, 2, "dono + cliente, uma vez");
  const t = psql("select categories, contact_email, customer_confirmed_at is not null as confirmed from zevanory_site_chat_tickets")[0];
  assert.deepEqual(t.categories.replace(/[{}]/g, "").split(",").sort(), ["complaint", "human_request", "sensitive_data"]);
  assert.equal(t.contact_email, "cliente@exemplo.com.br");
  assert.equal(t.confirmed, "t");
  const stored = psql("select body from zevanory_site_chat_messages order by id").map((r) => r.body).join("\n");
  assert.ok(!stored.includes("529.982.247-25"), "CPF nunca chega ao banco");
  // Limite por sessão/minuto com o upsert real.
  for (let i = 0; i < CHAT.limits.per_session_per_minute; i++) await call("/api/chat", { session: s, message: "oi" });
  assert.equal((await call("/api/chat", { session: s, message: "oi" })).status, 429);
  // Fila do proprietário.
  const admin = (req) => handleSiteChatAdmin(req, { DATABASE_URL: "x" }, { sqlFactory, isAdminAuthorized: () => true });
  const list = await (await admin(new Request("https://zevanory.api.br/api/admin/site-chat/tickets"))).json();
  assert.equal(list.tickets.length, 1);
  const detail = await (await admin(new Request(`https://zevanory.api.br/api/admin/site-chat/tickets/${proto}`))).json();
  assert.equal(detail.ticket.contact_email, "cliente@exemplo.com.br");
  assert.ok(detail.transcript.length >= 4);
  assert.equal(detail.ticket.session_hash, undefined, "hash da sessão não sai da fila");
  assert.equal((await admin(new Request(`https://zevanory.api.br/api/admin/site-chat/tickets/${proto}/close`, { method: "POST" }))).status, 200);
});

test("PostgreSQL real: retenção 30 dias (não escalada), 180 dias após encerramento, retenção legal e contadores", { skip }, async () => {
  psql("drop table if exists zevanory_site_chat_sessions, zevanory_site_chat_messages, zevanory_site_chat_tickets, zevanory_site_chat_counters");
  resetSiteChatState();
  assert.deepEqual(await runSiteChatRetention({ DATABASE_URL: "x" }, { sqlFactory }), { ok: true, reason: "no_tables", deleted: 0 }, "sem tabelas: nada a fazer");
  const env = { ...SANDBOX_ENV, ZEVANORY_PRIVATE_ARTIFACTS: fakeKv() };
  await handleSiteChat(chatRequest("/api/chat/session", {}), env, { sqlFactory, salesOpen: async () => false, mailer: sinkMailer() }); // cria o esquema
  psql(`insert into zevanory_site_chat_sessions (session_hash, created_at, last_at) values
      ('old', now() - interval '40 days', now() - interval '31 days'), ('recent', now() - interval '2 days', now() - interval '2 days'),
      ('esc-open', now() - interval '200 days', now() - interval '200 days'), ('esc-closed-old', now() - interval '400 days', now() - interval '400 days'),
      ('esc-closed-new', now() - interval '100 days', now() - interval '100 days'), ('esc-hold', now() - interval '400 days', now() - interval '400 days');
    insert into zevanory_site_chat_messages (session_hash, role, body, created_at) values
      ('old','u','a', now() - interval '31 days'), ('recent','u','b', now() - interval '2 days'), ('esc-open','u','c', now() - interval '200 days'),
      ('esc-closed-old','u','d', now() - interval '400 days'), ('esc-closed-new','u','e', now() - interval '100 days'), ('esc-hold','u','f', now() - interval '400 days');
    insert into zevanory_site_chat_tickets (protocol, session_hash, category, categories, status, due_at, closed_at, legal_hold) values
      ('ZC-20250101-AAAAAA','esc-open','refund','{refund}','open', now(), null, false),
      ('ZC-20250101-BBBBBB','esc-closed-old','refund','{refund}','closed', now(), now() - interval '181 days', false),
      ('ZC-20250101-CCCCCC','esc-closed-new','refund','{refund}','closed', now(), now() - interval '90 days', false),
      ('ZC-20250101-DDDDDD','esc-hold','legal','{legal}','closed', now(), now() - interval '300 days', true);
    insert into zevanory_site_chat_counters (bucket, window_start, n) values ('g:d', now() - interval '3 days', 5), ('g:d2', now(), 1);`);
  const out = await runSiteChatRetention({ DATABASE_URL: "x" }, { sqlFactory });
  assert.equal(out.ok, true);
  const sessions = psql("select session_hash from zevanory_site_chat_sessions where length(session_hash) < 20 order by 1").map((r) => r.session_hash);
  assert.deepEqual(sessions, ["esc-closed-new", "esc-hold", "esc-open", "recent"]);
  assert.deepEqual(psql("select body from zevanory_site_chat_messages order by body").map((r) => r.body), ["b", "c", "e", "f"]);
  assert.deepEqual(psql("select protocol from zevanory_site_chat_tickets order by 1").map((r) => r.protocol), ["ZC-20250101-AAAAAA", "ZC-20250101-CCCCCC", "ZC-20250101-DDDDDD"]);
  assert.equal(psql("select count(*)::int as n from zevanory_site_chat_counters where window_start < now() - interval '2 days'")[0].n, "0");
  assert.equal(psql("select count(*)::int as n from zevanory_site_chat_counters where bucket = 'g:d2'")[0].n, "1");
});
