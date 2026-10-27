import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const doc = read("../docs/ops/p22-proof-renewal-investigation.md");
const workflow = read("../.github/workflows/order12a-financial-proof-renewal.yml");
const worker = read("../worker/cloudflare-worker.compat.mjs");
const recovered = read("../worker/cloudflare-worker.recovered.mjs");
const economy = read("../worker/db-economy.mjs");
const projection = read("../worker/commercial-metrics-projection.mjs");
const audit = read("../worker/internal-financial-audit.mjs");
const collector = read("../scripts/b0/b0-lib.mjs");
const renewal = read("../scripts/financial_proof_renewal.py");
const flat = doc.replace(/\s+/g, " ");

// Hourly branch of scheduled(): everything after the isolated "15,45" branch returns.
const hourly = worker.slice(worker.indexOf("let supportOverdue = false;"), worker.indexOf("wrapped.email ="));

// Age (minutes) of the proof when the next renewal happens, ticks every `cadence` minutes,
// renewal on the first tick whose age >= floor, `failed` consecutive renewal ticks failing.
function renewalAge(cadence, floor, failed = 0) {
  let age = cadence;
  while (age < floor) age += cadence;
  return age + failed * cadence;
}

test("diagnosis is anchored to the configured TTL and all three producers", () => {
  assert.match(collector, /P22_TTL_MIN = 65/);
  assert.match(projection, /MAX_AGE_MS=65\*60\*1000/);
  assert.match(projection, /MIN_REFRESH_MS=50\*60\*1000/);
  assert.match(workflow, /cron: "11,41 \* \* \* \*"/);
  assert.match(worker, /controller\?\.cron === "15,45 \* \* \* \*"/);
  assert.match(worker, /refreshFinancialProofSnapshot\(normalized, \{\s*sqlFactory: whatsappProofDatabase, force: true/);
  assert.match(worker, /persistClassificationSnapshot\(normalized/);
  assert.match(renewal, /AUDIT_PATH = "\/api\/internal\/audit\/financial-classification"/);
  assert.match(renewal, /OWNER_SALES_SWITCH_NOT_OPEN/);
  assert.match(flat, /Há três caminhos que tentam produzir/);
  assert.match(flat, /cron horário `0 \* \* \* \*` \(produtor que falha em silêncio\)/);
});

test("hourly producer: no economy gate, no force, hourly DB and list, unverified writes", () => {
  assert.ok(hourly.length > 0, "hourly branch located");
  assert.match(hourly, /recordLaunchEpoch\(normalized, salesSwitchState\)\s*\.then\(\(\) => refreshFinancialProofSnapshot\(normalized, \{ sqlFactory: whatsappProofDatabase \}\)\)/);
  assert.doesNotMatch(hourly, /dbEconomySkip/);
  assert.doesNotMatch(hourly, /force: true/);
  assert.match(hourly, /await runSalesPreflight\(normalized\)/);
  assert.match(recovered, /query\("select 1", \[\]\)/);
  assert.match(recovered, /kv\.list\(\{ prefix: PREFIX, limit: 100 \}\)/);
  // Failed audit with no valid prior proof persists an unverified snapshot.
  assert.match(projection, /if\(audited\?\.code===409\|\|!priorValid\)\{\s*await kv\.put\(COMMERCIAL_PROOF_KV_KEY/);
  assert.match(audit, /remaining:46/);
  assert.match(hourly, /Too many subrequests by single Worker invocation/);
  assert.match(flat, /24 `select 1`, 24 `list` e 24 gravações por dia/);
  assert.match(flat, /até cerca de 20 gravações por dia/);
  assert.match(flat, /nunca produziu `PROVEN`/);
  assert.match(flat, /Hipótese \(não verificada/);
  assert.match(flat, /Too many subrequests by single Worker invocation/);
  assert.match(flat, /invalidaria uma prova válida/);
});

test("six-hour pulse follows the closed-sales database economy rule; DB count corrected", () => {
  assert.match(economy, /getUTCHours\(\) % 6 === 0 && at\.getUTCMinutes\(\) < 30/);
  for (const tick of ["00:15", "06:15", "12:15", "18:15"])
    assert.match(doc, new RegExp(tick.replace(":", "\\:")));
  assert.match(doc, /31 `PROVEN` e 146\s+`UNVERIFIED_FAIL_CLOSED`/);
  assert.match(flat, /4 auditorias\/dia \(8 instruções SQL\)/);
  assert.match(flat, /vale só para o ramo isolado/);
  assert.match(flat, /8 \+ até 40 \+ 24 instruções SQL/);
  assert.doesNotMatch(flat, /de 4 para aproximadamente 24/);
});

test("margin math: revision 1 had ~5 min, recommended design survives one failed tick", () => {
  assert.equal(renewalAge(30, 50), 60);
  assert.equal(renewalAge(30, 50, 1), 90);
  assert.equal(renewalAge(30, 25, 1), 60);
  assert.equal(renewalAge(15, 40), 45);
  assert.equal(renewalAge(15, 40, 1), 60);
  assert.equal(renewalAge(15, 25), 30);
  assert.equal(renewalAge(15, 25, 1), 45);
  assert.ok(65 - renewalAge(15, 25, 1) >= 20, "recommended keeps >= 20 min margin after one failure");
  assert.ok(renewalAge(30, 50, 1) > 65, "revision 1 expires after one failed tick");
  assert.match(flat, /com idade \*\*60\*\*: a margem nominal é de cerca de \*\*5 minutos\*\*/);
  assert.match(flat, /\| \*\*Tiques de 15 min, piso 25 \(recomendado\)\*\* \| \*\*30 \(margem 35\)\*\* \| \*\*45 \(margem 20\)\*\*/);
  assert.match(flat, /\| Revisão 1: tiques de 30 min \(`15,45`\), piso 50 \| 60 \(margem 5\) \| 90: vence/);
  assert.doesNotMatch(flat, /margem nominal de 15 minutos/);
  assert.match(flat, /até 60 segundos/);
});

test("proposal: 15-min cadence, floor dedup, no KV reservation, hourly proof removed", () => {
  assert.match(flat, /`10,25,40,55 \* \* \* \*`/);
  assert.match(flat, /Continua sendo um único Cron Trigger/);
  assert.match(flat, /Piso de 25 minutos, sem `force: true`/);
  assert.match(flat, /\*\*Sem reserva no KV:\*\* o KV não tem compare-and-set/);
  assert.doesNotMatch(flat, /reserva idempotente/);
  assert.match(flat, /Tirar a prova do ramo horário/);
  // Today last-isolated-run is written on every non-skipped run; the proposal restricts it.
  assert.match(worker, /put\?\.\("zpc:financial-proof:last-isolated-run:v1"/);
  assert.match(flat, /`zpc:financial-proof:last-isolated-run:v1` só depois de uma auditoria real/);
  assert.match(flat, /limitado a no máximo um por hora/);
});

test("cost table quantifies Workers, Neon and KV against verified Free limits", () => {
  assert.match(flat, /\| Invocações de cron do Worker central \| 120 \(24 \+ 48 \+ 48\) \| 168 \(24 \+ 96 \+ 48\) \| \+48 \|/);
  assert.match(flat, /\| Instruções SQL no Neon \(prova\) \| 8 \+ até 40 \| 96 \|/);
  assert.match(flat, /\| Gravações no KV \| cerca de 56 .*\| cerca de 120 .*\| \+64 \(ou \+18\) \| 1\.000\/dia/);
  assert.match(flat, /\| Leituras no KV \| cerca de 148 .*\| cerca de 240 .*\| \+92 \| 100\.000\/dia/);
  assert.match(flat, /\| `list` no KV \| 0 da prova/);
  assert.match(flat, /\| `delete` no KV \| 0 \| 0 \| 0 \| 1\.000\/dia \|/);
  assert.match(flat, /100\.000 leituras, 1\.000 gravações, 1\.000 exclusões e 1\.000 `list` por dia/);
  assert.match(flat, /50 subrequisições externas/);
  assert.match(flat, /developers\.cloudflare\.com\/kv\/platform\/limits\//);
});

test("KV daily-limit alert section: measured data, list hypothesis, proposals only", () => {
  assert.match(doc, /## Alerta de limite diário do KV/);
  assert.match(flat, /\| 24\/10 \| 694 \| 41\.431 \|/);
  assert.match(flat, /\*\*Hipótese principal, não medida:\*\* o alerta se refere a operações `list`/);
  assert.match(flat, /Recomendações \(somente propostas; nada foi alterado\)/);
});

test("proposal is explicitly independent of GitHub schedule and not activated", () => {
  assert.match(doc, /Status: \*\*diagnóstico e proposta; nada ativado\*\*/);
  assert.match(doc, /cron já existente do Worker da\s+Cloudflare/);
  assert.match(doc, /sem `force: true`/);
  assert.match(doc, /Sol e o proprietário/);
  assert.match(doc, /não muda cron, workflow, chave, credencial, flag comercial ou\s+runtime/);
});
