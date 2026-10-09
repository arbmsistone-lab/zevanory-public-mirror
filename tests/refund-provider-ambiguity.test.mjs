import test from "node:test";
import assert from "node:assert/strict";
import { handleRefundFlow, runRefundWatchdog, reconcileRefund } from "../worker/refund-flow.mjs";

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
  let claimCount = 0;
  let claim = null;
  let databaseDown = false;
  let crashBeforePersist = false;
  let failRevocation = false;
  const kv = {
    get: async (k) => state.get(k) ?? null,
    put: async (k, value) => { if (crashBeforePersist && k === key) { crashBeforePersist = false; throw new Error("worker_killed_before_kv"); } state.set(k, value); },
    list: async () => ({ keys: [...state.keys()].filter((k) => k.startsWith("refund:req:")).map((name) => ({ name })), list_complete: true }),
  };
  const env = {
    CERTIFICATION_E2E_TOKEN: TOKEN,
    MERCADOPAGO_TEST_ACCESS_TOKEN: "TEST-FAKE-NONSECRET",
    ZEVANORY_PRIVATE_ARTIFACTS: kv,
    DATABASE_URL: "postgres://mock.invalid/test"
  };
  const sqlFactory = () => ({ query: async (statement, args = []) => {
    if (databaseDown) throw Error("database unavailable");
    if (statement.startsWith("create table if not exists refund_provider_claims")) return [];
    if (statement.startsWith("select order_id,payment_id,test,stage,claimed_at")) return claim ? [{ ...claim }] : [];
    if (statement.startsWith("insert into refund_provider_claims")) {
      if (claim) return [];
      claim = { order_id: args[0], payment_id: args[1], test: args[2], stage:
        statement.includes("legacy_unknown") ? "legacy_unknown" : "provider_call_may_have_been_sent",
        claimed_at: new Date().toISOString(), reconciled_at: null, reconciled_status: null };
      claimCount++;
      return [{ order_id: OID }];
    }
    if (statement.startsWith("update refund_provider_claims") && statement.includes("retry_call_may_have_been_sent")) {
      if (claim?.stage !== "reconciled_not_refunded" || claim?.reconciled_status !== "not_refunded") return [];
      claim.stage = "retry_call_may_have_been_sent"; claim.reconciled_status = "retry_sent";
      return [{ order_id: OID }];
    }
    if (statement.startsWith("update refund_provider_claims") && statement.includes("reconciled_not_refunded")) {
      if (!claim || !["provider_call_may_have_been_sent", "legacy_unknown"].includes(claim.stage) ||
          claim.reconciled_status != null || Date.now() - Date.parse(claim.claimed_at) < 30 * 60 * 1000) return [];
      claim.stage = "reconciled_not_refunded"; claim.reconciled_status = "not_refunded";
      return [{ order_id: OID }];
    }
    if (statement.startsWith("update refund_provider_claims") && statement.includes("reconciled_refunded")) {
      if (claim) { claim.stage = "reconciled_refunded"; claim.reconciled_status = "approved"; }
      return [];
    }
    if (statement.startsWith("update artifact_download_tokens")) {
      if (failRevocation) throw new Error("neon unavailable");
      updateCount++;
      return [];
    }
    return [];
  } });
  const invoke = async () => {
    const request = new Request("https://zevanory.api.br/api/internal/certification/e2e/refund-approve?order_id=" + OID, {
      method: "POST", headers: { "x-certification-e2e-token": TOKEN }
    });
    const response = await handleRefundFlow(request, env, { sqlFactory });
    return { code: response.status, body: await response.json() };
  };
  const reject = async () => {
    const response = await handleRefundFlow(new Request("https://zevanory.api.br/admin/refunds/action", {
      method: "POST", headers: { origin: "https://zevanory.api.br", "content-type": "application/x-www-form-urlencoded" },
      body: "order_id=" + OID + "&action=reject"
    }), env, { sqlFactory, isAdminAuthorized: () => true });
    return response.status;
  };
  const watchdog = () => runRefundWatchdog(env, Date.now(), { sqlFactory });
  const reconcile = () => reconcileRefund(env, sqlFactory(), kv, OID);
  return { invoke, reject, watchdog, reconcile, state, env, updates: () => updateCount,
    claims: () => claimCount, claim: () => claim,
    setClaimAgeMinutes: (n) => { claim.claimed_at = new Date(Date.now() - n * 60000).toISOString(); },
    setDbFailure: (v) => { databaseDown = v; },
    killAfterPost: () => { crashBeforePersist = true; },
    setRevocationFailure: (v) => { failRevocation = v; } };
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

test("concurrent approvals race on durable Neon claim: only one provider POST", async () => {
  const x = fixture();
  let calls = 0;
  await withProviderStub(async () => {
    calls++;
    await Promise.resolve();
    return Response.json({ id: 12345, status: "approved" }, { status: 200 });
  }, async () => {
    const results = await Promise.all([x.invoke(), x.invoke()]);
    assert.deepEqual(results.map((r) => r.code).sort(), [200, 409]);
    assert.equal(calls, 1);
    assert.equal(x.claims(), 1);
  });
});

test("legacy 500 remains blocked without the new KV ambiguity marker", async () => {
  const x = fixture({ last_error: "mercadopago_refund_500_internal_error" });
  await withProviderStub(() => { throw new Error("never retry legacy provider 500"); }, async () => {
    const out = await x.invoke();
    assert.equal(out.code, 409);
    assert.equal(await x.reject(), 409);
    assert.equal(x.claims(), 0);
  });
});

test("admin rejection is blocked once a durable financial claim exists", async () => {
  const x = fixture();
  await withProviderStub(() => Response.json({ message: "internal_error" }, { status: 500 }), async () => {
    assert.equal((await x.invoke()).code, 502);
    assert.equal(await x.reject(), 409);
    assert.equal(JSON.parse(x.state.get(key)).status, "pending");
    assert.equal(x.claims(), 1);
  });
});

test("revocation outage never repeats the provider POST; duplicate request repairs Neon", async () => {
  const x = fixture();
  x.setRevocationFailure(true);
  let calls = 0;
  await withProviderStub(() => {
    calls++;
    return Response.json({ id: 22222, status: "approved" }, { status: 200 });
  }, async () => {
    assert.equal((await x.invoke()).code, 503);
    assert.equal(JSON.parse(x.state.get(key)).download_revocation_pending, true);
    x.setRevocationFailure(false);
    const replay = await x.invoke();
    assert.equal(replay.code, 200);
    assert.equal(replay.body.duplicate, true);
    assert.equal(x.updates(), 1);
    assert.equal(calls, 1);
  });
});

test("hourly watchdog independently repairs failed download revocation without financial POST", async () => {
  const x = fixture();
  x.setRevocationFailure(true);
  await withProviderStub(() => Response.json({ id: 33333, status: "approved" }, { status: 200 }), async () => {
    assert.equal((await x.invoke()).code, 503);
  });
  x.setRevocationFailure(false);
  const recovered = await x.watchdog();
  assert.equal(recovered.ok, true);
  assert.equal(JSON.parse(x.state.get(key)).download_revocation_pending, false);
  assert.equal(x.updates(), 1);
});

test("nonterminal 200 refund is ambiguous and cannot produce false approval", async () => {
  const x = fixture();
  await withProviderStub(() => Response.json({ id: 44444, status: "pending" }, { status: 200 }), async () => {
    const out = await x.invoke();
    assert.equal(out.code, 502);
    assert.equal(JSON.parse(x.state.get(key)).provider_outcome_unknown, true);
    assert.equal((await x.invoke()).code, 409);
  });
});


const cleanPayment = (extra = {}) => ({
  id: Number(PAYMENT), status: "approved", status_detail: "accredited",
  transaction_amount: 197, transaction_amount_refunded: 0, refunds: [], ...extra
});
async function withPaymentStub(post, payment, run) {
  const original = globalThis.fetch;
  const calls = { get: 0, post: 0 };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    assert.equal(options.headers["x-test-token"], "true");
    if (method === "GET") {
      assert.equal(String(url), "https://api.mercadopago.com/v1/payments/" + PAYMENT);
      calls.get++;
      return Response.json(typeof payment === "function" ? payment() : payment, { status: 200 });
    }
    assert.equal(method, "POST");
    assert.equal(String(url), "https://api.mercadopago.com/v1/payments/" + PAYMENT + "/refunds");
    assert.equal(options.headers["x-idempotency-key"], "zevanory-refund-" + OID);
    calls.post++;
    return post();
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}
for (const status of [500, 502]) {
  test("HTTP " + status + " never causes a second provider POST", async () => {
    const x = fixture();
    await withPaymentStub(() => Response.json({ error: "provider_down" }, { status }),
      cleanPayment(), async (calls) => {
        assert.equal((await x.invoke()).code, 502);
        assert.equal((await x.invoke()).code, 409);
        assert.equal(await x.reject(), 409);
        assert.equal(calls.post, 1);
        assert.equal(x.updates(), 0);
      });
  });
}
test("database initialization/claim fails closed before any provider request", async () => {
  const x = fixture(); x.setDbFailure(true);
  await withPaymentStub(() => { throw Error("no POST"); }, cleanPayment(), async (calls) => {
    assert.equal((await x.invoke()).code, 503);
    assert.equal(calls.post, 0);
  });
});
test("provider timeout and network loss remain ambiguous, with no automatic replay", async () => {
  for (const error of ["AbortError: timeout", "ECONNRESET"]) {
    const x = fixture();
    await withPaymentStub(() => { throw Error(error); }, cleanPayment(), async (calls) => {
      assert.equal((await x.invoke()).code, 502);
      assert.equal((await x.invoke()).code, 409);
      assert.equal(calls.post, 1);
    });
  }
});
test("worker death after approved POST is recovered from GET only and revokes downloads", async () => {
  const x = fixture();
  x.killAfterPost();
  await withPaymentStub(() => Response.json({ id: 31337, status: "approved" }),
    cleanPayment({ status: "refunded", status_detail: "refunded", transaction_amount_refunded: 197,
      refunds: [{ id: 31337, status: "approved", amount: 197 }] }),
    async (calls) => {
      assert.equal((await x.invoke()).code, 503);
      assert.equal(JSON.parse(x.state.get(key)).status, "pending");
      const recovered = await x.reconcile();
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.refund_id, "31337");
      assert.equal(x.updates(), 1);
      assert.equal(calls.post, 1);
      assert.equal(calls.get, 1);
    });
});
test("reconciliation a: full approved refund is confirmed by GET and downloads revoked", async () => {
  const x = fixture();
  await withPaymentStub(() => Response.json({ error: "upstream" }, { status: 500 }),
    cleanPayment({ status: "refunded", status_detail: "refunded", transaction_amount_refunded: 197,
      refunds: [{ id: "abc-refund", status: "approved", amount: 197 }] }), async (calls) => {
      assert.equal((await x.invoke()).code, 502);
      const r = await x.reconcile();
      assert.equal(r.status, 200);
      assert.equal(r.body.refund_id, "abc-refund");
      assert.equal(JSON.parse(x.state.get(key)).status, "approved");
      assert.equal(x.claim().stage, "reconciled_refunded");
      assert.equal(x.updates(), 1);
      assert.equal(calls.post, 1);
    });
});
test("reconciliation b: proven absent >30min permits only one explicit retry with same key", async () => {
  const x = fixture();
  let nextApproved = false;
  await withPaymentStub(() => nextApproved ?
      Response.json({ id: 8001, status: "approved" }) :
      Response.json({ error: "upstream" }, { status: 500 }),
    cleanPayment(), async (calls) => {
      assert.equal((await x.invoke()).code, 502);
      x.setClaimAgeMinutes(31);
      const r = await x.reconcile();
      assert.equal(r.status, 200);
      assert.equal(r.body.retry_permitted, true);
      assert.equal(calls.post, 1);
      nextApproved = true;
      assert.equal((await x.invoke()).code, 200);
      assert.equal((await x.invoke()).body.duplicate, true);
      assert.equal(calls.post, 2);
      assert.equal(x.claim().stage, "reconciled_refunded");
    });
});
test("reconciliation b: after a failed single retry, no third POST may be armed", async () => {
  const x = fixture();
  await withPaymentStub(() => Response.json({ error: "provider" }, { status: 502 }),
    cleanPayment(), async (calls) => {
      assert.equal((await x.invoke()).code, 502);
      x.setClaimAgeMinutes(31);
      assert.equal((await x.reconcile()).body.retry_permitted, true);
      assert.equal((await x.invoke()).code, 502);
      assert.equal(x.claim().reconciled_status, "retry_sent");
      assert.equal((await x.reconcile()).status, 409);
      assert.equal((await x.invoke()).code, 409);
      assert.equal(calls.post, 2);
    });
});
test("reconciliation c: missing refunds, missing refunded amount or mismatched amount stay ambiguous", async () => {
  for (const mutation of [
    { refunds: undefined },
    { transaction_amount_refunded: undefined },
    { transaction_amount: 187 }
  ]) {
    const x = fixture();
    await withPaymentStub(() => Response.json({ error: "upstream" }, { status: 500 }),
      cleanPayment(mutation), async (calls) => {
        assert.equal((await x.invoke()).code, 502);
        x.setClaimAgeMinutes(31);
        const res = await x.reconcile();
        assert.equal(res.status, 409);
        assert.ok(res.body.missing.length > 0);
        assert.equal((await x.invoke()).code, 409);
        assert.equal(calls.post, 1);
      });
  }
});
test("in_process refund cannot approve or permit another POST until terminal GET", async () => {
  const x = fixture();
  await withPaymentStub(() => Response.json({ id: 404, status: "in_process" }),
    cleanPayment({ transaction_amount_refunded: 197, refunds: [{ id: 404, status: "in_process", amount: 197 }] }), async (calls) => {
      assert.equal((await x.invoke()).code, 502);
      x.setClaimAgeMinutes(31);
      const r = await x.reconcile();
      assert.equal(r.status, 409);
      assert.ok(r.body.missing.includes("refund_not_terminal"));
      assert.equal(calls.post, 1);
      assert.equal(x.updates(), 0);
    });
});
test("claim younger than 30 min cannot authorize POST even when provider sees no refunds", async () => {
  const x = fixture();
  await withPaymentStub(() => Response.json({ error: "error" }, { status: 500 }),
    cleanPayment(), async (calls) => {
      assert.equal((await x.invoke()).code, 502);
      const r = await x.reconcile();
      assert.equal(r.status, 409);
      assert.ok(r.body.missing.includes("claim_younger_than_30_minutes"));
      assert.equal(calls.post, 1);
    });
});
test("legacy 500 is recovered via durable legacy_unknown claim, not a fresh POST", async () => {
  const x = fixture({ last_error: "mercadopago_refund_500_upstream" });
  await withPaymentStub(() => { throw Error("unexpected POST"); }, cleanPayment(), async (calls) => {
    assert.equal((await x.invoke()).code, 409);
    const r = await x.reconcile();
    assert.equal(r.status, 409);
    assert.equal(x.claim().stage, "legacy_unknown");
    assert.equal(calls.post, 0);
  });
});
test("watchdog never refunds automatically; it only reconciles with provider GET", async () => {
  const x = fixture();
  await withPaymentStub(() => Response.json({ error: "provider" }, { status: 500 }),
    cleanPayment(), async (calls) => {
      assert.equal((await x.invoke()).code, 502);
      x.setClaimAgeMinutes(31);
      const result = await x.watchdog();
      assert.equal(result.reconciled, 1);
      assert.equal(calls.get, 1);
      assert.equal(calls.post, 1);
    });
});


test("invalid provider-approved refund amount must never release download", async () => {
  const x = fixture();
  await withPaymentStub(() => Response.json({ id: 999, status: "approved", amount: "not-a-number" }),
    cleanPayment(), async (calls) => {
      assert.equal((await x.invoke()).code, 502);
      assert.equal(JSON.parse(x.state.get(key)).status, "pending");
      assert.equal(x.updates(), 0);
      assert.equal(calls.post, 1);
    });
});
test("watchdog repairs an approved refund after Worker dies before KV persistence, via GET alone", async () => {
  const x = fixture();
  x.killAfterPost();
  await withPaymentStub(() => Response.json({ id: 5555, status: "approved" }),
    cleanPayment({ status: "refunded", status_detail: "refunded", transaction_amount_refunded: 197,
      refunds: [{ id: 5555, status: "approved", amount: 197 }] }), async (calls) => {
      assert.equal((await x.invoke()).code, 503);
      assert.equal(JSON.parse(x.state.get(key)).provider_outcome_unknown, undefined);
      const result = await x.watchdog();
      assert.equal(result.reconciled, 1);
      assert.equal(JSON.parse(x.state.get(key)).status, "approved");
      assert.equal(x.updates(), 1);
      assert.equal(calls.post, 1);
      assert.equal(calls.get, 1);
    });
});
test("download revocation pending alert is bounded to one email per 12h KV window", async () => {
  const x = fixture({ status: "approved", test: false, download_revocation_pending: true });
  x.setRevocationFailure(true);
  x.env.RESEND_API_KEY = "mock-resend-key";
  const original = globalThis.fetch;
  let emails = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.resend.com/emails");
    assert.equal(options.method, "POST");
    emails++;
    return Response.json({ id: "mock-sent" }, { status: 200 });
  };
  try {
    assert.equal((await x.watchdog()).revocation_pending, 1);
    assert.equal((await x.watchdog()).revocation_pending, 1);
    assert.equal(emails, 1);
    assert.ok(x.state.has("refund:watchdog:revocation:last"));
  } finally { globalThis.fetch = original; }
});
