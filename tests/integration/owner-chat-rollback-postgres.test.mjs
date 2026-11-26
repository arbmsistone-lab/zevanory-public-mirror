// R1.2: usa o código arquivado da fase A e o candidato B, com PostgreSQL local.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleOwnerChat } from "../../worker/owner-chat.mjs";
import { OWNER_CHAT_RELEASE_PHASE } from "../../worker/owner-chat-release.mjs";
import { LEGACY_KV_SESSION_PREFIX } from "../../worker/owner-session.mjs";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PHASE_A_PIN = join(ROOT, "ops/owner-chat-phase-a.sha");
const DB = "ci_owner_chat_rollback";
const ORIGIN = "https://zevanory.api.br", PIN = "482915";
const run = promisify(execFile);
const args = (query, db = DB) => ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "--csv", "-c", query];
const psql = (query, db) => execFileSync("psql", args(query, db), { encoding: "utf8" });
const lit = (v) => v == null ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const sql = { async query(query, params = []) {
  const statement = query.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
  const { stdout } = await run("psql", args(statement), { encoding: "utf8" });
  const [header, ...rows] = stdout.trim().split("\n").map((line) => line.split(","));
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] || null])));
} };

let phaseADir, phaseAHandler;
function fixture(handler, phase, { deletionWorks = true, admin = false } = {}) {
  const oldToken = "a1".repeat(32);
  const legacyKey = LEGACY_KV_SESSION_PREFIX + createHash("sha256").update(oldToken).digest("hex");
  const data = new Map([[legacyKey, "test fixture"]]);
  const kv = {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => { data.set(key, value); },
    delete: async (key) => { if (deletionWorks) data.delete(key); },
    list: async ({ prefix }) => ({ keys: [...data.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://isolado", OWNER_CHAT_PIN: PIN };
  const deps = { sessionAuthority: phase, isAdminAuthorized: () => admin, sqlFactory: () => sql, snapshot: async () => ({ day: "2026-11-26", today: [] }) };
  return { call: (request) => handler(request, env, deps), oldCookie: "zv_owner_chat=" + oldToken, legacyPresent: () => data.has(legacyKey) };
}

const api = (name) => ORIGIN + "/api/admin/owner-chat/" + name;
const post = (name, body, cookie = "") => new Request(api(name), { method: "POST", body: JSON.stringify(body), headers: {
  origin: ORIGIN, "x-owner-chat": "1", "content-type": "application/json", cookie,
} });
const login = (w) => w.call(post("pin", { pin: PIN }));
const feed = (w, cookie) => w.call(new Request(api("feed"), { headers: { cookie } }));
const logout = (w, cookie) => w.call(post("logout", {}, cookie));
const rows = () => psql("select token_sha256, revoked_at, expires_at from zevanory_owner_chat_sessions order by token_sha256");

before(async () => {
  if (SKIP) return;
  psql(`drop database if exists ${DB}`, "postgres");
  psql(`create database ${DB}`, "postgres");
  const ref = existsSync(PHASE_A_PIN) ? readFileSync(PHASE_A_PIN, "utf8").trim() : execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  assert.match(ref, /^[0-9a-f]{40}$/);
  phaseADir = mkdtempSync(join(tmpdir(), "zv-owner-certified-maintenance-"));
  const archive = execFileSync("git", ["archive", ref, "worker", "data"], { cwd: ROOT, maxBuffer: 32 << 20 });
  execFileSync("tar", ["-x", "-C", phaseADir], { input: archive });
  const load = (file) => import(pathToFileURL(join(phaseADir, "worker", file)).href);
  assert.equal((await load("owner-chat-release.mjs")).OWNER_CHAT_RELEASE_PHASE, "maintenance");
  phaseAHandler = (await load("owner-chat.mjs")).handleOwnerChat;
  console.log("OWNER_CHAT_ROLLBACK_PHASE_A_SHA=" + ref);
});
after(() => { if (phaseADir) rmSync(phaseADir, { recursive: true, force: true }); });

test("R1.2: fase A exata fecha o chat e rollback B → A preserva a revogação", { skip: SKIP }, async () => {
  const a = fixture(phaseAHandler, "maintenance", { deletionWorks: false, admin: true });
  const response = await login(a);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "owner_chat_maintenance" });
  assert.equal((await feed(a, a.oldCookie)).status, 401);
  assert.equal((await logout(a, a.oldCookie)).status, 503);
  assert.ok(a.legacyPresent(), "o acesso continua fechado mesmo com a chave presente");
  assert.equal(psql("select to_regclass('zevanory_owner_chat_sessions') as sessions").trim(), "sessions");
  if (OWNER_CHAT_RELEASE_PHASE === "maintenance") return;

  const b = fixture(handleOwnerChat, "postgres", { deletionWorks: false });
  assert.equal((await feed(b, b.oldCookie)).status, 401);
  const auth = await login(b);
  assert.equal(auth.status, 200);
  const cookie = auth.headers.getSetCookie().find((value) => value.startsWith("zv_owner_chat=")).split(";")[0];
  assert.equal((await feed(b, cookie)).status, 200);
  assert.equal((await logout(b, cookie)).status, 200);
  const before = rows();
  assert.equal((await feed(a, cookie)).status, 401);
  assert.equal((await logout(a, cookie)).status, 503);
  assert.equal(rows(), before);
  assert.equal((await feed(b, cookie)).status, 401);
});

test("R1.2: a limpeza do KV é observável e independente do controle de acesso", { skip: SKIP }, async () => {
  const delayed = fixture(phaseAHandler, "maintenance", { deletionWorks: false });
  assert.equal((await feed(delayed, delayed.oldCookie)).status, 401);
  assert.ok(delayed.legacyPresent());
  // Isolate separado para testar a limpeza, que é tentada uma vez por isolate.
  const url = pathToFileURL(join(phaseADir, "worker", "owner-session.mjs"));
  url.search = "fresh-purge";
  const { purgeLegacyKvSessions } = await import(url.href);
  const kv = {
    list: async () => ({ keys: [{ name: LEGACY_KV_SESSION_PREFIX + "fixture" }], list_complete: true }),
    delete: async () => { throw new Error("KV unavailable"); },
  };
  await assert.rejects(() => purgeLegacyKvSessions(kv), /KV unavailable/);
  console.log("OWNER_CHAT_ROLLBACK_COUNTERPROOF a-sem-purga=DETECTED");
});
