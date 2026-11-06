// Sonda R9 B (sem rede, sem segredo real): executa o Worker REAL de produção (worker/cloudflare-worker.compat.mjs ->
// cloudflare-worker.recovered.mjs) com TODO o piloto de certificação ligado (CERTIFICATION_PILOT_ENABLED=true, ENV=sandbox,
// PRODUCTION_ALLOWED=true, PAYMENT_MODE=sandbox, APPROVER, credenciais de TESTE do Mercado Pago, MERCADOPAGO_ENV=sandbox,
// credencial de operador válida) e registra a resposta de cada caminho de pagamento sandbox/sintético, em quatro formas de
// injetar o piloto: vars, ZEVANORY_RUNTIME_CONFIG objeto, ZEVANORY_RUNTIME_CONFIG texto JSON e restos em process.env.
// Controles: os mesmos handlers chamados SEM a entrada de produção (env cru) aceitam o piloto, e o Worker de certificação
// mantém o piloto dele. Usada por tests/production-pilot-removal.test.mjs.
// Rodar: node --import ./tests/t4_sim/register.mjs tests/helpers/pilot-removal-probe.mjs
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
const mpCalls = [];
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
const d1 = { prepare() { return { bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return {}; } }; } };

const { default: production } = await import("../../worker/cloudflare-worker.compat.mjs");
const { default: certification } = await import("../../certification-worker.mjs");
const { handleSandboxProofV2 } = await import("../../worker/sandbox-proof-v2.mjs");
const { handleAsaasPixRefundAuthorization } = await import("../../worker/asaas-pix-refund-auth.mjs");

const OP = "synthetic-production-operator-token-0123456789ab";
const OPERATOR_TOKEN = "synthetic-operator-events-token-0123456789";
export const PILOT = Object.freeze({
  CERTIFICATION_PILOT_ENABLED: "true", CERTIFICATION_PILOT_ENV: "sandbox", CERTIFICATION_PILOT_PRODUCTION_ALLOWED: "true",
  CERTIFICATION_PILOT_PAYMENT_MODE: "sandbox", CERTIFICATION_PILOT_APPROVER: "zevanory-certification-e2e", CERTIFICATION_PILOT_AMOUNT_BRL: "5",
});
const BASE = { ZEVANORY_DEPLOYMENT_ENV: "production", MERCADOPAGO_ENV: "sandbox", SALE_GLOBALLY_ENABLED: "false", CHECKOUT_ENABLED: "true",
  FINANCIAL_EVENTS_ENABLED: "true", PAYMENT_PROVIDER: "mercadopago", ASAAS_ENV: "sandbox", PAYMENT_PUBLIC_BASE_URL: "https://zevanory.api.br",
  MERCADOPAGO_TEST_ACCESS_TOKEN: "TEST-synthetic-token", MERCADOPAGO_TEST_WEBHOOK_SECRET: "synthetic-test-webhook-secret",
  MERCADOPAGO_TEST_PUBLIC_KEY: "TEST-synthetic-public", ZEVANORY_OPERATOR_TOKEN: OP, OPERATOR_TOKEN, ZEVANORY_PRIVATE_ARTIFACTS: kv };
const VARIANTS = {
  vars: { ...BASE, ...PILOT },
  runtime_object: { ...BASE, ZEVANORY_RUNTIME_CONFIG: { ...PILOT } },
  runtime_string: { ...BASE, ZEVANORY_RUNTIME_CONFIG: JSON.stringify(PILOT) },
  process_env: { ...BASE },
};
const PILOT_KEY = /^(CERTIFICATION_|MERCADOPAGO_|OPERATOR_TOKEN$|ZEVANORY_OPERATOR_TOKEN$|DATABASE_URL$)/;
function resetProcessEnv(variant) {
  for (const k of Object.keys(process.env)) if (PILOT_KEY.test(k)) delete process.env[k];
  if (variant === "process_env") Object.assign(process.env, PILOT);
}
const ip = () => "10.7." + Math.floor(Math.random() * 250) + "." + Math.floor(Math.random() * 250);
const REQUESTS = {
  pilot_checkout: () => new Request("https://zevanory.api.br/api/checkout/mercadopago", { method: "POST",
    headers: { "content-type": "application/json", "x-certification-pilot-token": "synthetic-pilot-token" },
    body: JSON.stringify({ request_id: crypto.randomUUID(), session_id: crypto.randomUUID(), offer_id: "ZEV-IA-011" }) }),
  certification_invite: () => new Request("https://zevanory.api.br/api/internal/certification/e2e/invite", { method: "POST",
    headers: { "x-certification-e2e-token": OP, "content-type": "application/json" }, body: "{}" }),
  sandbox_status: () => new Request("https://zevanory.api.br/api/internal/certification/e2e/status?order_id=x", { headers: { "x-certification-e2e-token": OP } }),
  sandbox_checkout: () => new Request("https://zevanory.api.br/api/internal/certification/e2e/checkout", { method: "POST",
    headers: { "x-certification-e2e-token": OP, "content-type": "application/json" }, body: JSON.stringify({ offer_id: "ZEV-IA-011" }) }),
  operator_invite_event: () => new Request("https://zevanory.api.br/api/events/operator", { method: "POST",
    headers: { authorization: "Bearer " + OPERATOR_TOKEN, "content-type": "application/json", "cf-connecting-ip": ip() },
    body: JSON.stringify({ name: "certification_pilot_invite_create", ttl_hours: 1 }) }),
  asaas_pix_refund_authorization: () => new Request("https://zevanory.api.br/api/asaas/withdraw-authorization", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "PIX_REFUND", pixRefund: { value: 5, id: "refund-0001", payment: "pay_synthetic" } }) }),
};

async function read(res) {
  const json = await res.clone().json().catch(() => null);
  return { status: res.status, error: json?.error ?? json?.refuseReason ?? null, status_field: json?.status ?? null };
}

const out = { production: {}, controls: {} };
const timer = setTimeout(() => { console.log("PROBE_RESULT " + JSON.stringify({ timeout: true, out })); process.exit(0); }, 100_000);
try {
  for (const [variant, env] of Object.entries(VARIANTS)) {
    out.production[variant] = {};
    for (const [name, make] of Object.entries(REQUESTS)) {
      resetProcessEnv(variant);
      const before = mpCalls.length;
      const r = await read(await production.fetch(make(), env, { waitUntil() {} }));
      out.production[variant][name] = { ...r, mp_calls: mpCalls.length - before };
    }
    out.production[variant].process_env_after = Object.keys(process.env).filter((k) => k.startsWith("CERTIFICATION_PILOT_")).sort()
      .map((k) => k + "=" + process.env[k]);
  }
  // Controles (mesmo env, sem a entrada de produção): o piloto existe no código compartilhado.
  resetProcessEnv("vars");
  const raw = { ...BASE, ...PILOT };
  out.controls.sandbox_status_raw = await read(await handleSandboxProofV2(REQUESTS.sandbox_status(), raw, { waitUntil() {} }, production, () => null));
  out.controls.asaas_raw = await read(await handleAsaasPixRefundAuthorization(REQUESTS.asaas_pix_refund_authorization(), raw));
  resetProcessEnv("vars");
  Object.assign(process.env, { ...PILOT, OPERATOR_TOKEN });
  out.controls.operator_invite_node_raw = await read(await globalThis.fetch("http://127.0.0.1:8788/api/events/operator", { method: "POST",
    headers: { authorization: "Bearer " + OPERATOR_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ name: "certification_pilot_invite_create" }) }));
  // Worker de certificação: piloto preservado.
  const CERT_ENV = { CERTIFICATION_WORKER_NAME: "zevanory-certification", CERTIFICATION_SOURCE_SHA: "a".repeat(40), ZEVANORY_DEPLOYMENT_ENV: "certification",
    CERTIFICATION_PILOT_ENV: "sandbox", MERCADOPAGO_ENV: "sandbox", SALE_GLOBALLY_ENABLED: "false", CERTIFICATION_PILOT_PRODUCTION_ALLOWED: "false",
    CERTIFICATION_DATABASE_URL: "postgresql://sim:sim@ep-sim.local/zevanory_certification", CERTIFICATION_OPERATOR_TOKEN: "synthetic-cert-operator-token-0123456789",
    CERTIFICATION_E2E_TOKEN: "synthetic-cert-e2e-token-0123456789abcdef", MERCADOPAGO_TEST_PUBLIC_KEY: "TEST-pk", MERCADOPAGO_TEST_ACCESS_TOKEN: "TEST-at",
    MERCADOPAGO_TEST_WEBHOOK_SECRET: "test-wh", ZEVANORY_PRIVATE_ARTIFACTS: kv, CERTIFICATION_D1: d1 };
  resetProcessEnv("vars");
  out.controls.certification_status = await read(await certification.fetch(new Request("https://zevanory-certification.example.workers.dev/api/internal/certification/e2e/status",
    { headers: { "x-certification-e2e-token": CERT_ENV.CERTIFICATION_E2E_TOKEN } }), CERT_ENV, { waitUntil() {} }));
  resetProcessEnv("vars");
  out.controls.certification_checkout = await read(await certification.fetch(new Request("https://zevanory-certification.example.workers.dev/api/internal/certification/e2e/checkout",
    { method: "POST", headers: { "x-certification-e2e-token": CERT_ENV.CERTIFICATION_E2E_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ offer_id: "ZEV-IA-011" }) }), CERT_ENV, { waitUntil() {} }));
} catch (error) {
  out.error = String(error?.stack || error).slice(0, 600);
}
clearTimeout(timer);
console.log("PROBE_RESULT " + JSON.stringify({ out, blocked: [...new Set(blocked)] }));
process.exit(0);
