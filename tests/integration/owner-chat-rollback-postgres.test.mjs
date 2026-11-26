// Chat do proprietário — R1.2: migração e rollback seguros, em ambiente isolado (PostgreSQL 16 real + KV em memória
// que, como o Workers KV, NÃO volta junto num rollback de versão). Três builds reais:
//   PROD = worker/ exatamente como em produção (commit 813870c2, sessão no KV), extraído do git;
//   A    = candidato com SESSION_AUTHORITY="maintenance" (fase A: nega toda sessão por PIN e apaga as sessões do KV);
//   B    = candidato como está (SESSION_AUTHORITY="postgres").
// Cada "deploy" é uma cópia nova (isolate novo). Prova: tokens antigos do KV nunca voltam a valer (nem em rollback
// para PROD), rollback B→A fecha o chat (nenhuma autoridade dupla), revogações feitas em B sobrevivem a A e voltam
// valendo no roll-forward, e nada é apagado no banco. Sem rede, sem segredo, PIN fictício.
// Rodar: T4_PG_HOST=127.0.0.1 T4_PG_PORT=5432 [PROD_WORKER_SHA=813870c2] node --test tests/integration/owner-chat-rollback-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdtempSync, cpSync, symlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const PROD_SHA = process.env.PROD_WORKER_SHA || "813870c2";
const DB = "ci_owner_chat_rollback";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);
const ORIGIN = "https://zevanory.api.br", PIN = "482915";
const psqlArgs = (q, db = DB) => ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "--csv", "-c", q];
const lit = (v) => v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
function csv(out) { const lines = out.trim() ? out.trim().split("\n") : []; if (!lines.length) return []; const h = lines[0].split(","); return lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [h[i], v === "" ? null : v]))); }
const sql = { async query(q, params = []) { const inl = q.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1])); const { stdout } = await run("psql", psqlArgs(inl), { encoding: "utf8", maxBuffer: 1 << 24 }); return csv(stdout); } };
const q1 = (q) => csv(execFileSync("psql", psqlArgs(q), { encoding: "utf8" }));

// KV compartilhado entre versões (o rollback de versão do Worker não desfaz o KV).
const kvData = new Map();
const kv = { data: kvData, get: async (k) => (kvData.has(k) ? kvData.get(k) : null), put: async (k, v) => { kvData.set(k, String(v)); }, delete: async (k) => { kvData.delete(k); },
  list: async ({ prefix = "" } = {}) => ({ keys: [...kvData.keys()].filter((x) => x.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
const LEGACY = "zpc:owner-chat:pin-session:v1:";
const legacyKeys = () => [...kvData.keys()].filter((k) => k.startsWith(LEGACY)).length;

let prodDir;
function deploy(kind) {
  const dir = mkdtempSync(join(tmpdir(), "zv-owner-" + kind + "-"));
  if (kind === "PROD") { cpSync(prodDir, dir, { recursive: true }); }
  else { cpSync(join(ROOT, "worker"), join(dir, "worker"), { recursive: true }); symlinkSync(join(ROOT, "data"), join(dir, "data")); }
  if (kind === "A-sem-purga") {
    const p = join(dir, "worker/owner-chat.mjs"); const s = readFileSync(p, "utf8");
    const from = "if (pinConfigured(env)) { try { await purgeLegacyKvSessions("; assert.equal(s.split(from).length - 1, 1);
    writeFileSync(p, s.replace(from, "if (false) { try { await purgeLegacyKvSessions("));
  }
  if (kind === "A" || kind === "A-sem-purga") {
    const p = join(dir, "worker/owner-session.mjs"); const s = readFileSync(p, "utf8");
    const from = 'export const SESSION_AUTHORITY = "postgres";'; assert.equal(s.split(from).length - 1, 1);
    writeFileSync(p, s.replace(from, 'export const SESSION_AUTHORITY = "maintenance";'));
  }
  return import(pathToFileURL(join(dir, "worker/owner-chat.mjs")).href).then((mod) => {
    const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://isolado", OWNER_CHAT_PIN: PIN };
    const deps = { isAdminAuthorized: () => false, sqlFactory: () => sql, snapshot: async () => ({ day: "2026-11-26", today: [] }) };
    return { kind, call: (r) => mod.handleOwnerChat(r, env, deps) };
  });
}
const H = (extra = {}) => ({ origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json", ...extra });
let ip = 0;
const login = (w) => w.call(new Request(ORIGIN + "/api/admin/owner-chat/pin", { method: "POST", body: JSON.stringify({ pin: PIN }), headers: H({ "cf-connecting-ip": "10.7.0." + (ip++) }) }));
const cookieOf = (res) => res.headers.getSetCookie().find((c) => c.startsWith("zv_owner_chat=")).split(";")[0];
const feed = (w, c) => w.call(new Request(ORIGIN + "/api/admin/owner-chat/feed", { headers: { cookie: c } }));
const logout = (w, c) => w.call(new Request(ORIGIN + "/api/admin/owner-chat/logout", { method: "POST", body: "{}", headers: H({ cookie: c }) }));
const page = async (w, c) => { const r = await w.call(new Request(ORIGIN + "/admin/proprietario", { headers: { cookie: c } })); return r.status === 200 && /PIN de 6 dígitos/.test(await r.text()) ? "PIN" : String(r.status); };

before(() => {
  if (SKIP) return;
  execFileSync("psql", psqlArgs(`drop database if exists ${DB}`, "postgres"));
  execFileSync("psql", psqlArgs(`create database ${DB}`, "postgres"));
  prodDir = mkdtempSync(join(tmpdir(), "zv-owner-prod-src-"));
  execFileSync("bash", ["-c", `git -C "${ROOT}" archive ${PROD_SHA} worker data | tar -x -C "${prodDir}"`]);
  const full = execFileSync("git", ["-C", ROOT, "rev-parse", PROD_SHA], { encoding: "utf8" }).trim();
  console.log("OWNER_CHAT_ROLLBACK_PROD_SHA=" + full);
  assert.match(readFileSync(join(prodDir, "worker/owner-pin.mjs"), "utf8"), /pin-session:v1:/, "PROD guarda a sessão no KV");
});

test("R1.2: PROD → A → (rollback PROD) → A → B → (rollback A) → B: tokens antigos nunca revivem, sem autoridade dupla, revogações preservadas", { skip: SKIP }, async () => {
  const log = [];
  // 1) PROD (sessão no KV): dois tokens antigos válidos.
  let w = await deploy("PROD");
  const old1 = cookieOf(await login(w)), old2 = cookieOf(await login(w));
  assert.equal((await feed(w, old1)).status, 200); assert.equal(legacyKeys(), 2);
  log.push(["PROD", "tokens antigos", 2, "válidos"]);
  // 2) Fase A: nenhuma sessão por PIN vale; as sessões antigas são apagadas do KV no primeiro pedido.
  w = await deploy("A");
  assert.equal((await feed(w, old1)).status, 401); assert.equal(legacyKeys(), 0, "purga na fase A");
  assert.equal(await page(w, old2), "PIN");
  const la = await login(w); assert.equal(la.status, 503); assert.deepEqual(await la.json(), { error: "owner_chat_maintenance" });
  log.push(["A", "tokens antigos", 0, "apagados e recusados; login 503 manutenção"]);
  // 3) Rollback A → PROD (caminho desaconselhado, provado mesmo assim): os tokens antigos continuam mortos.
  w = await deploy("PROD");
  assert.equal((await feed(w, old1)).status, 401); assert.equal((await feed(w, old2)).status, 401);
  const oldAfter = cookieOf(await login(w)); // PROD aceita login novo no KV (é o comportamento dele)
  log.push(["PROD (rollback)", "tokens antigos", 0, "recusados; login novo no KV possível"]);
  // 4) A de novo (deploy novo = isolate novo): apaga também o token criado durante o rollback.
  w = await deploy("A");
  assert.equal((await feed(w, oldAfter)).status, 401); assert.equal(legacyKeys(), 0);
  // 5) Fase B: só o PostgreSQL vale; nada de KV.
  w = await deploy("B");
  assert.equal((await feed(w, old1)).status, 401); assert.equal((await feed(w, oldAfter)).status, 401);
  // Sessão antiga reaparecendo no KV (ex.: réplica atrasada de outro ponto de presença): B não a lê.
  const ghost = "a1".repeat(32); kvData.set(LEGACY + createHash("sha256").update(ghost).digest("hex"), "1");
  assert.equal((await feed(w, "zv_owner_chat=" + ghost)).status, 401, "B nunca lê sessão do KV");
  const b1 = cookieOf(await login(w)), b2 = cookieOf(await login(w));
  assert.equal(legacyKeys(), 1, "B não grava sessão no KV (só a chave fantasma)");
  w = await deploy("B"); // isolate novo: apaga o formato antigo de novo
  assert.equal((await feed(w, "zv_owner_chat=" + ghost)).status, 401); assert.equal(legacyKeys(), 0);
  assert.equal((await feed(w, b1)).status, 200); assert.equal((await feed(w, b2)).status, 200);
  const out = await logout(w, b1); assert.equal((await out.json()).revoked, true);
  assert.equal((await feed(w, b1)).status, 401);
  const rowsBefore = q1("select token_sha256, revoked_at, expires_at from zevanory_owner_chat_sessions order by token_sha256");
  log.push(["B", "sessões no banco", rowsBefore.length, "1 revogada, 1 válida"]);
  // 6) Rollback B → A: chat fechado para todos; nada no banco muda.
  w = await deploy("A");
  assert.equal((await feed(w, b1)).status, 401); assert.equal((await feed(w, b2)).status, 401); assert.equal(await page(w, b2), "PIN");
  assert.equal((await login(w)).status, 503);
  assert.deepEqual(q1("select token_sha256, revoked_at, expires_at from zevanory_owner_chat_sessions order by token_sha256"), rowsBefore, "A não altera nem apaga sessões");
  log.push(["A (rollback de B)", "sessões aceitas", 0, "chat fechado; banco intacto"]);
  // 7) Roll-forward A → B: a revogação continua valendo; a sessão não revogada (dentro das 12 h) volta a valer.
  w = await deploy("B");
  assert.equal((await feed(w, b1)).status, 401, "revogação preservada");
  assert.equal((await feed(w, b2)).status, 200);
  // 8) Rollback direto B → PROD (fora do plano): nenhuma sessão do banco nem token antigo vale no código antigo.
  w = await deploy("PROD");
  for (const c of [old1, old2, oldAfter, b1, b2]) assert.equal((await feed(w, c)).status, 401);
  log.push(["PROD (rollback direto de B)", "tokens antigos e do banco", 0, "todos recusados"]);
  // 9) Nenhuma migração destrutiva: as tabelas antigas do chat seguem intactas.
  assert.equal(q1("select count(*) as n from information_schema.columns where table_name = 'zevanory_owner_chat_messages' and column_name = 'action_session'")[0].n, "1");
  console.log("OWNER_CHAT_ROLLBACK_LOG " + JSON.stringify(log));
});

// Contraprova: uma fase A SEM a purga do KV deixaria o rollback para PROD ressuscitar o token antigo.
async function rollbackKeepsOldTokensDead(kindA) {
  kvData.clear();
  let w = await deploy("PROD"); const old = cookieOf(await login(w));
  assert.equal((await feed(w, old)).status, 200);
  w = await deploy(kindA); assert.equal((await feed(w, old)).status, 401);
  w = await deploy("PROD"); assert.equal((await feed(w, old)).status, 401, "token antigo continua morto após rollback");
}
test("R1.2 contraprova: fase A sem a purga do KV → rollback para PROD reativa o token antigo (detectado)", { skip: SKIP }, async () => {
  await rollbackKeepsOldTokensDead("A");
  let detected = false;
  try { await rollbackKeepsOldTokensDead("A-sem-purga"); } catch (e) { if (!(e instanceof assert.AssertionError)) throw e; detected = true; }
  assert.ok(detected, "contraprova sem efeito");
  console.log("OWNER_CHAT_ROLLBACK_COUNTERPROOF a-sem-purga=DETECTED");
});
