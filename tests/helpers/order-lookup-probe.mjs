// Sonda R9 B / auditoria Sol 174 (sem rede, sem segredo real, sem banco real): executa o Worker REAL de produção
// (worker/cloudflare-worker.compat.mjs -> cloudflare-worker.recovered.mjs) e registra:
//   - a leitura de pedidos de PRODUÇÃO somente leitura GET /api/internal/audit/order-lookup, com e sem o piloto de
//     certificação no env (o resultado não pode depender do piloto);
//   - cada consulta ao "Neon" simulado (fetch para .../sql): corpo, cabeçalho Neon-Batch-Read-Only e texto SQL;
//   - a rota antiga do piloto /api/internal/certification/e2e/status, que deve continuar recusada (fail-closed).
// O Neon simulado só responde SELECT de pedidos a partir de um fixture fixo; qualquer outra consulta é registrada.
// Usada por tests/production-order-lookup.test.mjs. Rodar: node --import ./tests/t4_sim/register.mjs tests/helpers/order-lookup-probe.mjs
import http from "node:http";

const realFetch = globalThis.fetch;
let port = 0;
const ready = new Promise((resolve) => {
  const original = http.createServer;
  http.createServer = function probeCreateServer(...args) {
    const server = original.apply(this, args);
    server.keepAliveTimeout = 120_000;
    const listen = server.listen.bind(server);
    server.listen = () => listen(0, "127.0.0.1", () => { port = server.address().port; resolve(); });
    return server;
  };
});

export const ORDER_PRESENT = "1b2c3d4e-0000-4000-8000-00000000a001";
export const ORDER_PILOT = "1b2c3d4e-0000-4000-8000-00000000a002";
export const ORDER_MISSING = "1b2c3d4e-0000-4000-8000-00000000a0ff";
const FIXTURE = new Map([
  [ORDER_PRESENT, [ORDER_PRESENT, "197.00", "BRL", "paid", "mercadopago", "f"]],
  [ORDER_PILOT, [ORDER_PILOT, "5.00", "BRL", "refunded", "mercadopago", "t"]],
]);
const FIELDS = [["order_id", 25], ["amount", 25], ["currency", 25], ["status", 25], ["provider", 25], ["certification_pilot", 16]]
  .map(([name, dataTypeID]) => ({ name, dataTypeID }));

const sqlCalls = [];
const mpCalls = [];
const blocked = [];
function neonAnswer(body) {
  const one = (q) => {
    const text = String(q?.query || "");
    const ids = String(q?.params?.[0] || "").split(",");
    if (!/^select\b/i.test(text.trim()) || !/\bfrom orders\b/i.test(text)) return { fields: [], rows: [], command: "OTHER", rowCount: 0 };
    const rows = ids.filter((id) => FIXTURE.has(id)).map((id) => FIXTURE.get(id));
    return { fields: FIELDS, rows, command: "SELECT", rowCount: rows.length };
  };
  return Array.isArray(body?.queries) ? { results: body.queries.map(one) } : one(body);
}
globalThis.fetch = async (input, init = {}) => {
  const isReq = typeof input === "object" && input !== null && "url" in input && typeof input.url === "string";
  const url = new URL(isReq ? input.url : String(input));
  if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === "8788") {
    await ready;
    url.port = String(port);
    const headers = new Headers(init.headers || (isReq ? input.headers : undefined) || {});
    headers.set("connection", "close");
    return realFetch(url, { ...init, headers });
  }
  if (url.pathname === "/sql") {
    const headers = new Headers(init.headers || {});
    const body = JSON.parse(String(init.body || "{}"));
    const queries = Array.isArray(body.queries) ? body.queries : [body];
    sqlCalls.push({ method: String(init.method || "GET"), read_only: headers.get("neon-batch-read-only"), batch: Array.isArray(body.queries),
      queries: queries.map((q) => ({ query: String(q.query || ""), params: q.params || [] })) });
    return new Response(JSON.stringify(neonAnswer(body)), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "api.mercadopago.com") { mpCalls.push(url.pathname); return new Response("{}", { status: 404 }); }
  blocked.push(url.hostname);
  return new Response("{}", { status: 503 });
};

const kvStore = new Map();
const kv = {
  async get(k) { return kvStore.get(k) ?? null; },
  async put(k, v) { kvStore.set(k, String(v)); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix = "" } = {}) { return { keys: [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};

const { default: production } = await import("../../worker/cloudflare-worker.compat.mjs");

const OP = "synthetic-production-operator-token-0123456789ab";
const PILOT = Object.freeze({
  CERTIFICATION_PILOT_ENABLED: "true", CERTIFICATION_PILOT_ENV: "sandbox", CERTIFICATION_PILOT_PRODUCTION_ALLOWED: "true",
  CERTIFICATION_PILOT_PAYMENT_MODE: "sandbox", CERTIFICATION_PILOT_APPROVER: "zevanory-certification-e2e",
});
const BASE = { ZEVANORY_DEPLOYMENT_ENV: "production", MERCADOPAGO_ENV: "production", SALE_GLOBALLY_ENABLED: "false",
  PAYMENT_PROVIDER: "mercadopago", ZEVANORY_OPERATOR_TOKEN: OP, ZEVANORY_PRIVATE_ARTIFACTS: kv,
  DATABASE_URL: "postgresql://synthetic:synthetic@ep-synthetic-0001.us-east-2.aws.neon.tech/zevanory" };
// with_pilot: o piloto INTEIRO como era necessário para a rota antiga responder (MERCADOPAGO_ENV=sandbox e credenciais de
// TESTE, como em tests/helpers/pilot-removal-probe.mjs). Assim a única razão para a rota do piloto recusar é a vista de produção.
const ENVS = { no_pilot: { ...BASE }, with_pilot: { ...BASE, ...PILOT, MERCADOPAGO_ENV: "sandbox", ASAAS_ENV: "sandbox",
  MERCADOPAGO_TEST_ACCESS_TOKEN: "TEST-synthetic-token", MERCADOPAGO_TEST_WEBHOOK_SECRET: "synthetic-test-webhook-secret",
  MERCADOPAGO_TEST_PUBLIC_KEY: "TEST-synthetic-public" } };
const KEYS = /^(CERTIFICATION_|MERCADOPAGO_|OPERATOR_TOKEN$|ZEVANORY_OPERATOR_TOKEN$|DATABASE_URL$|SALE_GLOBALLY_ENABLED$)/;
function resetProcessEnv() { for (const k of Object.keys(process.env)) if (KEYS.test(k)) delete process.env[k]; }
let n = 0;
const ip = () => "10.9." + Math.floor(++n / 250) + "." + (n % 250);
const lookupUrl = (ids) => "https://zevanory.api.br/api/internal/audit/order-lookup?" + ids.map((x) => "order_id=" + encodeURIComponent(x)).join("&");
const REQUESTS = {
  lookup_ok: () => new Request(lookupUrl([ORDER_PRESENT, ORDER_PILOT, ORDER_MISSING]), { headers: { "x-certification-e2e-token": OP, "cf-connecting-ip": ip() } }),
  lookup_bad_token: () => new Request(lookupUrl([ORDER_PRESENT]), { headers: { "x-certification-e2e-token": OP.slice(0, -1) + "X", "cf-connecting-ip": ip() } }),
  lookup_no_token: () => new Request(lookupUrl([ORDER_PRESENT]), { headers: { "cf-connecting-ip": ip() } }),
  lookup_post: () => new Request(lookupUrl([ORDER_PRESENT]), { method: "POST", headers: { "x-certification-e2e-token": OP, "cf-connecting-ip": ip() }, body: "{}" }),
  lookup_invalid_id: () => new Request(lookupUrl(["ZEVANORY:not-a-uuid"]), { headers: { "x-certification-e2e-token": OP, "cf-connecting-ip": ip() } }),
  lookup_too_many: () => new Request(lookupUrl(Array.from({ length: 41 }, (_, i) => "1b2c3d4e-0000-4000-8000-" + String(i).padStart(12, "0"))),
    { headers: { "x-certification-e2e-token": OP, "cf-connecting-ip": ip() } }),
  pilot_status: () => new Request("https://zevanory.api.br/api/internal/certification/e2e/status?order_id=" + ORDER_PRESENT,
    { headers: { "x-certification-e2e-token": OP, "cf-connecting-ip": ip() } }),
};

async function read(res) {
  const json = await res.clone().json().catch(() => null);
  return { status: res.status, error: json?.error ?? null, body: json };
}

const out = {};
const timer = setTimeout(() => { console.log("PROBE_RESULT " + JSON.stringify({ timeout: true, out })); process.exit(0); }, 100_000);
try {
  for (const [variant, env] of Object.entries(ENVS)) {
    out[variant] = {};
    for (const [name, make] of Object.entries(REQUESTS)) {
      resetProcessEnv();
      const sqlBefore = sqlCalls.length, mpBefore = mpCalls.length;
      const r = await read(await production.fetch(make(), env, { waitUntil() {} }));
      out[variant][name] = { ...r, sql: sqlCalls.slice(sqlBefore), mp_calls: mpCalls.length - mpBefore };
    }
  }
  // Controle (causa raiz): a rota antiga do piloto só respondia porque CERTIFICATION_PILOT_ENV=sandbox chegava ao runtime.
  // Chamando o handler Node direto (sem a vista de produção) com o piloto em process.env, ela passa da trava do piloto.
  resetProcessEnv();
  Object.assign(process.env, { ZEVANORY_OPERATOR_TOKEN: OP, CERTIFICATION_PILOT_ENV: "sandbox", SALE_GLOBALLY_ENABLED: "false" });
  out.control_old_path_raw_pilot = await read(await globalThis.fetch("http://127.0.0.1:8788/api/internal/certification/e2e/status?order_id=" + ORDER_PRESENT,
    { headers: { "x-certification-e2e-token": OP } }));
  resetProcessEnv();
} catch (error) {
  out.error = String(error?.stack || error).slice(0, 600);
}
clearTimeout(timer);
console.log("PROBE_RESULT " + JSON.stringify({ out, blocked: [...new Set(blocked)] }));
process.exit(0);
