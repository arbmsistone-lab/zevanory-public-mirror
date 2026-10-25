// Sonda (sem rede, sem segredo real): executa o Worker REAL de produção (worker/cloudflare-worker.compat.mjs ->
// cloudflare-worker.recovered.mjs) e o Worker de certificação (certification-worker.mjs) com credenciais SINTÉTICAS
// e registra, por cenário, a resposta HTTP e QUAL credencial chegou à API do Mercado Pago (somente o rótulo
// sintético, nunca um valor real). Usada por tests/production-payment-credential-isolation.test.mjs.
// Rodar com o carregador local: node --import ./tests/t4_sim/register.mjs tests/helpers/payment-credential-probe.mjs
//
// Isolamento do teste: o bundle sobe um servidor Node em 127.0.0.1:8788 (porta fixa). Para não colidir com outra
// suíte rodando em paralelo, http.createServer é interceptado ANTES do import e o servidor escuta numa porta
// efêmera; as chamadas que o bundle faz a 127.0.0.1:8788 (handleAsNodeRequest) são redirecionadas para ela.
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";

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

// Credenciais sintéticas: o rótulo identifica qual delas o Worker escolheu (o fake do Mercado Pago só registra isso).
export const CRED = Object.freeze({
  PROD_TOKEN: "APP_USR-synthetic-PRODUCTION-token",
  PROD_SECRET: "synthetic-PRODUCTION-webhook-secret-0001",
  TEST_TOKEN: "TEST-synthetic-SANDBOX-token",
  TEST_SECRET: "synthetic-SANDBOX-webhook-secret-00001",
  TEST_PUBLIC: "TEST-synthetic-SANDBOX-public-key",
});
const label = (auth) => {
  const t = String(auth || "").replace(/^Bearer\s+/i, "");
  if (t === CRED.PROD_TOKEN) return "production";
  if (t === CRED.TEST_TOKEN) return "test";
  return t ? "other" : "none";
};

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
  if (url.hostname === "api.mercadopago.com") {
    const h = new Headers(init.headers || (isReq ? input.headers : undefined) || {});
    mpCalls.push({ method: init.method || "GET", path: url.pathname, credential: label(h.get("authorization")), test_header: h.get("x-test-token") === "true" });
    const m = url.pathname.match(/^\/v1\/payments\/(\d+)$/);
    if (m) return new Response(JSON.stringify({ id: Number(m[1]), status: "approved", transaction_amount: 197, transaction_amount_refunded: 0,
      currency_id: "BRL", external_reference: "3f1c2b4a-1d2e-4f5a-8b9c-0d1e2f3a4b5c", live_mode: true }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }
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

// Cada cenário parte de um process.env sem nenhuma credencial de pagamento: o bundle hidrata process.env a partir de
// `env` e nunca apaga chaves (hydrateRuntimeConfig), então a limpeza garante que o cenário enxerga SÓ o que declara.
const PAYMENT_KEY = /^(MERCADOPAGO_|CERTIFICATION_|STRIPE_|ASAAS_|DATABASE_URL$|OPERATOR_TOKEN$)/;
function resetProcessEnv() { for (const k of Object.keys(process.env)) if (PAYMENT_KEY.test(k)) delete process.env[k]; }

const BASE_ENV = { FINANCIAL_EVENTS_ENABLED: "true", CHECKOUT_ENABLED: "true", MERCADOPAGO_ENV: "production",
  PAYMENT_PUBLIC_BASE_URL: "https://zevanory.api.br", ZEVANORY_PRIVATE_ARTIFACTS: kv };
const CREDS = {
  production: { MERCADOPAGO_ACCESS_TOKEN: CRED.PROD_TOKEN, MERCADOPAGO_WEBHOOK_SECRET: CRED.PROD_SECRET },
  test: { MERCADOPAGO_TEST_ACCESS_TOKEN: CRED.TEST_TOKEN, MERCADOPAGO_TEST_WEBHOOK_SECRET: CRED.TEST_SECRET },
};
const envWith = (...sets) => Object.assign({}, BASE_ENV, ...sets.map((s) => (typeof s === "string" ? CREDS[s] : s)));

const sign = (secret, paymentId, requestId) => {
  const ts = Math.floor(Date.now() / 1000);
  return `ts=${ts},v1=${createHmac("sha256", secret).update(`id:${paymentId};request-id:${requestId};ts:${ts};`).digest("hex")}`;
};
let seq = 81000000;
async function webhook(worker, env, provider, secret, origin = "https://zevanory.api.br") {
  // data.id vai só no corpo: o Worker de certificação aceita exatamente "?provider=mercadopago_test" na query.
  resetProcessEnv();
  const paymentId = String(++seq), requestId = randomUUID();
  const before = mpCalls.length;
  const headers = { "content-type": "application/json", "x-request-id": requestId };
  if (secret) headers["x-signature"] = sign(secret, paymentId, requestId);
  const res = await worker.fetch(new Request(`${origin}/api/webhooks?provider=${provider}`, {
    method: "POST", headers, body: JSON.stringify({ type: "payment", action: "payment.updated", data: { id: paymentId } }) }), env, { waitUntil() {} });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, error: body.error || null, accepted: body.accepted ?? null, mp: mpCalls.slice(before) };
}
// Checkout: (a) pela entrada do Worker (compat) e (b) direto no handler Node do bundle (handler12), com process.env
// igual ao que o Worker hidrata. (b) existe porque o compat recusa o piloto em produção antes do handler; o handler
// ainda precisa provar sozinho que, sem a credencial de produção, não cria preferência com a de teste.
async function checkout(env, { direct = false } = {}) {
  resetProcessEnv();
  const before = mpCalls.length;
  const init = { method: "POST", headers: { "content-type": "application/json", "x-certification-pilot-token": "synthetic-pilot-token" },
    body: JSON.stringify({ request_id: randomUUID(), session_id: randomUUID(), offer_id: "ZEV-IA-011" }) };
  let res;
  if (direct) {
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") process.env[k] = v;
    res = await globalThis.fetch("http://127.0.0.1:8788/api/checkout/mercadopago", init);
  } else {
    res = await production.fetch(new Request("https://zevanory.api.br/api/checkout/mercadopago", init), env, { waitUntil() {} });
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, error: body.error || null, reason: body.reason || null, mp: mpCalls.slice(before) };
}
const CERT_ENV = {
  CERTIFICATION_WORKER_NAME: "zevanory-certification", CERTIFICATION_SOURCE_SHA: "a".repeat(40), ZEVANORY_DEPLOYMENT_ENV: "certification",
  CERTIFICATION_PILOT_ENV: "sandbox", MERCADOPAGO_ENV: "sandbox", SALE_GLOBALLY_ENABLED: "false", CERTIFICATION_PILOT_PRODUCTION_ALLOWED: "false",
  CERTIFICATION_DATABASE_URL: "postgresql://sim:sim@ep-sim.local/zevanory_certification", CERTIFICATION_OPERATOR_TOKEN: "synthetic-cert-operator",
  CERTIFICATION_E2E_TOKEN: "synthetic-cert-e2e-token-0123456789abcdef", MERCADOPAGO_TEST_PUBLIC_KEY: CRED.TEST_PUBLIC,
  ...CREDS.test, FINANCIAL_EVENTS_ENABLED: "true", ZEVANORY_PRIVATE_ARTIFACTS: kv, CERTIFICATION_D1: d1,
};
const CERT_ORIGIN = "https://zevanory-certification.example.workers.dev";

const out = {};
const timer = setTimeout(() => { console.log("PROBE_RESULT " + JSON.stringify({ timeout: true, out })); process.exit(0); }, 90_000);
try {
  // Produção, só credenciais de TESTE presentes.
  out.prod_webhook_only_test_signed_test = await webhook(production, envWith("test"), "mercadopago", CRED.TEST_SECRET);
  out.prod_webhook_only_test_unsigned = await webhook(production, envWith("test"), "mercadopago", null);
  out.prod_checkout_only_test = await checkout(envWith("test"));
  out.prod_checkout_handler_only_test = await checkout(envWith("test"), { direct: true });
  out.prod_checkout_handler_only_prod = await checkout(envWith("production"), { direct: true });
  // Produção, só credenciais de PRODUÇÃO presentes (rota de teste).
  out.test_webhook_only_prod_signed_prod = await webhook(production, envWith("production"), "mercadopago_test", CRED.PROD_SECRET);
  // Ambas presentes: assinatura cruzada.
  out.prod_webhook_both_signed_test = await webhook(production, envWith("production", "test"), "mercadopago", CRED.TEST_SECRET);
  out.test_webhook_both_signed_prod = await webhook(production, envWith("production", "test"), "mercadopago_test", CRED.PROD_SECRET);
  // Segredo de um lado + token só do outro: nunca há queda (fallback) para o token do outro ambiente.
  out.prod_webhook_prod_secret_test_token = await webhook(production, envWith({ MERCADOPAGO_WEBHOOK_SECRET: CRED.PROD_SECRET, MERCADOPAGO_TEST_ACCESS_TOKEN: CRED.TEST_TOKEN }), "mercadopago", CRED.PROD_SECRET);
  out.test_webhook_test_secret_prod_token = await webhook(production, envWith({ MERCADOPAGO_TEST_WEBHOOK_SECRET: CRED.TEST_SECRET, MERCADOPAGO_ACCESS_TOKEN: CRED.PROD_TOKEN }), "mercadopago_test", CRED.TEST_SECRET);
  // Controles positivos (provam que as recusas acima não são vazias).
  out.prod_webhook_both_signed_prod = await webhook(production, envWith("production", "test"), "mercadopago", CRED.PROD_SECRET);
  out.test_webhook_both_signed_test = await webhook(production, envWith("production", "test"), "mercadopago_test", CRED.TEST_SECRET);
  // Worker de certificação (sandbox): com credencial de produção presente recusa tudo; só com TESTE processa.
  out.cert_webhook_only_test = await webhook(certification, { ...CERT_ENV }, "mercadopago_test", CRED.TEST_SECRET, CERT_ORIGIN);
  out.cert_webhook_with_prod_token = await webhook(certification, { ...CERT_ENV, MERCADOPAGO_ACCESS_TOKEN: CRED.PROD_TOKEN }, "mercadopago_test", CRED.TEST_SECRET, CERT_ORIGIN);
  out.cert_webhook_with_prod_secret = await webhook(certification, { ...CERT_ENV, MERCADOPAGO_WEBHOOK_SECRET: CRED.PROD_SECRET }, "mercadopago_test", CRED.TEST_SECRET, CERT_ORIGIN);
  out.cert_webhook_production_provider = await webhook(certification, { ...CERT_ENV }, "mercadopago", CRED.TEST_SECRET, CERT_ORIGIN);
} catch (error) {
  out.error = String(error?.stack || error).slice(0, 600);
}
clearTimeout(timer);
console.log("PROBE_RESULT " + JSON.stringify({ out, blocked: [...new Set(blocked)] }));
process.exit(0);
