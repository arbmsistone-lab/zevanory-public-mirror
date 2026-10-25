// Sonda da JANELA DE MIGRAÇÃO da credencial de operador (Sol 233; sem rede, sem segredo real): executa o Worker REAL de
// produção (worker/cloudflare-worker.compat.mjs -> cloudflare-worker.recovered.mjs) com ZEVANORY_OPERATOR_TOKEN (NEW) e
// CERTIFICATION_E2E_TOKEN (OLD) DIFERENTES e registra o status de cada rota autenticada pela credencial de operador com
// NEW, OLD e um valor desconhecido (UNKNOWN), em variantes da flag OPERATOR_TOKEN_MIGRATION_UNTIL: aberta (var e
// ZEVANORY_RUNTIME_CONFIG objeto/texto), vencida, malformada, acima do teto em código e ausente; mais os dois nomes
// ausentes. A data "aberta" vem do argumento argv[2] (calculada pelo teste a partir do relógio e do teto).
// Usada por tests/ci/operator-token-migration.test.mjs.
// Rodar: node --import ./tests/t4_sim/register.mjs tests/helpers/operator-token-migration-probe.mjs AAAA-MM-DD
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
const blocked = [];
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
  blocked.push(url.hostname);
  return new Response("{}", { status: 503 });
};

export const NEW = "synthetic-NEW-operator-token-0123456789abcdef0123";
export const OLD = "synthetic-OLD-operator-token-fedcba9876543210fedc";
export const UNKNOWN = "synthetic-UNK-operator-token-a1b2c3d4e5f6a7b8c9d0";

const kvStore = new Map([["zpc:multichannel:proof:telegram", JSON.stringify({ provider_post_id: "1", url: "https://t.me/zevanory/1" })]]);
const kv = {
  async get(k) { return kvStore.get(k) ?? null; },
  async put(k, v) { kvStore.set(k, String(v)); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix = "" } = {}) { return { keys: [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};

const { default: production } = await import("../../worker/cloudflare-worker.compat.mjs");

const TOKEN_KEY = /^(ZEVANORY_OPERATOR_TOKEN|CERTIFICATION_|OPERATOR_TOKEN$|OPERATOR_TOKEN_MIGRATION_UNTIL$|ZEVANORY_RUNTIME_CONFIG$|MERCADOPAGO_|DATABASE_URL$)/;
function resetProcessEnv() { for (const k of Object.keys(process.env)) if (TOKEN_KEY.test(k)) delete process.env[k]; }

const OPEN = String(process.argv[2] || "");
const BASE = { ZEVANORY_DEPLOYMENT_ENV: "production", MERCADOPAGO_ENV: "sandbox", SALE_GLOBALLY_ENABLED: "false", CHECKOUT_ENABLED: "true",
  FINANCIAL_EVENTS_ENABLED: "true", ZEVANORY_PRIVATE_ARTIFACTS: kv };
const BOTH = { ZEVANORY_OPERATOR_TOKEN: NEW, CERTIFICATION_E2E_TOKEN: OLD };
export const VARIANTS = {
  open_var: { ...BOTH, OPERATOR_TOKEN_MIGRATION_UNTIL: OPEN },
  open_runtime_object: { ...BOTH, ZEVANORY_RUNTIME_CONFIG: { OPERATOR_TOKEN_MIGRATION_UNTIL: OPEN } },
  open_runtime_string: { ...BOTH, ZEVANORY_RUNTIME_CONFIG: JSON.stringify({ OPERATOR_TOKEN_MIGRATION_UNTIL: OPEN }) },
  expired: { ...BOTH, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-01-01" },
  malformed: { ...BOTH, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-02-30" },
  beyond_ceiling: { ...BOTH, OPERATOR_TOKEN_MIGRATION_UNTIL: "2099-12-31" },
  absent: { ...BOTH },
  none_configured: { OPERATOR_TOKEN_MIGRATION_UNTIL: OPEN },
};
const ROUTES = {
  backup_run: ["/api/internal/backup/run?part=0&parts=1", "POST", "x-backup-token", null],
  funnel_run: ["/api/internal/funnel/run", "POST", "x-backup-token", null],
  voice_eval_run: ["/api/internal/voice-eval/run", "POST", "x-backup-token", null],
  audit_credential_identity: ["/api/internal/audit/credential-identity", "GET", "x-certification-e2e-token", null],
  telegram_proof: ["/api/internal/channels/telegram-proof", "POST", "x-certification-e2e-token", "{}"],
  channel_evidence: ["/api/internal/channels/evidence", "POST", "x-certification-e2e-token", "not-json"],
  whatsapp_stats_refresh: ["/api/internal/whatsapp/stats-refresh", "POST", "x-certification-e2e-token", "{}"],
  voice_audit: ["/api/admin/voice/audit", "POST", "authorization", "{}"],
};
async function call(env, route, token) {
  resetProcessEnv();
  const [path, method, header, body] = ROUTES[route];
  const init = { method, headers: { [header]: header === "authorization" ? "Bearer " + token : token, "content-type": "application/json", "cf-connecting-ip": "10.8." + Math.floor(Math.random() * 250) + "." + Math.floor(Math.random() * 250) } };
  if (body !== null) init.body = body;
  const res = await production.fetch(new Request("https://zevanory.api.br" + path, init), env, { waitUntil() {} });
  const json = await res.clone().json().catch(() => null);
  return { status: res.status, error: json?.error ?? null, presented: json?.operator_token_presented ?? null, migration: json?.operator_token_migration ?? null };
}
async function nodeStatus(envVars, token) {
  resetProcessEnv();
  for (const [k, v] of Object.entries(envVars)) if (typeof v === "string") process.env[k] = v;
  const res = await globalThis.fetch("http://127.0.0.1:8788/api/internal/certification/e2e/status?order_id=x", { headers: { "x-certification-e2e-token": token } });
  const json = await res.json().catch(() => null);
  return { status: res.status, error: json?.error ?? null };
}
const out = {};
const timer = setTimeout(() => { console.log("PROBE_RESULT " + JSON.stringify({ timeout: true, out })); process.exit(0); }, 100_000);
try {
  for (const [variant, binding] of Object.entries(VARIANTS)) {
    const env = { ...BASE, ...binding };
    out[variant] = {};
    for (const route of Object.keys(ROUTES)) {
      out[variant][route] = { new: await call(env, route, NEW), old: await call(env, route, OLD), unknown: await call(env, route, UNKNOWN) };
    }
    const flat = { ...BASE, ...binding, ZEVANORY_PRIVATE_ARTIFACTS: undefined,
      ZEVANORY_RUNTIME_CONFIG: typeof binding.ZEVANORY_RUNTIME_CONFIG === "object" ? JSON.stringify(binding.ZEVANORY_RUNTIME_CONFIG) : binding.ZEVANORY_RUNTIME_CONFIG };
    out[variant].node_e2e_status = { new: await nodeStatus(flat, NEW), old: await nodeStatus(flat, OLD), unknown: await nodeStatus(flat, UNKNOWN) };
  }
} catch (error) {
  out.error = String(error?.stack || error).slice(0, 600);
}
clearTimeout(timer);
console.log("PROBE_RESULT " + JSON.stringify({ out, blocked: [...new Set(blocked)] }));
process.exit(0);
