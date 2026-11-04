// DEC-06 (Claude): na fase 1 o produto integral é liberado para download na área de compras da Hotmart logo após a
// aprovação. A liberação diferida de 192 h fica PRESERVADA e INATIVA atrás de KIT_DEFERRED_192H_ENABLED
// (worker/kit-deferred-192h-flag.mjs). Estes testes provam que a flag nasce desligada (fail-closed) e que, desligada,
// nenhuma rota/entrada do módulo diferido libera evento, alarme, e-mail ou download. Os testes unitários do próprio
// módulo (scripts/kit-192h-*.test.mjs, scripts/ci/nc015-kit-e2e.test.mjs) ligam a flag EXPLICITAMENTE no harness.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_DEFERRED_192H_DEFAULT, KIT_DEFERRED_192H_FLAG, kitDeferred192hEnabled } from "../worker/kit-deferred-192h-flag.mjs";
import { createKitHarness, INTERNAL_KEY } from "../scripts/ci/nc015-kit-harness.mjs";
import { downloadVerifiedKitCandidate, handleKitDownloadNc015, KIT_DOWNLOAD_ENABLED } from "../worker/kit-nc015-download.mjs";
import { sendKitMailCandidate, sendKitMailConfigured } from "../worker/kit-nc015-resend.mjs";
import { ingestVerifiedKitCandidate, KIT_ORDER_INGEST_ENABLED } from "../worker/kit-nc015-ingress.mjs";
import salesWorker from "../worker/sales-public-worker.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readTextNormalized(join(ROOT, p));

test("DEC-06 flag: default OFF and fail-closed for every value except exactly \"true\"", () => {
  assert.equal(KIT_DEFERRED_192H_FLAG, "KIT_DEFERRED_192H_ENABLED");
  assert.equal(KIT_DEFERRED_192H_DEFAULT, false);
  for (const env of [undefined, null, {}, { KIT_DEFERRED_192H_ENABLED: "" }, { KIT_DEFERRED_192H_ENABLED: "1" },
    { KIT_DEFERRED_192H_ENABLED: "TRUE" }, { KIT_DEFERRED_192H_ENABLED: "yes" }, { KIT_DEFERRED_192H_ENABLED: " true" },
    { KIT_DEFERRED_192H_ENABLED: false }, { KIT_DEFERRED_192H_ENABLED: 1 }]) {
    assert.equal(kitDeferred192hEnabled(env), false, JSON.stringify(env));
  }
  assert.equal(kitDeferred192hEnabled({ KIT_DEFERRED_192H_ENABLED: "true" }), true);
  assert.equal(kitDeferred192hEnabled({ KIT_DEFERRED_192H_ENABLED: true }), true);
  // Source locks of the public routes stay off as well (double lock).
  assert.equal(KIT_DOWNLOAD_ENABLED, false);
  assert.equal(KIT_ORDER_INGEST_ENABLED, false);
});

test("DEC-06 flag: no deploy configuration or workflow turns the deferred 192 h release on", () => {
  const files = ["wrangler.sales.toml", "wrangler.public-router.toml",
    ...readdirSync(join(ROOT, ".github/workflows")).map((f) => ".github/workflows/" + f)];
  for (const f of files) assert.doesNotMatch(read(f), /KIT_DEFERRED_192H_ENABLED/, f);
});

test("DEC-06 flag OFF: release DO refuses events and its alarm releases nothing", async () => {
  const h = createKitHarness({ deferred: false });
  const r = await h.call("/internal/event", { event_key: "hotmart:approved:dec06-0001", event_type: "PURCHASE_APPROVED", approved_at_ms: h.at });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "kit_deferred_192h_disabled");
  for (const [path, method] of [["/internal/reference", "GET"], ["/internal/grant", "POST"], ["/internal/download-claim", "POST"], ["/internal/email-claim", "POST"]]) {
    assert.equal((await h.call(path, { now_ms: h.eligibleAt }, method)).status, 503, path);
  }
  const before = JSON.stringify(h.object.ledger.state());
  await h.object.alarm(h.eligibleAt);
  assert.equal(JSON.stringify(h.object.ledger.state()), before, "alarm is a no-op");
  assert.equal(h.alarms.length, 0, "no alarm scheduled");
});

test("DEC-06 flag OFF: /kit/baixar download, ingestion and Resend outbox return 503/disabled even fully configured", async () => {
  // Build a READY order with the flag on, then switch it off: nothing may leave the module.
  const h = createKitHarness({ deferred: true });
  const { link } = await h.ready();
  const off = { ...h.env };
  delete off.KIT_DEFERRED_192H_ENABLED;
  assert.equal((await handleKitDownloadNc015(new Request(link), off)).status, 503);
  assert.equal((await handleKitDownloadNc015(new Request(link), h.env)).status, 503, "source lock KIT_DOWNLOAD_ENABLED=false still applies with the flag on");
  const d = await downloadVerifiedKitCandidate({ request: new Request(link), env: off, now: h.eligibleAt + 1000, enabled: true, fetcher: h.hotmartFetch });
  assert.equal(d.status, 503);
  assert.equal(h.object.ledger.downloadCount(), 0, "no download slot consumed");
  const mailEnv = { ...off, RESEND_API_KEY: "test-only-resend-token-not-live-12345678", KIT_FROM_EMAIL: "entregas@zevanory.api.br" };
  let sent = 0;
  const fake = async () => { sent++; return Response.json({ id: "mail-dec06-never" }); };
  assert.equal((await sendKitMailCandidate({ stub: h.stub, env: mailEnv, recipient: "customer@example.invalid", downloadLink: link, enabled: true, fetcher: fake })).code, "RESEND_DISABLED");
  assert.equal((await sendKitMailConfigured({ stub: h.stub, env: mailEnv, recipient: "customer@example.invalid", downloadLink: link, fetcher: fake })).code, "RESEND_DISABLED");
  assert.equal(sent, 0);
  const ing = await ingestVerifiedKitCandidate(new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", body: "{}" }), { ...off, INTERNAL_DO_SIGNING_KEY: INTERNAL_KEY });
  assert.equal(ing.status, 503);
  assert.equal((await ing.json()).error, "kit_deferred_192h_disabled");
});

test("DEC-06 flag OFF: Worker routes keep the deferred kit paths closed (central 503, sales host 404)", async () => {
  const compat = read("worker/cloudflare-worker.compat.mjs");
  assert.match(compat, /if \(url\.pathname === "\/kit\/baixar"\) return handleKitDownloadNc015\(request,normalized\);/);
  const routing = read("worker/cp-nc011-routing.mjs");
  assert.match(routing, /if\(KIT_ORDER_INGEST_ENABLED&&kitDeferred192hEnabled\(env\)&&isKitProductNc015\(body\?\.data,env\)\)\{/);
  const env = { CORE: { fetch: async () => Response.json({ open: true }) }, ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  for (const path of ["/kit/baixar?t=v1.abc", "/entrega/kit", "/kit/liberar"]) {
    const r = await salesWorker.fetch(new Request("https://vendas.zevanory.api.br" + path), env, { waitUntil() {} });
    assert.equal(r.status, 404, path);
  }
});

test("DEC-06 flag ON in the harness: the preserved 192 h module still releases exactly at 192 h", async () => {
  const h = createKitHarness({ deferred: true });
  const { grant } = await h.ready();
  assert.equal(grant.code, "grant_pending_email");
  assert.equal(grant.release_at_ms, h.at + 192 * 3600000);
});
