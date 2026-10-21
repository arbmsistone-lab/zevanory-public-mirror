import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import worker from "../sandbox/rollback-secret-probe/worker.mjs";

const NONCE = "zevanory-b01-rollback-secret-probe-v1:";

test("probe returns only the nonce-prefixed SHA-256 digest", async () => {
  const secret = "offline-test-secret";
  const response = await worker.fetch(new Request("https://probe.test/probe"), {
    PROBE_SECRET: secret,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).trim(), createHash("sha256").update(NONCE + secret).digest("hex"));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("non-probe routes are unavailable", async () => {
  const response = await worker.fetch(new Request("https://probe.test/"), {
    PROBE_SECRET: "offline-test-secret",
  });
  assert.equal(response.status, 404);
});

test("missing probe secret fails closed", async () => {
  const response = await worker.fetch(new Request("https://probe.test/probe"), {});
  assert.equal(response.status, 503);
});
