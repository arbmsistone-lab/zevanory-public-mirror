// Chat do proprietário: sessão por PIN no PostgreSQL 16 REAL descartável (R1, R1.1, O1 — 26/11/2026).
// * O handler real (worker/owner-chat.mjs) roda em Node com um adaptador em que CADA consulta é um processo psql
//   próprio = conexão própria e autocommit, como o driver HTTP do Neon usado pelo Worker. Concorrência é real no servidor.
// * Ordem revogação × operação (R1.1) provada com transações seguradas de verdade (psql interativo) e com o
//   adaptador pausando o handler imediatamente antes da instrução de trabalho (feed, envio, reivindicação de ação).
// * Contraprovas efetivas: cópias MUTANTES do Worker (guarda removida, sem FOR SHARE, contador não atômico,
//   logout que ignora ações autorizadas) rodam os mesmos cenários e precisam REPROVAR.
// Sem rede, sem segredo, PIN fictício. Rodar: T4_PG_HOST=127.0.0.1 T4_PG_PORT=5432 node --test tests/integration/owner-chat-session-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, cpSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = "ci_owner_chat_session";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);
const ORIGIN = "https://zevanory.api.br";
const PIN = "482915";
const APP = "zv-owner-chat-app";
const PGENV = (app) => ({ ...process.env, PGAPPNAME: app, PGCONNECT_TIMEOUT: "5" });
const psqlArgs = (q, db = DB, port = PORT) => ["-h", HOST, "-p", port, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "--csv", "-c", q];
const lit = (v) => v === null || v === undefined ? "NULL" : typeof v === "boolean" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const BOOL_COLS = new Set(["live"]); // o driver do Neon devolve boolean; o CSV do psql devolve t/f
// Adaptador: uma conexão por consulta. `gate(tag, params)` permite pausar o handler logo antes de uma instrução.
function pg({ port = PORT, gate = null, db = DB } = {}) {
  const sql = {
    log: [],
    async query(q, params = []) {
      const tag = (q.match(/\/\*owner-chat:([a-z-]+)\*\//) || [])[1] || "ddl";
      if (gate) await gate(tag, params);
      sql.log.push(tag);
      const inl = q.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
      const { stdout } = await run("psql", psqlArgs(inl, db, port), { encoding: "utf8", maxBuffer: 1 << 24, env: PGENV(APP) });
      const rows = parseCsv(stdout.trim() ? stdout : "");
      if (!rows.length) return [];
      const [head, ...data] = rows;
      return data.map((r) => Object.fromEntries(head.map((h, i) => [h, BOOL_COLS.has(h) ? r[i] === "t" : r[i] === "" ? null : r[i]])));
    }
  };
  return sql;
}
const q1 = (q) => { const out = execFileSync("psql", psqlArgs(q), { encoding: "utf8", env: PGENV("zv-test") }).trim(); const [h, ...r] = parseCsv(out); return r.map((x) => Object.fromEntries(h.map((k, i) => [k, x[i]]))); };
const n1 = (q) => Number(Object.values(q1(q)[0] || { n: 0 })[0]);
const waiting = () => n1(`select count(*) as n from pg_stat_activity where application_name = '${APP}' and wait_event_type = 'Lock'`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000, step = 25) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(step); } return false; }

// Transação segurada de verdade: psql interativo; cada passo espera o marcador no stdout.
function holder() {
  const p = spawn("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t"], { env: PGENV("zv-holder") });
  let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
  let k = 0;
  const step = async (stmt) => { const m = "MARK" + (++k); p.stdin.write(stmt + "\n\\echo " + m + "\n"); assert.ok(await until(() => out.includes(m), 10000, 10), "holder: " + stmt + " → " + out); return out; };
  const end = async () => { p.stdin.end(); await new Promise((r) => p.on("close", r)); return out; };
  return { step, end };
}

function memKv() {
  const data = new Map(); let putGate = null;
  return { data, set putGate(g) { putGate = g; },
    get: async (k) => (data.has(k) ? data.get(k) : null),
    put: async (k, v) => { if (putGate && k === "zpc:creative-autonomy:paused:v1") await putGate(); data.set(k, String(v)); },
    delete: async (k) => { data.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...data.keys()].filter((x) => x.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
}

// Cópia mutante do Worker (nunca publicada): troca um trecho exato e exige que ele exista uma única vez.
function mutant(file, from, to) {
  const dir = mkdtempSync(join(tmpdir(), "zv-owner-mut-"));
  cpSync(join(ROOT, "worker"), join(dir, "worker"), { recursive: true });
  symlinkSync(join(ROOT, "data"), join(dir, "data"));
  const p = join(dir, "worker", file); const s = readFileSync(p, "utf8");
  assert.equal(s.split(from).length - 1, 1, "âncora do mutante " + file + ": " + from);
  writeFileSync(p, s.replace(from, to));
  return import(pathToFileURL(join(dir, "worker", "owner-chat.mjs")).href + "?m=" + Math.random());
}

let chat, sess, pin;
let ipSeq = 0;
function harness(mod = chat, { gate = null, port = PORT } = {}) {
  const kv = memKv(); const sql = pg({ port, gate });
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://isolado", OWNER_CHAT_PIN: PIN };
  const deps = { isAdminAuthorized: () => false, sqlFactory: () => sql, snapshot: async () => ({ day: "2026-11-26", today: [] }) };
  return { kv, sql, env, call: (r) => mod.handleOwnerChat(r, env, deps) };
}
const H = (extra = {}) => ({ origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json", ...extra });
const login = (h, value = PIN, ip = "10.9." + (ipSeq >> 8) + "." + (ipSeq++ & 255)) => h.call(new Request(ORIGIN + "/api/admin/owner-chat/pin", { method: "POST", body: JSON.stringify({ pin: value }), headers: H({ "cf-connecting-ip": ip }) }));
const cookieOf = (res) => res.headers.getSetCookie().find((c) => c.startsWith("zv_owner_chat=")).split(";")[0];
const feed = (h, c) => h.call(new Request(ORIGIN + "/api/admin/owner-chat/feed", { headers: { cookie: c } }));
const message = (h, c, text) => h.call(new Request(ORIGIN + "/api/admin/owner-chat/message", { method: "POST", body: JSON.stringify({ text }), headers: H({ cookie: c }) }));
const action = (h, c, id) => h.call(new Request(ORIGIN + "/api/admin/owner-chat/action", { method: "POST", body: JSON.stringify({ id }), headers: H({ cookie: c }) }));
const logout = (h, c) => h.call(new Request(ORIGIN + "/api/admin/owner-chat/logout", { method: "POST", body: "{}", headers: H({ cookie: c }) }));
async function session(h) { const r = await login(h); assert.equal(r.status, 200); const c = cookieOf(r); return { c, hash: await pin.sha256Hex(c.split("=")[1]) }; }
async function proposal(h, c) {
  q1(`update zevanory_owner_chat_action_lock set holder = null, since = null`);
  const r = await message(h, c, "pausar"); assert.equal(r.status, 200);
  return (await r.json()).messages.find((m) => m.action).id;
}
const ownerRows = (text) => n1(`select count(*) as n from zevanory_owner_chat_messages where sender = 'owner' and body = ${lit(text)}`);
const state = (id) => q1(`select action_state, action_session from zevanory_owner_chat_messages where id = ${Number(id)}`)[0];

before(async () => {
  if (SKIP) return;
  execFileSync("psql", psqlArgs(`drop database if exists ${DB}`, "postgres"), { env: PGENV("zv-test") });
  execFileSync("psql", psqlArgs(`create database ${DB}`, "postgres"), { env: PGENV("zv-test") });
  chat = await import(pathToFileURL(join(ROOT, "worker/owner-chat.mjs")).href);
  sess = await import(pathToFileURL(join(ROOT, "worker/owner-session.mjs")).href);
  pin = await import(pathToFileURL(join(ROOT, "worker/owner-pin.mjs")).href);
  const h = harness(); await login(h, "000000", "10.255.255.255"); // aplica o esquema como o Worker aplica
  q1(`delete from zevanory_owner_chat_pin_attempts`);
});

test("esquema: idempotente, não destrutivo (só create/alter if not exists), só hash de 64 hex, validade 12 h pelo relógio do banco", { skip: SKIP }, async () => {
  const h = harness();
  await sess.ensureSessionSchema(h.sql); await sess.ensureSessionSchema(pg()); // segunda aplicação, outra conexão
  const src = readFileSync(join(ROOT, "worker/owner-session.mjs"), "utf8");
  assert.doesNotMatch(src, /\b(drop|truncate)\b/i, "nenhuma migração destrutiva");
  assert.throws(() => q1(`insert into zevanory_owner_chat_sessions (token_sha256, expires_at) values ('nao-hex', now())`), /check/i);
  const { c, hash } = await session(h);
  const row = q1(`select token_sha256, extract(epoch from (expires_at - created_at))::int as ttl from zevanory_owner_chat_sessions where token_sha256 = ${lit(hash)}`)[0];
  assert.equal(row.ttl, "43200");
  assert.equal(n1(`select count(*) as n from zevanory_owner_chat_sessions where token_sha256 = ${lit(c.split("=")[1])}`), 0, "token puro nunca gravado");
  assert.equal((await feed(h, c)).status, 200);
  q1(`update zevanory_owner_chat_sessions set expires_at = now() + interval '2 seconds' where token_sha256 = ${lit(hash)}`);
  assert.equal((await feed(h, c)).status, 200);
  q1(`update zevanory_owner_chat_sessions set expires_at = now() - interval '1 second' where token_sha256 = ${lit(hash)}`);
  assert.equal((await feed(h, c)).status, 401, "expirada pelo relógio do banco");
});

test("gravações internas (sentinela, vigia, conciliação) funcionam num banco sem a tabela de sessões", { skip: SKIP }, async () => {
  execFileSync("psql", psqlArgs(`drop database if exists ${DB}_fresh`, "postgres"), { env: PGENV("zv-test") });
  execFileSync("psql", psqlArgs(`create database ${DB}_fresh`, "postgres"), { env: PGENV("zv-test") });
  const fresh = pg({ db: DB + "_fresh" });
  const m = await chat.insertOwnerMessage(fresh, { from: "zevanory", kind: "alerta", text: "aviso do vigia" });
  assert.equal(m?.text, "aviso do vigia");
  assert.equal(execFileSync("psql", psqlArgs(`select count(*) from information_schema.tables where table_name = 'zevanory_owner_chat_sessions'`, DB + "_fresh"), { encoding: "utf8" }).trim().split("\n").pop(), "0");
});

test("banco indisponível = acesso negado: login 503 sem cookie, leitura 401, logout 503 sem confirmar", { skip: SKIP }, async () => {
  const ok = harness(); const { c } = await session(ok);
  const down = harness(chat, { port: "1" }); // porta sem servidor: falha real de conexão
  const r = await login(down); assert.equal(r.status, 503); assert.equal(r.headers.getSetCookie().length, 0);
  assert.equal((await feed(down, c)).status, 401);
  const out = await logout(down, c); assert.equal(out.status, 503); assert.deepEqual(await out.json(), { ok: false, error: "revoke_unconfirmed" });
  assert.equal(out.headers.getSetCookie().length, 0);
  assert.equal((await feed(ok, c)).status, 200, "a sessão de fato continua válida");
});

// ---------- R1.1: revogação comprometida ENTRE a verificação e a instrução de trabalho ----------
async function revokeBetween(mod, tagWanted, op) {
  let fire = null; let hit = false;
  const gate = async (tag, params) => { if (!hit && tag === tagWanted && (tagWanted !== "insert" || params[0] === "owner")) { hit = true; await fire(); } };
  const h = harness(mod, { gate }); const base = harness(mod);
  const { c, hash } = await session(base);
  const id = await proposal(base, c);
  fire = async () => { const r = await logout(base, c); assert.equal(r.status, 200); assert.equal(n1(`select count(*) as n from zevanory_owner_chat_sessions where token_sha256 = ${lit(hash)} and revoked_at is not null`), 1); };
  const res = await op(h, c, id);
  assert.ok(hit, "o handler passou pela instrução " + tagWanted);
  return { res, id, hash };
}
async function scenarioRevokeBetween(mod) {
  const f = await revokeBetween(mod, "feed", (h, c) => feed(h, c));
  assert.equal(f.res.status, 401, "feed depois da revogação");
  const text = "status " + Math.random().toString(36).slice(2);
  const m = await revokeBetween(mod, "insert", (h, c) => message(h, c, text));
  assert.equal(m.res.status, 401, "envio depois da revogação"); assert.equal(ownerRows(text), 0, "nada gravado");
  const a = await revokeBetween(mod, "claim", (h, c, id) => action(h, c, id));
  assert.equal(a.res.status, 401, "ação depois da revogação"); assert.equal(state(a.id).action_state, "proposta", "ação não executada");
}
test("R1.1: revogação comprometida entre a verificação e a instrução de trabalho → feed, envio e ação recusados (401) e nada gravado", { skip: SKIP }, async () => {
  await scenarioRevokeBetween(chat);
});

// ---------- R1.1: revogação EM ANDAMENTO (transação segurada) quando a instrução de trabalho roda ----------
async function scenarioHeldRevoke(mod, { commit = true, tagWanted = "claim" } = {}) {
  const base = harness(mod); const { c, hash } = await session(base);
  const id = await proposal(base, c);
  const hd = holder(); let released = 0; let hit = false;
  const gate = async (tag, params) => {
    if (hit || tag !== tagWanted || (tagWanted === "insert" && params[0] !== "owner")) return;
    hit = true;
    await hd.step("begin;"); await hd.step(`update zevanory_owner_chat_sessions set revoked_at = now() where token_sha256 = ${lit(hash)} and revoked_at is null;`);
  };
  const h = harness(mod, { gate });
  const text = "status " + Math.random().toString(36).slice(2);
  const p = tagWanted === "claim" ? action(h, c, id) : tagWanted === "insert" ? message(h, c, text) : feed(h, c);
  let doneAt = 0; p.then(() => { doneAt = Date.now(); });
  const blocked = await until(() => waiting() >= 1, 6000);
  await sleep(300);
  const earlyDone = doneAt !== 0;
  released = Date.now(); await hd.step(commit ? "commit;" : "rollback;"); await hd.end();
  const res = await p;
  return { res, blocked, earlyDone, after: doneAt >= released, id, text };
}
test("R1.1: instrução de trabalho com revogação em andamento ESPERA a trava; COMMIT → 401 e nada feito; ROLLBACK → segue normalmente", { skip: SKIP }, async () => {
  for (const tagWanted of ["claim", "insert", "feed"]) {
    const r = await scenarioHeldRevoke(chat, { commit: true, tagWanted });
    assert.ok(r.blocked && !r.earlyDone && r.after, tagWanted + ": esperou a revogação");
    assert.equal(r.res.status, 401, tagWanted + ": revogação comprometida antes → recusado");
    if (tagWanted === "claim") assert.equal(state(r.id).action_state, "proposta");
    if (tagWanted === "insert") assert.equal(ownerRows(r.text), 0);
    const k = await scenarioHeldRevoke(chat, { commit: false, tagWanted });
    assert.ok(k.blocked && k.after, tagWanted + ": esperou também no rollback");
    assert.equal(k.res.status, 200, tagWanted + ": revogação desfeita → operação válida");
  }
});

// ---------- R1.1: operação EM ANDAMENTO quando o logout chega ----------
async function scenarioOpBeforeLogout(mod) {
  const h = harness(mod); const { c, hash } = await session(h);
  const id = await proposal(h, c);
  // 1) Instrução de trabalho segurada (mesma condição da reivindicação): o logout precisa esperar o commit.
  const hd = holder();
  await hd.step("begin;");
  await hd.step(`update zevanory_owner_chat_messages set action_state = 'executando', action_session = ${lit(hash)} where id = ${Number(id)} and action_state = 'proposta' and ${sess.SESSION_VALID_SQL(1).replace("$1", lit(hash))};`);
  const t0 = Date.now(); let doneAt = 0;
  const p = logout(h, c).then((r) => { doneAt = Date.now(); return r; });
  const blocked = await until(() => waiting() >= 1, 6000);
  await sleep(300); const early = doneAt !== 0;
  const committedAt = Date.now(); await hd.step("commit;"); await hd.end();
  const out = await p; const body = await out.json();
  // 2) Efeito externo da ação já autorizada ainda em curso: o logout informa, não afirma que interrompeu.
  q1(`update zevanory_owner_chat_messages set action_state = 'proposta', action_session = null where id = ${Number(id)}`);
  const h2 = harness(mod); const s2 = await session(h2);
  let open; const gateDone = new Promise((r) => { open = r; }); h2.kv.putGate = () => gateDone;
  const act = action(h2, s2.c, id);
  assert.ok(await until(() => state(id).action_state === "executando"), "ação reivindicada");
  const out2 = await logout(h2, s2.c); const body2 = await out2.json();
  open(); const ar = await act;
  return { blocked, early, waitedForCommit: doneAt >= committedAt, body, body2, actionStatus: ar.status, finalState: state(id), t0 };
}
test("R1.1: logout com operação já autorizada em curso espera o commit e informa as ações pendentes; a ação termina e é conciliada", { skip: SKIP }, async () => {
  const r = await scenarioOpBeforeLogout(chat);
  assert.ok(r.blocked && !r.early && r.waitedForCommit, "logout esperou a instrução segurada");
  assert.deepEqual(r.body, { ok: true, revoked: true, pending_actions: 1 });
  assert.deepEqual(r.body2, { ok: true, revoked: true, pending_actions: 1 });
  assert.equal(r.actionStatus, 200, "ação autorizada antes do logout termina (não é falsamente dada como interrompida)");
  assert.equal(r.finalState.action_state, "executado");
});

// ---------- Corrida real: logout × leitura × envio × ação, várias rodadas ----------
test("corrida real: depois do logout confirmado nada mais passa; envio 200 ⇔ linha gravada; ações pendentes informadas = ações reivindicadas pela sessão", { skip: SKIP }, async () => {
  const outcomes = { pending0: 0, pending1: 0, okBefore: 0, refused: 0 };
  for (let round = 0; round < 12; round++) {
    const h = harness(); const { c, hash } = await session(h);
    const id = await proposal(h, c);
    let open; const g = new Promise((r) => { open = r; }); h.kv.putGate = () => g;
    const texts = Array.from({ length: 4 }, (_, i) => `status r${round} m${i} ${Math.random().toString(36).slice(2)}`);
    const jitter = () => sleep(Math.floor(Math.random() * 1600));
    let confirmedAt = Infinity; let pending = null;
    const ops = [
      ...texts.map((t) => jitter().then(async () => { const s = Date.now(); const r = await message(h, c, t); return { kind: "msg", t, s, status: r.status }; })),
      ...[0, 1, 2].map(() => jitter().then(async () => { const s = Date.now(); const r = await feed(h, c); return { kind: "feed", s, status: r.status }; })),
      jitter().then(async () => { const s = Date.now(); const r = action(h, c, id); return { kind: "act", s, r }; }),
    ];
    const out = await (async () => { await sleep(300 + Math.floor(Math.random() * 900)); const r = await logout(h, c); confirmedAt = Date.now(); const b = await r.json(); pending = b.pending_actions; return b; })();
    assert.equal(out.revoked, true);
    const claimedBySession = n1(`select count(*) as n from zevanory_owner_chat_messages where id = ${Number(id)} and action_session = ${lit(hash)}`);
    assert.equal(pending, claimedBySession, `rodada ${round}: ações pendentes informadas = reivindicadas pela sessão`);
    outcomes["pending" + pending]++;
    // Depois da confirmação: qualquer nova operação é recusada.
    assert.equal((await feed(h, c)).status, 401); assert.equal((await message(h, c, "status x")).status, 401);
    open();
    const res = await Promise.all(ops);
    for (const o of res) {
      if (o.kind === "msg") { assert.ok([200, 401].includes(o.status)); assert.equal(ownerRows(o.t), o.status === 200 ? 1 : 0, "envio 200 ⇔ gravado"); if (o.s > confirmedAt) assert.equal(o.status, 401); }
      if (o.kind === "feed") { assert.ok([200, 401].includes(o.status)); if (o.s > confirmedAt) assert.equal(o.status, 401); }
      if (o.kind === "act") { const st = (await o.r).status; assert.ok([200, 401, 409].includes(st), "ação: " + st); if (st === 200) assert.equal(claimedBySession, 1); if (claimedBySession === 0) assert.equal(state(id).action_state, "proposta"); }
      if (o.status === 200) outcomes.okBefore++; else if (o.status === 401) outcomes.refused++;
    }
  }
  console.log("OWNER_CHAT_PG_RACE " + JSON.stringify(outcomes));
  assert.ok(outcomes.okBefore > 0 && outcomes.refused > 0, "a corrida produziu os dois lados");
});

// ---------- O1: tentativas de PIN concorrentes ----------
async function scenarioPinConcurrency(mod) {
  q1(`delete from zevanory_owner_chat_pin_attempts`);
  const h = harness(mod);
  const same = await Promise.all(Array.from({ length: 30 }, () => login(h, "000000", "10.1.1.1")));
  const ip = { e401: same.filter((r) => r.status === 401).length, e429: same.filter((r) => r.status === 429).length, n: q1(`select n from zevanory_owner_chat_pin_attempts where scope = 'ip'`)[0]?.n };
  q1(`delete from zevanory_owner_chat_pin_attempts`);
  const many = await Promise.all(Array.from({ length: 40 }, (_, i) => login(h, "000000", "10.2.0." + i)));
  const g = { e401: many.filter((r) => r.status === 401).length, e429: many.filter((r) => r.status === 429).length };
  return { ip, g };
}
test("O1: 30 tentativas simultâneas do mesmo IP → exatamente 5 comparadas; 40 de IPs distintos → exatamente 20; expiração; banco fora = 503", { skip: SKIP }, async () => {
  const { ip, g } = await scenarioPinConcurrency(chat);
  assert.deepEqual(ip, { e401: 5, e429: 25, n: "5" }, "bloqueadas não contam");
  assert.deepEqual(g, { e401: 20, e429: 20 });
  const h = harness();
  assert.equal((await login(h, PIN, "10.2.0.99")).status, 429, "limite global (20/h) bloqueia até o PIN certo");
  q1(`update zevanory_owner_chat_pin_attempts set k = '2000-01-01T00' where scope = 'global'`);
  assert.equal((await login(h, PIN, "10.2.0.98")).status, 200, "hora UTC seguinte: nova janela global");
  q1(`delete from zevanory_owner_chat_pin_attempts`);
  for (let i = 0; i < 5; i++) assert.equal((await login(h, "000000", "10.1.1.1")).status, 401);
  assert.equal((await login(h, PIN, "10.1.1.1")).status, 429, "IP bloqueado");
  const ipKey = q1(`select k from zevanory_owner_chat_pin_attempts where scope = 'ip'`)[0].k;
  q1(`update zevanory_owner_chat_pin_attempts set last_at = now() - interval '14 minutes' where scope = 'ip' and k = ${lit(ipKey)}`);
  assert.equal((await login(h, PIN, "10.1.1.1")).status, 429, "14 min: ainda bloqueado (a tentativa bloqueada não renova a janela)");
  q1(`update zevanory_owner_chat_pin_attempts set last_at = now() - interval '15 minutes 1 second' where scope = 'ip' and k = ${lit(ipKey)}`);
  assert.equal((await login(h, PIN, "10.1.1.1")).status, 200, "15 min depois da última tentativa contada");
  assert.equal(q1(`select n from zevanory_owner_chat_pin_attempts where scope = 'ip' and k = ${lit(ipKey)}`)[0].n, "0", "PIN certo devolveu a reserva");
  assert.equal((await login(harness(chat, { port: "1" }), PIN, "10.3.3.3")).status, 503);

  // Uma devolução da janela anterior espera no PostgreSQL até a renovação fazer commit.
  // Exercita a contabilidade diretamente, sem autenticar nem comparar nenhum PIN.
  const windowIp = "window-isolation-fixture";
  const oldReservation = await sess.reserveAttempt(h.sql, windowIp);
  const wall = holder();
  let renewed, release;
  try {
    await wall.step(`begin; update zevanory_owner_chat_pin_attempts
      set last_at = now() - interval '16 minutes' where scope = 'ip' and k = ${lit(windowIp)};`);
    renewed = sess.reserveAttempt(h.sql, windowIp);
    assert.ok(await until(() => waiting() === 1), "reserva posterior aguarda a trava da linha");
    release = sess.releaseAttempt(h.sql, windowIp, oldReservation);
    assert.ok(await until(() => waiting() === 2), "devolução aguarda atrás da reserva posterior");
    await wall.step("commit;");
    const reservation = await renewed;
    await release;
    assert.notEqual(reservation.ipWindowId, oldReservation.ipWindowId);
    assert.equal(n1(`select n from zevanory_owner_chat_pin_attempts where scope = 'ip' and k = ${lit(windowIp)}`), 1);
    await sess.releaseAttempt(h.sql, windowIp, reservation);
    assert.equal(n1(`select n from zevanory_owner_chat_pin_attempts where scope = 'ip' and k = ${lit(windowIp)}`), 0);
    console.log("OWNER_CHAT_PG_WINDOW_ISOLATION=PASS");
  } finally {
    await wall.end();
    await Promise.allSettled([renewed, release]);
  }
});

// ---------- Contraprovas efetivas (cópias mutantes do Worker contra o mesmo PostgreSQL) ----------
const rejects = async (fn, label) => { let failed = false; try { await fn(); } catch (e) { failed = e instanceof assert.AssertionError; if (!failed) throw e; console.log("OWNER_CHAT_PG_COUNTERPROOF " + label + " assert: " + String(e.message).split("\n")[0]); } assert.ok(failed, "contraprova sem efeito: " + label); console.log("OWNER_CHAT_PG_COUNTERPROOF " + label + "=DETECTED"); };
test("contraprovas: guarda removida da reivindicação, do envio e da leitura; sem FOR SHARE; logout que ignora ações autorizadas; contador não atômico — todas detectadas", { skip: SKIP }, async () => {
  const claimOff = await mutant("owner-chat.mjs", "and action_expires_at > now() and ($2::text is null or ${SESSION_VALID_SQL(2)}) returning action_type", "and action_expires_at > now() returning action_type");
  await rejects(() => scenarioRevokeBetween(claimOff), "claim-sem-guarda");
  const insertOff = await mutant("owner-chat.mjs", "${session === null ? \"\" : `where ${SESSION_VALID_SQL(7)}`}", "");
  await rejects(async () => { const m = await revokeBetween(insertOff, "insert", (h, c) => message(h, c, "status mut")); assert.equal(m.res.status, 401); }, "envio-sem-guarda");
  const feedOff = await mutant("owner-chat.mjs", "where ($2::text is null or ${SESSION_VALID_SQL(2)}) order by seq desc limit $1", "where ($2::text is null or true) order by seq desc limit $1");
  await rejects(async () => { const f = await revokeBetween(feedOff, "feed", (h, c) => feed(h, c)); assert.equal(f.res.status, 401); }, "leitura-sem-guarda");
  const noShare = await mutant("owner-session.mjs", "and expires_at > now() for share)`;", "and expires_at > now())`;");
  await rejects(async () => { const r = await scenarioHeldRevoke(noShare, { commit: true, tagWanted: "claim" }); assert.ok(r.blocked && !r.earlyDone && r.after); assert.equal(r.res.status, 401); }, "sem-for-share");
  const noPending = await mutant("owner-session.mjs", "pendingActions = Number(p[0]?.n || 0);", "pendingActions = 0;");
  await rejects(async () => { const r = await scenarioOpBeforeLogout(noPending); assert.equal(r.body.pending_actions, 1); }, "logout-ignora-acoes");
  const racy = await mutant("owner-session.mjs", "export async function reserveAttempt(sql, ipHash) {", `export async function reserveAttempt(sql, ipHash) {
  const cur = await sql.query(\`/*owner-chat:pin-mut-read*/ select coalesce((select n from zevanory_owner_chat_pin_attempts where scope = 'ip' and k = $1), 0)::int as i, coalesce((select n from zevanory_owner_chat_pin_attempts where scope = 'global' and k = to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24')), 0)::int as g\`, [ipHash]);
  const i = Number(cur[0].i) + 1, g = Number(cur[0].g) + 1;
  await sql.query(\`/*owner-chat:pin-mut-write*/ insert into zevanory_owner_chat_pin_attempts (scope, k, n, last_at) values ('ip', $1, $2::integer, now()), ('global', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24'), $3::integer, now()) on conflict (scope, k) do update set n = excluded.n, last_at = now()\`, [ipHash, i, g]);
  return { ipN: i, globalN: g, globalKey: "" };
}
async function reserveAttemptOriginal(sql, ipHash) {`);
  await rejects(async () => { const { ip, g } = await scenarioPinConcurrency(racy); assert.deepEqual(ip, { e401: 5, e429: 25, n: "5" }); assert.deepEqual(g, { e401: 20, e429: 20 }); }, "contador-nao-atomico");
});

// 27/11: passe do painel de uso único no PostgreSQL REAL (linha-marcador já revogada, chave primária atômica).
test("passe do painel: 20 trocas simultâneas do mesmo passe = exatamente 1 sessão; marcador nunca vale; 5 min pelo relógio do banco; passe anterior à saída não reabre", { skip: SKIP }, async () => {
  const h = harness();
  const bridge = await import(pathToFileURL(join(ROOT, "worker/owner-panel-bridge.mjs")).href);
  const key = "k".repeat(48); h.env.OWNER_OAUTH_BRIDGE_SECRET = key;
  const t0 = { ts: String(Date.now()), nonce: "pg".padEnd(43, "q"), exp: String(Date.now() + 3600_000), sid: "p".repeat(43) };
  const t = { ...t0, sig: await bridge.ticketSignature(key, t0) };
  const call = () => h.call(new Request(ORIGIN + bridge.PANEL_SESSION_PATH, { method: "POST", body: JSON.stringify(t), headers: { origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json" } }));
  const rs = await Promise.all(Array.from({ length: 20 }, call));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, "um único sucesso");
  assert.equal(rs.filter((r) => r.status === 401).length, 19, "19 reusos recusados");
  const marker = await pin.sha256Hex("panel-ticket:" + t.nonce);
  assert.equal(n1(`select count(*) as n from zevanory_owner_chat_sessions where token_sha256 = ${lit(marker)} and revoked_at is not null`), 1, "marcador gravado já revogado");
  assert.equal(await sess.checkSession(pg(), marker), false, "marcador nunca é sessão válida");
  const c = rs.find((r) => r.status === 200).headers.getSetCookie().find((x) => x.startsWith("zv_owner_chat=")).split(";")[0];
  const hash = await pin.sha256Hex(c.split("=")[1]);
  assert.equal(q1(`select extract(epoch from (expires_at - created_at))::int as ttl from zevanory_owner_chat_sessions where token_sha256 = ${lit(hash)}`)[0].ttl, "300", "5 min");
  assert.equal((await feed(h, c)).status, 200);
  // Passe emitido antes da saída, ainda não usado: depois do logout (com o cookie da sessão do painel) não reabre nada.
  const t1 = { ts: String(Date.now()), nonce: "pg2".padEnd(43, "q"), exp: t0.exp, sid: t0.sid }; const early = { ...t1, sig: await bridge.ticketSignature(key, t1) };
  const out = await h.call(new Request(ORIGIN + "/api/admin/owner-chat/logout", { method: "POST", body: "{}", headers: { origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json", cookie: c + "; zv_owner_chat_sid=" + t0.sid } }));
  const ob = await out.json(); assert.equal(out.status, 200); assert.equal(ob.panel_session_ended, true, "sessão do painel encerrada no chat");
  assert.equal((await feed(h, c)).status, 401, "sessão do chat revogada na hora");
  const validBefore = n1(`select count(*) as n from zevanory_owner_chat_sessions where revoked_at is null and expires_at > now()`);
  const replay = await h.call(new Request(ORIGIN + bridge.PANEL_SESSION_PATH, { method: "POST", body: JSON.stringify(early), headers: { origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json" } }));
  assert.equal(replay.status, 401, "passe anterior à saída recusado"); assert.deepEqual(await replay.json(), { error: "panel_session_ended" });
  assert.equal(n1(`select count(*) as n from zevanory_owner_chat_sessions where revoked_at is null and expires_at > now()`), validBefore, "o passe anterior não criou sessão válida");
});
