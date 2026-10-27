import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const doc = read("../docs/ops/p22-proof-renewal-investigation.md");
const workflow = read("../.github/workflows/order12a-financial-proof-renewal.yml");
const worker = read("../worker/cloudflare-worker.compat.mjs");
const economy = read("../worker/db-economy.mjs");
const projection = read("../worker/commercial-metrics-projection.mjs");
const collector = read("../scripts/b0/b0-lib.mjs");
const renewal = read("../scripts/financial_proof_renewal.py");

test("diagnosis is anchored to the configured TTL and both real producers", () => {
  assert.match(collector, /P22_TTL_MIN = 65/);
  assert.match(projection, /MAX_AGE_MS=65\*60\*1000/);
  assert.match(workflow, /cron: "11,41 \* \* \* \*"/);
  assert.match(worker, /controller\?\.cron === "15,45 \* \* \* \*"/);
  assert.match(worker, /refreshFinancialProofSnapshot\(normalized, \{\s*sqlFactory: whatsappProofDatabase, force: true/);
  assert.match(worker, /persistClassificationSnapshot\(normalized/);
  assert.match(renewal, /AUDIT_PATH = "\/api\/internal\/audit\/financial-classification"/);
  assert.match(renewal, /OWNER_SALES_SWITCH_NOT_OPEN/);
});

test("six-hour pulse follows the closed-sales database economy rule", () => {
  assert.match(economy, /getUTCHours\(\) % 6 === 0 && at\.getUTCMinutes\(\) < 30/);
  for (const tick of ["00:15", "06:15", "12:15", "18:15"])
    assert.match(doc, new RegExp(tick.replace(":", "\\:")));
  assert.match(doc, /31 `PROVEN` e 146\s+`UNVERIFIED_FAIL_CLOSED`/);
});

test("proposal is explicitly independent of GitHub schedule and not activated", () => {
  assert.match(doc, /Status: \*\*diagnóstico e proposta; nada ativado\*\*/);
  assert.match(doc, /cron já existente do Worker da\s+Cloudflare/);
  assert.match(doc, /não usar `force: true`/);
  assert.match(doc, /Sol e o proprietário/);
  assert.match(doc, /não muda cron, workflow, chave, credencial, flag comercial ou\s+runtime/);
});
