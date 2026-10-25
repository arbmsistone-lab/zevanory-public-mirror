// Sonda R9 (sem rede, sem segredo real): executa o Worker REAL de produção (worker/cloudflare-worker.compat.mjs ->
// cloudflare-worker.recovered.mjs) e registra o status HTTP de cada rota autenticada pela credencial de operador, em
// três variantes de binding: só ZEVANORY_OPERATOR_TOKEN, os dois nomes com valores DIFERENTES, só o nome antigo.
// Para cada variante a rota é chamada com o valor do nome novo (NEW) e com o do antigo (OLD). Usada por
// tests/operator-token-transition.test.mjs. Rodar: node --import ./tests/t4_sim/register.mjs tests/helpers/operator-token-probe.mjs
//
// Mesmo isolamento da sonda de credenciais de pagamento (payment-credential-probe.mjs): o bundle sobe um servidor Node
// em 127.0.0.1:8788; http.createServer é interceptado antes do import e escuta numa porta efêmera.
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

const kvStore = new Map([["zpc:multichannel:proof:telegram", JSON.stringify({ provider_post_id: "1", url: "https://t.me/zevanory/1" })]]);
const kv = {
  async get(k) { return kvStore.get(k) ?? null; },
  async put(k, v) { kvStore.set(k, String(v)); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix = "" } = {}) { return { keys: [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};

const { default: production } = await import("../../worker/cloudflare-worker.compat.mjs");
const { default: certification } = await import("../../certification-worker.mjs");

const TOKEN_KEY = /^(ZEVANORY_OPERATOR_TOKEN|CERTIFICATION_|OPERATOR_TOKEN$|MERCADOPAGO_|DATABASE_URL$)/;
function resetProcessEnv() { for (const k of Object.keys(process.env)) if (TOKEN_KEY.test(k)) delete process.env[k]; }

// Produção com o piloto ainda ligado no binding (como o deploy gravava antes do R9 B): desde o R9 B o Worker de produção
// não o enxerga (worker/production-pilot-guard.mjs). Vendas fechadas. Nenhum DATABASE_URL.
const BASE = { ZEVANORY_DEPLOYMENT_ENV: "production", CERTIFICATION_PILOT_ENV: "sandbox", MERCADOPAGO_ENV: "sandbox",
  SALE_GLOBALLY_ENABLED: "false", CHECKOUT_ENABLED: "true", FINANCIAL_EVENTS_ENABLED: "true", ZEVANORY_PRIVATE_ARTIFACTS: kv };
export const VARIANTS = {
  new_only: { ZEVANORY_OPERATOR_TOKEN: NEW },
  both_different: { ZEVANORY_OPERATOR_TOKEN: NEW, CERTIFICATION_E2E_TOKEN: OLD },
  legacy_only: { CERTIFICATION_E2E_TOKEN: OLD },
};

// [rota, método, cabeçalho de autenticação, corpo]
const ROUTES = {
  backup_run: ["/api/internal/backup/run?part=0&parts=1", "POST", "x-backup-token", null],
  funnel_run: ["/api/internal/funnel/run", "POST", "x-backup-token", null],
  voice_eval_run: ["/api/internal/voice-eval/run", "POST", "x-backup-token", null],
  certification_invite: ["/api/internal/certification/e2e/invite", "POST", "x-certification-e2e-token", "{}"],
  audit_credential_identity: ["/api/internal/audit/credential-identity", "GET", "x-certification-e2e-token", null],
  telegram_proof: ["/api/internal/channels/telegram-proof", "POST", "x-certification-e2e-token", "{}"],
  channel_evidence: ["/api/internal/channels/evidence", "POST", "x-certification-e2e-token", "not-json"],
  whatsapp_stats_refresh: ["/api/internal/whatsapp/stats-refresh", "POST", "x-certification-e2e-token", "{}"],
  voice_audit: ["/api/admin/voice/audit", "POST", "authorization", "{}"],
};

async function call(env, route, token) {
  resetProcessEnv();
  const [path, method, header, body] = ROUTES[route];
  const init = { method, headers: { [header]: header === "authorization" ? "Bearer " + token : token, "content-type": "application/json", "cf-connecting-ip": "10.9." + Math.floor(Math.random() * 250) + "." + Math.floor(Math.random() * 250) } };
  if (body !== null) init.body = body;
  const res = await production.fetch(new Request("https://zevanory.api.br" + path, init), env, { waitUntil() {} });
  const json = await res.clone().json().catch(() => null);
  return { status: res.status, error: json?.error ?? null, source: json?.operator_token_source ?? null };
}

// Rota Node do bundle (handlerFinancialE2EStatus): lê process.env, hidratado como o Worker faz.
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
      out[variant][route] = { new: await call(env, route, NEW), old: await call(env, route, OLD) };
    }
    // O servidor Node só existe depois que o bundle atendeu a primeira requisição Node; o fetch o aguarda.
    out[variant].node_e2e_status = { new: await nodeStatus({ ...BASE, ...binding, ZEVANORY_PRIVATE_ARTIFACTS: undefined }, NEW),
      old: await nodeStatus({ ...BASE, ...binding, ZEVANORY_PRIVATE_ARTIFACTS: undefined }, OLD) };
  }
  // Perímetro de certificação: a credencial de operador da PRODUÇÃO nunca pode estar ligada ao Worker de certificação.
  const d1 = { prepare() { return { bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return {}; } }; } };
  const CERT_ENV = { CERTIFICATION_WORKER_NAME: "zevanory-certification", CERTIFICATION_SOURCE_SHA: "a".repeat(40), ZEVANORY_DEPLOYMENT_ENV: "certification",
    CERTIFICATION_PILOT_ENV: "sandbox", MERCADOPAGO_ENV: "sandbox", SALE_GLOBALLY_ENABLED: "false", CERTIFICATION_PILOT_PRODUCTION_ALLOWED: "false",
    CERTIFICATION_DATABASE_URL: "postgresql://sim:sim@ep-sim.local/zevanory_certification", CERTIFICATION_OPERATOR_TOKEN: "synthetic-cert-operator",
    CERTIFICATION_E2E_TOKEN: OLD, MERCADOPAGO_TEST_PUBLIC_KEY: "TEST-pk", MERCADOPAGO_TEST_ACCESS_TOKEN: "TEST-at", MERCADOPAGO_TEST_WEBHOOK_SECRET: "test-wh",
    ZEVANORY_PRIVATE_ARTIFACTS: kv, CERTIFICATION_D1: d1 };
  const certCall = async (env, token) => {
    resetProcessEnv();
    const res = await certification.fetch(new Request("https://zevanory-certification.example.workers.dev/api/internal/certification/e2e/status",
      { headers: { "x-certification-e2e-token": token } }), env, { waitUntil() {} });
    const json = await res.json().catch(() => null);
    return { status: res.status, error: json?.error ?? null };
  };
  out.certification = { own_token: await certCall(CERT_ENV, OLD), wrong_token: await certCall(CERT_ENV, NEW),
    with_production_operator_token: await certCall({ ...CERT_ENV, ZEVANORY_OPERATOR_TOKEN: NEW }, OLD) };
} catch (error) {
  out.error = String(error?.stack || error).slice(0, 600);
}
clearTimeout(timer);
console.log("PROBE_RESULT " + JSON.stringify({ out, blocked: [...new Set(blocked)] }));
process.exit(0);
