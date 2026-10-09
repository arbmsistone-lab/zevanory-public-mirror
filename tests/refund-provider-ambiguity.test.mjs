import test from "node:test";
import assert from "node:assert/strict";
import { handleRefundFlow } from "../worker/refund-flow.mjs";

const OID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "certification-only-test-token-0123456789abcdef";
const PAYMENT = "1353422739";
const key = "refund:req:" + OID;

function fixture(initial = {}) {
  const state = new Map([[key, JSON.stringify({
    status: "pending", order_id: OID, payment_id: PAYMENT,
    offer_id: "ZEV-IA-011", amount: 197, test: true, ...initial
  })]]);
  let updateCount = 0;
  const kv = {
    get: async (k) => state.get(k) ?? null,
    put: async (k, value) => { state.set(k, value); }
  };
  const env = {
    CERTIFICATION_E2E_TOKEN: TOKEN,
    MERCADOPAGO_TEST_ACCESS_TOKEN: "TEST-FAKE-NONSECRET",
    ZEVANORY_PRIVATE_ARTIFACTS: kv,
    DATABASE_URL: "postgres://mock.invalid/test"
  };
  const sqlFactory = () => ({ query: async (statement) => {
    if (statement.startsWith("update artifact_download_tokens")) updateCount++;
    return [];
  } });
  const invoke = async () => {
    const request = new Request("https://zevanory.api.br/api/internal/certification/e2e/refund-approve?order_id=" + OID, {
      method: "POST", headers: { "x-certification-e2e-token": TOKEN }
    });
    const response = await handleRefundFlow(request, env, { sqlFactory });
    return { code: response.status, body: await response.json() };
  };
  return { invoke, state, updates: () => updateCount };
}

async function withProviderStub(stub, run) {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /^https:\/\/api\.mercadopago\.com\/v1\/payments\/1353422739\/refunds$/);
      assert.equal(options.method, "POST");
      assert.equal(options.headers["x-idempotency-key"], "zevanory-refund-" + OID);
      assert.equal(options.headers["x-test-token"], "true");
      return stub();
    };
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("Mercado Pago 500 is ambiguous: retain request and block a second POST", async () => {
  const x = fixture();
  let calls = 0;
  await withProviderStub(() => {
    calls++;
    return Response.json({ message: "internal_error" }, { status: 500 });
  }, async () => {
    const first = await x.invoke();
    assert.equal(first.code, 502);
    assert.equal(JSON.parse(x.state.get(key)).status, "pending");
    assert.equal(JSON.parse(x.state.get(key)).provider_outcome_unknown, true);
    const second = await x.invoke();
    assert.equal(second.code, 409);
    assert.equal(second.body.error, "refund_provider_reconciliation_required");
    assert.equal(calls, 1);
    assert.equal(x.updates(), 0);
  });
});

test("network interruption is ambiguous and blocks any automatic replay", async () => {
  const x = fixture();
  let calls = 0;
  await withProviderStub(() => { calls++; throw new Error("connection lost"); }, async () => {
    const first = await x.invoke();
    assert.equal(first.code, 502);
    assert.equal(first.body.error, "mercadopago_refund_outcome_unknown");
    const second = await x.invoke();
    assert.equal(second.code, 409);
    assert.equal(calls, 1);
    assert.equal(x.updates(), 0);
  });
});

test("confirmed refund approves once, revokes delivery and subsequent call is idempotent", async () => {
  const x = fixture();
  let calls = 0;
  await withProviderStub(() => {
    calls++;
    return Response.json({ id: 12345, status: "approved" }, { status: 200 });
  }, async () => {
    const first = await x.invoke();
    assert.equal(first.code, 200);
    assert.equal(first.body.refund_id, "12345");
    assert.equal(x.updates(), 1);
    const second = await x.invoke();
    assert.equal(second.code, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(calls, 1);
  });
});

test("ambiguous previously recorded outcome never calls provider", async () => {
  const x = fixture({ provider_outcome_unknown: true });
  await withProviderStub(() => { throw new Error("must not make financial call"); }, async () => {
    const result = await x.invoke();
    assert.equal(result.code, 409);
    assert.equal(result.body.error, "refund_provider_reconciliation_required");
  });
});
