// ENSAIO R1-B (autorizado pelo proprietário em 25/11/2026, 17:50 BRT). Laboratório isolado:
// - banco: SOMENTE o branch Neon descartável `r1b-ensaio` (senha do papel redefinida SÓ nesse branch; o main não muda);
// - código: handlers REAIS do Worker (worker/cloudflare-worker.compat.mjs), carregados em Node;
// - rede: TODA chamada externa é interceptada e simulada (Resend, Hotmart, IA, Telegram, Bluesky, Cloudflare...);
//   só o tráfego HTTP do driver Neon para o host do branch passa. Nada real é enviado, publicado ou cobrado;
// - KV: em memória. Segredos: sintéticos, gerados nesta execução. Nenhuma credencial de produção.
// Rodar: R1B_ENSAIO_DATABASE_URL=... R1B_ENSAIO_EXPECTED_HOST=... node --import ./tests/t4_sim/register.mjs tests/r1b-ensaio/run.mjs
import { createHash, createHmac, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const URL_DB = process.env.R1B_ENSAIO_DATABASE_URL || "";
const EXPECTED_HOST = process.env.R1B_ENSAIO_EXPECTED_HOST || "";
const FORBIDDEN_HOSTS = ["ep-purple-firefly-b6b6kkti", "ep-long-cloud-b6men0jr", "ep-holy-cherry-b6z9vxy0"]; // prod-02 main, db-2, prod-01
const out = { schema: "r1b-ensaio/v1", started_at: new Date().toISOString(), guard: {}, tests: [], network: { neon: 0, blocked: [] } };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const finish = (code) => { out.finished_at = new Date().toISOString(); writeFileSync("r1b-ensaio-result.json", JSON.stringify(out, null, 2)); console.log("R1B_ENSAIO_RESULT " + JSON.stringify({ pass: out.tests.filter((t) => t.pass).length, fail: out.tests.filter((t) => !t.pass).length, guard: out.guard })); process.exit(code); };

// ---------- Guarda de isolamento (antes de QUALQUER import do Worker) ----------
let dbHost = "", dbUser = "";
try { const u = new URL(URL_DB); dbHost = u.hostname; dbUser = decodeURIComponent(u.username); } catch {}
out.guard = { host_sha256: dbHost ? sha(dbHost) : null, expected_host_sha256: EXPECTED_HOST ? sha(EXPECTED_HOST) : null, user: dbUser || null, pooled: dbHost.includes("-pooler") };
if (!dbHost || dbHost.replace("-pooler", "") !== EXPECTED_HOST || FORBIDDEN_HOSTS.some((h) => dbHost.startsWith(h)) || dbUser !== "neondb_owner") {
  out.guard.ok = false; out.guard.reason = "isolation_guard_failed"; finish(2);
}
out.guard.ok = true;
const branchHost = dbHost;

// ---------- Rede: só o driver Neon para o host do branch; o resto é simulado e registrado ----------
const realFetch = globalThis.fetch;
const sent = []; // chamadas externas simuladas (nunca saem)
let neonCalls = 0;
const mailbox = []; // e-mails "enviados" ao Resend simulado (nunca saem)
function fakeExternal(url, init) {
  const host = url.hostname;
  const method = (init?.method || "GET").toUpperCase();
  sent.push({ host, path: url.pathname.slice(0, 60), method });
  if (host === "api.resend.com") {
    const p = url.pathname;
    if (method === "POST" && p === "/emails") { let b = {}; try { b = JSON.parse(init.body); } catch {} const row = { ...b, id: "ensaio-mail-" + (mailbox.length + 1), object: "email", created_at: new Date().toISOString(), last_event: "delivered" }; mailbox.push(row); return Response.json({ id: row.id }); }
    if (p.endsWith("/usage")) return Response.json({ object: "usage", emails: { daily: { used: mailbox.length, limit: 100, resets_at: new Date(Date.now() + 86400000).toISOString() }, monthly: { used: mailbox.length, limit: 3000, resets_at: new Date(Date.now() + 31 * 86400000).toISOString() } } });
    if (p.includes("/receiving/")) return Response.json({ object: "email", id: p.split("/").pop(), from: "Cliente Ensaio <cliente@example.test>", to: ["suporte@zevanory.api.br"], subject: "Ensaio: não recebi o acesso", text: "mensagem sintética do ensaio", html: null, attachments: [], created_at: new Date().toISOString(), message_id: "<ensaio@example.test>", headers: {} });
    if (p === "/emails" && method === "GET") return Response.json({ object: "list", data: mailbox, has_more: false });
    const hit = mailbox.find((x) => p.endsWith("/" + x.id));
    if (hit) return Response.json(hit);
    return Response.json({ object: "list", data: [], has_more: false });
  }
  return new Response(JSON.stringify({ ensaio: "blocked" }), { status: 503, headers: { "content-type": "application/json" } });
}
globalThis.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input));
  const headers = new Headers(init.headers || req?.headers || {});
  const neonConn = headers.get("neon-connection-string") || "";
  const isNeon = url.hostname.endsWith(".neon.tech") && (url.hostname === branchHost || neonConn.includes("@" + branchHost + "/") || neonConn.includes("@" + branchHost + ":"));
  if (isNeon) { neonCalls++; return realFetch(input, init); }
  if (url.hostname.endsWith(".neon.tech")) { out.network.blocked.push("neon_other_host"); throw new Error("ensaio_blocked_other_neon_host"); }
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  return fakeExternal(url, init);
};

const { default: worker } = await import("../../worker/cloudflare-worker.compat.mjs");
const { whatsappProofDatabase } = await import("../../worker/cloudflare-worker.recovered.mjs");
const { runDataBackup } = await import("../../worker/data-backup.mjs");
const sql = whatsappProofDatabase(URL_DB);

// ---------- Ambiente sintético ----------
function memKv() {
  const m = new Map();
  return { m,
    async get(k, t) { const v = m.has(k) ? m.get(k) : null; if (v !== null && (t === "json" || t?.type === "json")) { try { return JSON.parse(v); } catch { return null; } } return v; },
    async put(k, v) { m.set(k, typeof v === "string" ? v : String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "", limit = 1000, cursor } = {}) { const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })); return { keys: keys.slice(0, limit), list_complete: true }; },
    async getWithMetadata(k) { return { value: m.has(k) ? m.get(k) : null, metadata: null }; } };
}
const kv = memKv();
const ADMIN_USER = "ensaio-" + randomBytes(4).toString("hex"), ADMIN_PASS = randomBytes(18).toString("hex");
const HOTTOK = "ensaio-hottok-" + randomBytes(8).toString("hex");
const RESEND_SECRET = "whsec_" + randomBytes(32).toString("base64");
const env = {
  DATABASE_URL: URL_DB,
  ZEVANORY_PRIVATE_ARTIFACTS: kv,
  ZEVANORY_ADMIN_USERNAME: ADMIN_USER, ZEVANORY_ADMIN_PASSWORD: ADMIN_PASS,
  HOTMART_HOTTOK: HOTTOK,
  RESEND_WEBHOOK_SECRET: RESEND_SECRET, RESEND_API_KEY: "ensaio-resend-sintetico", RESEND_RECEIVING_API_KEY: "ensaio-resend-leitura-sintetico",
  SUPPORT_FORWARD_TO: "dono-ensaio@example.test",
  LEAD_PRIVACY_SECRET: randomBytes(24).toString("hex"),
  PUBLIC_BASE_URL: "https://zevanory.api.br",
  AI: { async run() { return { response: "Resposta sintética do ensaio R1-B." }; } },
};
env.SELF = { fetch: (r) => worker.fetch(r instanceof Request ? r : new Request(r), env, ctx) };
const waits = [];
const ctx = { waitUntil(p) { waits.push(Promise.resolve(p).catch(() => null)); }, passThroughOnException() {} };
// Interruptor Hotmart aberto SÓ no KV em memória (para exercitar o caminho comercial com evento sintético).
await kv.put("sales:hotmart:v1", JSON.stringify({ channel: "hotmart", products: ["combo-ia-vendas", "ia-na-pratica", "lucro-e-caixa", "negocio-completo", "vendas-na-pratica"], enabled: true, authorization: "LIBERAR VENDAS", by: "ensaio-r1b", ref: "ensaio/sintetico", at: new Date().toISOString() }));

// ---------- Utilitários ----------
const logs = [];
for (const lvl of ["info", "error", "warn", "log"]) { const orig = console[lvl].bind(console); console[lvl] = (...a) => { logs.push(lvl + " " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ").slice(0, 300)); if (lvl === "log" && String(a[0]).startsWith("R1B_")) orig(...a); }; }
const count = async (t) => Number((await sql.query(`select count(*)::bigint n from ${t}`))[0].n);
const exists = async (t) => (await sql.query(`select to_regclass($1) is not null e`, ["public." + t]))[0].e === true;
async function step(id, area, fn) {
  const t0 = Date.now(), n0 = neonCalls, s0 = sent.length, l0 = logs.length;
  const rec = { id, area, pass: false };
  try { const r = await fn(); Object.assign(rec, r || {}); rec.pass = r?.pass !== false; }
  catch (e) { rec.pass = false; rec.error = String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, "[db]").slice(0, 240); }
  await Promise.all(waits.splice(0));
  rec.ms = Date.now() - t0; rec.neon_http_calls = neonCalls - n0;
  rec.simulated_external = sent.slice(s0).map((x) => `${x.method} ${x.host}${x.path}`).slice(0, 12);
  rec.logs = logs.slice(l0).filter((l) => !/^log /.test(l)).slice(0, 15);
  out.tests.push(rec);
}
const basic = "Basic " + Buffer.from(ADMIN_USER + ":" + ADMIN_PASS).toString("base64");
const ORIGIN = "https://zevanory.api.br";
const call = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, ctx);

// ---------- Testes ----------
await step("T00", "isolamento", async () => {
  const r = (await sql.query("select current_user u, current_database() d, current_setting('neon.timeline_id', true) tl"))[0];
  const tables = Number((await sql.query("select count(*)::int n from information_schema.tables where table_schema='public'"))[0].n);
  return { pass: r.u === "neondb_owner" && tables >= 100, current_user: r.u, database: r.d, timeline: r.tl, public_tables: tables };
});
const before = {};
for (const t of ["zevanory_owner_chat_messages", "zevanory_support_inbound", "zevanory_atendimento_outbox", "orders", "zevanory_funnel_daily", "agent_runs"]) { try { before[t] = await count(t); } catch (e) { before[t] = "erro"; } }
out.counts_before = before;

await step("T01", "health", async () => {
  const r = await call("/api/health"); const j = await r.json().catch(() => ({}));
  return { pass: r.status === 200 && j.ready === true && j.checks?.database_reachable === true && j.database_host_sha256 === sha(branchHost.replace("-pooler", "")), status: r.status, ready: j.ready, checks: j.checks, schema: j.schema };
});
await step("T02", "status", async () => {
  const r = await call("/api/status"); const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch {}
  return { pass: r.status === 200, status: r.status, keys: Object.keys(j).slice(0, 12), error: j.error || null };
});
await step("T03", "chat-autenticacao", async () => {
  const r = await call("/api/admin/owner-chat/feed");
  return { pass: r.status === 401, status_sem_credencial: r.status };
});
await step("T04", "chat-historico", async () => {
  const r = await call("/api/admin/owner-chat/feed", { headers: { authorization: basic } }); const j = await r.json();
  return { pass: r.status === 200 && Array.isArray(j.messages) && j.messages.length > 0, status: r.status, mensagens_no_feed: j.messages?.length ?? null };
});
let actionId = null;
await step("T05", "chat-mensagem-e-resposta", async () => {
  const n0 = await count("zevanory_owner_chat_messages");
  const post = (text) => call("/api/admin/owner-chat/message", { method: "POST", headers: { authorization: basic, origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const a = await post("status"); const ja = await a.json();
  const b = await post("pausar"); const jb = await b.json();
  actionId = (jb.messages || []).find((m) => m.action && m.action.state === "proposta")?.id || (jb.messages || []).find((m) => m.action)?.id || null;
  const n1 = await count("zevanory_owner_chat_messages");
  return { pass: a.status === 200 && b.status === 200 && n1 - n0 === 4 && !!actionId, status: [a.status, b.status], gravadas: n1 - n0, resposta_status: (ja.messages || [])[1]?.text?.slice(0, 80) || null, acao_proposta: !!actionId };
});
await step("T06", "chat-controle-de-acao", async () => {
  if (!actionId) return { pass: false, motivo: "sem_acao_proposta" };
  const act = () => call("/api/admin/owner-chat/action", { method: "POST", headers: { authorization: basic, origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json" }, body: JSON.stringify({ id: String(actionId) }) });
  const a = await act(); const b = await act();
  const lock = (await sql.query("select holder from zevanory_owner_chat_action_lock where k = 1"))[0];
  const pausa = await kv.get("zpc:creative-autonomy:paused:v1");
  return { pass: a.status === 200 && b.status === 409 && (lock ? lock.holder === null : true) && pausa === "1", status_1a_execucao: a.status, status_repeticao: b.status, trava_liberada: lock ? lock.holder === null : "sem_linha", efeito_no_kv_em_memoria: pausa };
});
await step("T07", "suporte-entrada-e-fila", async () => {
  const n0 = await count("zevanory_support_inbound");
  const id = "ensaio-em-" + randomBytes(4).toString("hex");
  const ev = { type: "email.received", created_at: new Date().toISOString(), data: { email_id: id, from: "Cliente Ensaio <cliente@example.test>", to: ["suporte@zevanory.api.br"], received_for: ["suporte@zevanory.api.br"], subject: "Ensaio: não recebi o acesso", message_id: "<ensaio@example.test>", attachments: [] } };
  const body = JSON.stringify(ev); const msgId = "msg_" + randomBytes(6).toString("hex"); const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", Buffer.from(RESEND_SECRET.slice(6), "base64")).update(`${msgId}.${ts}.${body}`).digest("base64");
  const bad = await call("/api/webhooks/resend", { method: "POST", headers: { "content-type": "application/json", "svix-id": msgId, "svix-timestamp": String(ts), "svix-signature": "v1,AAAA" }, body });
  const r = await call("/api/webhooks/resend", { method: "POST", headers: { "content-type": "application/json", "svix-id": msgId, "svix-timestamp": String(ts), "svix-signature": "v1," + sig }, body });
  const n1 = await count("zevanory_support_inbound");
  const row = (await sql.query("select state from zevanory_support_inbound where email_id = $1", [id]))[0];
  let rj = {}; try { rj = await r.clone().json(); } catch {}
  return { pass: bad.status >= 400 && r.status < 300 && n1 - n0 === 1 && !!row, assinatura_invalida: bad.status, status: r.status, resposta: rj, gravadas: n1 - n0, estado: row?.state || null, emails_simulados: mailbox.length };
});
await step("T08", "hotmart-webhook-sintetico", async () => {
  const txn = "HP-ENSAIO-R1B-" + randomBytes(4).toString("hex").toUpperCase();
  const body = JSON.stringify({ version: "2.0.0", event: "PURCHASE_APPROVED", data: { product: { id: 8704733 }, purchase: { transaction: txn, approved_date: Date.now(), price: { value: 97, currency_value: "BRL" } }, buyer: { email: "comprador@example.test", name: "Comprador Ensaio" } } });
  const bad = await call("/api/webhooks/hotmart", { method: "POST", headers: { "x-hotmart-hottok": "errado", "content-type": "application/json" }, body });
  const r = await call("/api/webhooks/hotmart", { method: "POST", headers: { "x-hotmart-hottok": HOTTOK, "content-type": "application/json" }, body });
  const again = await call("/api/webhooks/hotmart", { method: "POST", headers: { "x-hotmart-hottok": HOTTOK, "content-type": "application/json" }, body });
  const sales = [...kv.m.keys()].filter((k) => k.startsWith("zpc:sales:v1:ev:")).length;
  const fila = [...kv.m.keys()].filter((k) => k.startsWith("zpc:posvenda:hotmart:")).length;
  return { pass: bad.status === 401 && r.status === 200 && again.status === 200 && sales === 1 && fila >= 1, hottok_errado: bad.status, status: r.status, reenvio: again.status, vendas_registradas_kv: sales, chaves_posvenda_kv: fila };
});
const hourly = (h, m = 0) => { const d = new Date(); d.setUTCHours(h, m, 5, 0); return d.getTime(); };
async function cron(cronExpr, when) {
  let thrown = null;
  try { await worker.scheduled({ cron: cronExpr, scheduledTime: when }, env, ctx); } catch (e) { thrown = String(e?.message || e).slice(0, 120); }
  await Promise.all(waits.splice(0));
  return thrown;
}
await step("T09", "cron-horario-posvenda-1o-pedido", async () => {
  const thrown = await cron("0 * * * *", hourly(13));
  const cota = await exists("zevanory_posvenda_cota");
  const run = logs.filter((l) => l.includes("hotmart_post_sale_run")).at(-1) || "";
  const first = logs.filter((l) => l.includes("hotmart_first_order_alert_retry")).at(-1) || "";
  const dbErr = logs.filter((l) => /\[db\]|neon|database_unavailable|ECONN|fetch failed/i.test(l)).slice(0, 5);
  const d0 = sent.filter((x) => x.host === "api.resend.com" && x.method === "POST").length;
  const suporte = logs.filter((l) => l.includes("support_outbox")).at(-1) || "";
  return { pass: cota && /"ok":true/.test(run) && first.length > 0 && dbErr.length === 0, suporte_dreno: suporte.slice(0, 220), excecao: thrown, posvenda_cota_existe: cota, posvenda: run.slice(0, 200), primeiro_pedido: first.slice(0, 160), emails_simulados_resend: d0, erros_de_banco: dbErr };
});
for (const [id, expr, h, m] of [["T10", "5,35 * * * *", 13, 5], ["T11", "5,35 * * * *", 22, 35], ["T12", "15,45 * * * *", 13, 15]]) {
  await step(id, "cron " + expr + " @" + String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + "Z", async () => {
    const thrown = await cron(expr, hourly(h, m));
    const dbErr = logs.filter((l) => /\[db\]|neon_|database_unavailable|ECONN|fetch failed|relation .* does not exist|permission denied/i.test(l)).slice(0, 5);
    const publicacoes = sent.filter((x) => /bsky|telegram|youtube|facebook|instagram|indexnow|bing/.test(x.host)).length;
    // Exceções esperadas aqui são de PROVEDOR simulado (ex.: prova financeira sem Mercado Pago), não de banco.
    const banco = !thrown || !/db|database|neon|sql|relation|permission/i.test(thrown);
    return { pass: banco && dbErr.length === 0, excecao: thrown, erros_de_banco: dbErr, tentativas_de_publicacao_bloqueadas: publicacoes };
  });
}
await step("T13", "backup-diario", async () => {
  const key = randomBytes(32).toString("base64");
  const rep = await runDataBackup({ ...env, P20_BACKUP_KEY: key }, { sqlFactory: whatsappProofDatabase, now: Date.now() });
  return { pass: rep.ok === true, ok: rep.ok, failures: rep.failures, encryption: rep.encryption?.state, tabelas: rep.neon?.tables ? Object.keys(rep.neon.tables).length : (rep.neon?.tableCount ?? null), linhas: rep.neon?.rows ?? null, excluidas: rep.neon?.excluded ?? null };
});
out.counts_after = {};
for (const t of Object.keys(before)) { try { out.counts_after[t] = await count(t); } catch { out.counts_after[t] = "erro"; } }
out.network.neon = neonCalls;
out.network.simulated_external_total = sent.length;
out.network.simulated_by_host = sent.reduce((a, x) => ((a[x.host] = (a[x.host] || 0) + 1), a), {});
finish(out.tests.every((t) => t.pass) ? 0 : 1);
