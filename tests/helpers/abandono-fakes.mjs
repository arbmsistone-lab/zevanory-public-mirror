// Fakes locais do lembrete de abandono Hotmart (worker/abandono-hotmart.mjs). Sem rede, sem Cloudflare, sem Resend.
//  - createAbandonoD1: D1 que executa SQL de VERDADE (node:sqlite) com as migrações reais de migrations/d1. Cada
//    chamada cede a vez ao laço de eventos (setImmediate) ANTES de executar, como numa ida e volta de rede: execuções
//    em Promise.all intercalam instrução a instrução. Modos: lag (SELECT puro respondido por uma RÉPLICA atrasada,
//    gravações só no primário), falha total, falha por regex, resultado sem meta. withSession é um espião que lança.
//  - memKv: KV em memória com TTL (expirationTtl registrado), list por prefixo e contadores de leitura/gravação.
//  - fakeResend: POST /emails com Idempotency-Key como no Resend (mesma chave + mesmo corpo = mesma resposta sem novo
//    envio; corpo diferente = 409 invalid_idempotent_request), roteiro de respostas, GET /emails paginado (cursor
//    after, has_more) e GET /emails/{id} com tags.
//  - captureConsole: guarda as linhas de console.* durante a execução.
import { readTextNormalized } from "./text.mjs";

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite is an experimental feature/.test(String(w?.message ?? w)) ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = await import("node:sqlite").finally(() => { process.emitWarning = emit; });

const MIG = (f) => readTextNormalized(new URL("../../migrations/d1/" + f, import.meta.url));
export const MIGRATION_0003 = MIG("0003_abandono_v1.sql");
export const ALL_MIGRATIONS = ["0001_diario_v1.sql", "0002_diario_v1_ts.sql", "0003_abandono_v1.sql"].map(MIG).join("\n");
const isRead = (sql) => /^\s*(select|with|pragma)\b/i.test(sql) && !/\breturning\b/i.test(sql);
const tick = () => new Promise((r) => setImmediate(r));

export function createAbandonoD1({ migrations = ALL_MIGRATIONS, lag = false, yieldEach = true } = {}) {
  const primary = new DatabaseSync(":memory:");
  if (migrations) primary.exec(migrations);
  const replica = lag ? new DatabaseSync(":memory:") : null;
  if (replica && migrations) replica.exec(migrations);
  const log = []; // gravações ainda não replicadas
  const mode = { failAll: false, failOn: null, noMeta: false, delayOn: null, onWrite: null };
  const stats = { reads: 0, writes: 0, statements: [], sessions: 0, replicaReads: 0 };
  const exec = (db, sql, params) => {
    const st = db.prepare(sql);
    if (isRead(sql)) return { results: st.all(...params).map((r) => ({ ...r })), success: true, meta: { changes: 0 } };
    const r = st.run(...params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const execute = async (sql, params) => {
    if (yieldEach) await tick();
    if (mode.failAll) throw new Error("D1_ERROR: network connection lost (simulado)");
    if (mode.failOn && mode.failOn.test(sql)) throw new Error("D1_ERROR: falha simulada");
    stats.statements.push(sql.replace(/\s+/g, " ").trim());
    if (isRead(sql)) {
      stats.reads++;
      if (replica) { stats.replicaReads++; return exec(replica, sql, params); }
      return exec(primary, sql, params);
    }
    stats.writes++;
    if (mode.delayOn && mode.delayOn.re.test(sql)) await new Promise((r) => setTimeout(r, mode.delayOn.ms));
    const out = exec(primary, sql, params);
    if (mode.onWrite) mode.onWrite(sql);
    if (replica) log.push([sql, params]);
    if (mode.noMeta) return { results: [], success: true };
    return out;
  };
  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) {
      if (params.some((p) => p === undefined)) throw new TypeError("D1_TYPE_ERROR: undefined não é aceito em bind");
      return new Stmt(this.sql, params);
    }
    async first(col) { const row = (await execute(this.sql, this.params)).results[0] ?? null; return col ? (row ? row[col] ?? null : null) : row; }
    async all() { return execute(this.sql, this.params); }
    async run() { return execute(this.sql, this.params); }
  }
  return {
    primary, replica, mode, stats,
    prepare: (sql) => { if (mode.failAll) throw new Error("D1_ERROR: binding indisponível (simulado)"); return new Stmt(sql); },
    async batch(stmts) {
      if (yieldEach) await tick();
      if (mode.failAll) throw new Error("D1_ERROR: indisponível (simulado)");
      primary.exec("BEGIN");
      try { const out = stmts.map((s) => exec(primary, s.sql, s.params)); primary.exec("COMMIT"); return out; } catch (e) { primary.exec("ROLLBACK"); throw e; }
    },
    withSession() { stats.sessions++; throw new Error("withSession proibido no abandono (read replicas)"); },
    replicate() { if (!replica) return; for (const [sql, params] of log.splice(0)) exec(replica, sql, params); },
    rows: (table) => primary.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r })),
    sql: (text, ...params) => exec(primary, text, params),
  };
}

export function memKv() {
  const m = new Map(), ttl = new Map();
  const stats = { gets: 0, puts: 0, deletes: 0, lists: 0, putKeys: [], getKeys: [], deleteKeys: [] };
  const mode = { failPut: false, failGet: false, failAll: false, failDeleteOf: null };
  const guard = () => { if (mode.failAll) throw new Error("kv_down"); };
  return {
    m, ttl, stats, mode,
    async get(k) { guard(); if (mode.failGet) throw new Error("kv_get_down"); stats.gets++; stats.getKeys.push(k); return m.has(k) ? m.get(k) : null; },
    async put(k, v, o = {}) { guard(); if (mode.failPut) throw new Error("kv_put_down"); stats.puts++; stats.putKeys.push(k); m.set(k, String(v)); ttl.set(k, o?.expirationTtl ?? null); },
    async delete(k) { guard(); if (mode.failDeleteOf && mode.failDeleteOf.test(k)) throw new Error("kv_delete_down"); stats.deletes++; stats.deleteKeys.push(k); m.delete(k); ttl.delete(k); },
    async list({ prefix = "", limit = 1000 } = {}) { guard(); stats.lists++; const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })); return { keys, list_complete: true }; },
    writes: () => stats.puts + stats.deletes,
  };
}

const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// script: lista de comportamentos para os POST, na ordem: "accept" (padrão: Resend real), {status, name?}, "timeout",
// "accept_then_timeout" (aceita e envia, mas a resposta se perde). listing: {status?, filler:[...itens], pageSize}.
export function fakeResend({ script = [], listing = {}, retrieveStatus = 200, start = Date.UTC(2026, 10, 9, 13, 1) } = {}) {
  const keys = new Map(); // Idempotency-Key -> {bodySha, response}
  const delivered = []; // e-mails realmente "enviados"
  const posts = [], gets = [];
  let seq = 0;
  const filler = listing.filler || [];
  const pageSize = listing.pageSize || 100;
  const allItems = () => {
    const sent = delivered.map((d) => ({ id: d.id, to: d.body.to, subject: d.body.subject, created_at: d.created_at, from: d.body.from }));
    return [...sent, ...filler].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || "GET").toUpperCase();
    if (method === "POST" && u.pathname === "/emails") {
      const behavior = script.length ? script.shift() : "accept";
      const key = init.headers?.["Idempotency-Key"];
      const bodyText = String(init.body);
      posts.push({ key, body: JSON.parse(bodyText), behavior });
      if (behavior === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      if (behavior && typeof behavior === "object" && !behavior.deliver) return Response.json({ name: behavior.name || "application_error", message: "x" }, { status: behavior.status });
      const bodySha = await sha(bodyText);
      if (key && keys.has(key)) {
        const prev = keys.get(key);
        if (prev.bodySha !== bodySha) return Response.json({ name: "invalid_idempotent_request", message: "x" }, { status: 409 });
        return Response.json(prev.response, { status: 200 });
      }
      const id = "re-" + String(++seq).padStart(4, "0") + "-0000-4000-8000-abcdefabcdef";
      const created_at = new Date(start + seq * 1000).toISOString().replace("Z", "000+00:00");
      delivered.push({ id, body: JSON.parse(bodyText), created_at });
      const response = { id };
      if (key) keys.set(key, { bodySha, response });
      if (behavior && typeof behavior === "object" && behavior.deliver) return Response.json({ name: behavior.name, message: "x" }, { status: behavior.status });
      if (behavior === "accept_then_timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      return Response.json(response, { status: 200 });
    }
    if (method === "GET" && u.pathname === "/emails") {
      gets.push(u.pathname + u.search);
      if (listing.status && listing.status !== 200) return Response.json({ name: "restricted_api_key", message: "x" }, { status: listing.status });
      const items = allItems();
      const after = u.searchParams.get("after");
      const limit = Math.min(Number(u.searchParams.get("limit") || 20), pageSize);
      const from = after ? items.findIndex((i) => i.id === after) + 1 : 0;
      const data = items.slice(from, from + limit);
      const body = { object: "list", has_more: from + limit < items.length, data };
      if (listing.dropHasMore) delete body.has_more;
      return Response.json(body, { status: 200 });
    }
    if (method === "GET" && u.pathname.startsWith("/emails/")) {
      const id = decodeURIComponent(u.pathname.slice("/emails/".length));
      gets.push(u.pathname);
      if (retrieveStatus !== 200) return Response.json({ name: "not_found" }, { status: retrieveStatus });
      const d = delivered.find((x) => x.id === id);
      if (d) return Response.json({ object: "email", id, to: d.body.to, subject: d.body.subject, created_at: d.created_at, tags: d.body.tags, last_event: "delivered" }, { status: 200 });
      const f = filler.find((x) => x.id === id);
      if (f) return Response.json({ object: "email", id, to: f.to, subject: f.subject, created_at: f.created_at, tags: f.tags || [] }, { status: 200 });
      return Response.json({ name: "not_found" }, { status: 404 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, delivered, posts, gets, keys, script };
}

export function captureConsole() {
  const lines = [];
  const orig = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    orig[k] = console[k];
    console[k] = (...args) => { lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  }
  return { lines, restore() { for (const k of Object.keys(orig)) console[k] = orig[k]; } };
}
