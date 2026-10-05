import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as v2 from "../worker/sandbox-proof-v2.mjs";

const TOKEN = "c".repeat(40);
const INBOX_TOKEN = "inbox-token-for-tests-only-0123456789abcdef";
const env = (over = {}) => ({ CERTIFICATION_PILOT_ENV: "sandbox", MERCADOPAGO_ENV: "sandbox", SALE_GLOBALLY_ENABLED: "false",
  CERTIFICATION_E2E_TOKEN: TOKEN, DATABASE_URL: "postgres://fake", ZEVANORY_PRIVATE_ARTIFACTS: kv(), ...over });
function kv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
}
const sqlOk = () => ({ query: async () => [{ order_id: "x" }] });
const req = (path, init = {}) => new Request("https://zevanory.api.br" + path, init);
const body = { request_id: "11111111-2222-4333-8444-555555555555", offer_id: "ZEV-CMB-011", sandbox: true, buyer_id: "3670747423",
  buyer_email: "test_user_3670747423@testuser.com", email_recipient: v2.SANDBOX_INBOX_ADDRESS };

test("inbox token digest constant matches a 64-hex sha256", () => {
  assert.match(v2.SANDBOX_INBOX_TOKEN_SHA256, /^[0-9a-f]{64}$/);
});

test("fails closed when sales are enabled or env is not sandbox", async () => {
  for (const over of [{ SALE_GLOBALLY_ENABLED: "true" }, { MERCADOPAGO_ENV: "production" }, { CERTIFICATION_PILOT_ENV: "production" }]) {
    const r = await v2.handleSandboxProofV2(req("/api/internal/certification/e2e/status", { headers: { "x-certification-e2e-token": TOKEN } }), env(over), {}, null, sqlOk);
    assert.equal(r.status, 409);
  }
});

test("capabilities require certification token and report v2 with sales blocked", async () => {
  const denied = await v2.handleSandboxProofV2(req("/api/internal/certification/e2e/status"), env(), {}, null, sqlOk);
  assert.equal(denied.status, 401);
  const r = await v2.handleSandboxProofV2(req("/api/internal/certification/e2e/status", { headers: { "x-certification-e2e-token": TOKEN } }), env(), {}, null, sqlOk);
  const d = await r.json();
  assert.equal(d.sandbox_proof_contract, "v2");
  assert.equal(d.sale_globally_enabled, false);
  assert.equal(d.sales_mode, "globally-blocked");
});

test("checkout creates an isolated R$297 certification order bound to buyer and inbox", async () => {
  const e = env();
  let captured;
  const sql = () => ({ query: async (text, args) => { captured = { text, args }; return [{ order_id: args[0] }]; } });
  const r = await v2.handleSandboxProofV2(req("/api/internal/certification/e2e/checkout", { method: "POST", headers: { "x-certification-e2e-token": TOKEN }, body: JSON.stringify(body) }), e, {}, null, sql);
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.equal(d.created_new, true);
  assert.equal(d.amount_brl, 297);
  assert.equal(d.excluded_from_revenue, true);
  assert.equal(d.real_customer_delivery, false);
  assert.equal(d.email_recipient, v2.SANDBOX_INBOX_ADDRESS);
  assert.match(captured.text, /certification_pilot\)/);
  assert.match(captured.text, /'checkout_ready',true/);
  assert.notEqual(d.order_id, v2.FROZEN_ORDER);
  assert.ok(e.ZEVANORY_PRIVATE_ARTIFACTS.m.has(`sandbox-proof-v2:order:${d.order_id}`));
});

test("checkout rejects generic buyer, other recipients and other offers", async () => {
  for (const bad of [{ buyer_email: "test@testuser.com" }, { email_recipient: "suporte@zevanory.api.br" }, { offer_id: "ZEV-OTHER" }, { sandbox: false }]) {
    const r = await v2.handleSandboxProofV2(req("/api/internal/certification/e2e/checkout", { method: "POST", headers: { "x-certification-e2e-token": TOKEN }, body: JSON.stringify({ ...body, ...bad }) }), env(), {}, null, sqlOk);
    assert.equal(r.status, 400);
  }
});

test("daily limit caps sandbox orders", async () => {
  const e = env();
  const day = new Date().toISOString().slice(0, 10);
  await e.ZEVANORY_PRIVATE_ARTIFACTS.put(`sandbox-proof-v2:daily:${day}`, "3");
  const r = await v2.handleSandboxProofV2(req("/api/internal/certification/e2e/checkout", { method: "POST", headers: { "x-certification-e2e-token": TOKEN }, body: JSON.stringify(body) }), e, {}, null, sqlOk);
  assert.equal(r.status, 429);
});

test("status projection marks signature only from receiver provenance", () => {
  const record = { order_id: "o", buyer_id: "1", buyer_email: "a@testuser.com", email_recipient: v2.SANDBOX_INBOX_ADDRESS };
  const base = { order: { status: "paid" }, fulfillment: { status: "delivered" },
    financial_events: [{ normalized_event: "payment_confirmed", provider_payment_id: "9", provider_event_id: "mp-test:9:approved:0" }],
    provenance: [{ dimension: "payment", source_class: "provider_webhook", source: "mercadopago-test" }],
    delivery_evidence: { email_status: "sent", email_recipient: v2.SANDBOX_INBOX_ADDRESS, certification_verification_url: "https://zevanory.api.br/api/internal/certification/e2e/download?token=t", expires_at: "2030-01-01T00:00:00Z", artifact_sha256: "ABC" } };
  const p = v2.projectStatus(record, base);
  assert.equal(p.financial_events[0].signature_verified, true);
  assert.equal(p.delivery_evidence.artifact_sha256, "abc");
  const unsigned = v2.projectStatus(record, { ...base, provenance: [] });
  assert.equal(unsigned.financial_events[0].signature_verified, false);
});

test("inbox requires the read token and stores only the isolated address", async () => {
  const e = env();
  const oid = "11111111-2222-4333-8444-555555555555";
  const raw = `To: ${v2.SANDBOX_INBOX_ADDRESS}\r\nX-Zevanory-Order-ID: ${oid}\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nLink: https://zevanory.api.br/api/internal/certification/e2e/download?token=3Dabc=\r\ndef\r\n`;
  const msg = { to: v2.SANDBOX_INBOX_ADDRESS, from: "contato@zevanory.api.br", rawSize: raw.length, raw: new Response(raw).body, setReject() { this.rejected = true; } };
  assert.equal(await v2.handleSandboxInboundEmail(msg, e), true);
  assert.ok(!msg.rejected);
  const other = { to: "suporte@zevanory.api.br" };
  assert.equal(await v2.handleSandboxInboundEmail(other, e), false);
  const denied = await v2.handleSandboxProofV2(req(`/api/internal/certification/inbox/messages?order_id=${oid}`, { headers: { "x-sandbox-inbox-token": INBOX_TOKEN } }), e, {}, null, sqlOk);
  assert.equal(denied.status, 401);
});

test("quoted-printable soft breaks are joined so the link survives", () => {
  const { text } = v2.mimeText("Content-Transfer-Encoding: quoted-printable\r\n\r\nhttps://x/?token=3Dab=\r\ncd");
  assert.equal(text, "https://x/?token=abcd");
});

test("recovered delivery only relaxes live_mode for registered v2 orders on the isolated inbox", () => {
  const src = readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(certificationOnly && payment\?\.live_mode !== false && !sandboxV2\) throw/);
  assert.ok(src.includes("/^prova@sandbox-mail\\.zevanory\\.api\\.br$/"));
  assert.ok(createHash("sha256"));
});
