import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";

const read = (path) => readTextNormalized(new URL(path, import.meta.url));
const doc = read("../docs/ops/p22-proof-renewal-investigation.md");
const workflow = read("../.github/workflows/order12a-financial-proof-renewal.yml");
const worker = read("../worker/cloudflare-worker.compat.mjs");
const recovered = read("../worker/cloudflare-worker.recovered.mjs");
const economy = read("../worker/db-economy.mjs");
const projection = read("../worker/commercial-metrics-projection.mjs");
const audit = read("../worker/internal-financial-audit.mjs");
const meter = read("../worker/kv-meter.mjs");
const snapshotScript = read("../scripts/audit/command-center-snapshot.mjs");
const collector = read("../scripts/b0/b0-lib.mjs");
const renewal = read("../scripts/financial_proof_renewal.py");
const flat = doc.replace(/\s+/g, " ");
const line = (text, n) => text.split("\n")[n - 1];

// Hourly branch of scheduled(): everything after the isolated "15,45" branch returns.
const hourly = worker.slice(worker.indexOf("let supportOverdue = false;"), worker.indexOf("wrapped.email ="));

// Age (minutes) of the proof when the next renewal happens, ticks every `cadence` minutes,
// renewal on the first tick whose age >= floor, `failed` consecutive renewal ticks failing (absent/late/503).
function renewalAge(cadence, floor, failed = 0) {
  let age = cadence;
  while (age < floor) age += cadence;
  return age + failed * cadence;
}

// Evidence: hourly heartbeat (serverCycle.at = finishedAt) with nurture "Too many subrequests", as published in
// the COMMAND_CENTER annotations of the command-center-snapshot runs (66 distinct beats, 24-27/10).
const TOO_MANY_BEATS = [
  ["2026-10-24T03:00:55.692Z", "40060163462"], ["2026-10-24T08:00:56.334Z", "40078330078"],
  ["2026-10-24T09:00:56.066Z", "40081999241"], ["2026-10-24T10:00:57.201Z", "40087751026"],
  ["2026-10-24T14:00:55.957Z", "40102746586"], ["2026-10-24T16:00:58.391Z", "40112097617"],
  ["2026-10-25T06:01:05.285Z", "40167806394"], ["2026-10-25T18:00:58.271Z", "40220263458"],
  ["2026-10-27T00:00:58.779Z", "40426930092"], ["2026-10-27T06:01:05.875Z", "40459578765"],
];
// Evidence: kvQuota daily peaks (writes = put + delete, reads) from the same annotations.
const KV_PEAKS = [["20/10", "594", "22.187"], ["21/10", "653", "22.845"], ["22/10", "568", "29.359"],
  ["23/10", "604", "29.614"], ["24/10", "694", "41.431"], ["25/10", "569", "35.503"], ["26/10", "571", "25.201"]];

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

test("hourly producer: 20 of 24 attempts, no gate, hourly DB and list, unverified writes", () => {
  // Proof born at :15 of 00/06/12/18; at :00 of hour h the hourly branch skips only if age < 50.
  let attempts = 0;
  for (let h = 0; h < 24; h++) {
    const born = [18 - 24, 0, 6, 12, 18].filter((r) => r * 60 + 15 <= h * 60).pop();
    if (h * 60 - (born * 60 + 15) >= 50) attempts++;
  }
  assert.equal(attempts, 20);
  assert.match(flat, /nas outras 20 horas do dia ela já venceu/);
  assert.match(flat, /em 20 das 24 horas o código manda tentar/);
  assert.ok(hourly.length > 0, "hourly branch located");
  assert.match(hourly, /recordLaunchEpoch\(normalized, salesSwitchState\)\s*\.then\(\(\) => refreshFinancialProofSnapshot\(normalized, \{ sqlFactory: whatsappProofDatabase \}\)\)/);
  assert.doesNotMatch(hourly, /dbEconomySkip/);
  assert.doesNotMatch(hourly, /force: true/);
  assert.match(hourly, /await runSalesPreflight\(normalized\)/);
  assert.match(recovered, /query\("select 1", \[\]\)/);
  assert.match(recovered, /kv\.list\(\{ prefix: PREFIX, limit: 100 \}\)/);
  assert.match(recovered, /kv\?\.put\?\.\("zpc-sales-preflight:v1"/);
  assert.match(projection, /if\(audited\?\.code===409\|\|!priorValid\)\{\s*await kv\.put\(COMMERCIAL_PROOF_KV_KEY/);
  assert.match(audit, /remaining:46/);
  assert.match(flat, /24 `select 1`, 24 `list` e 24 gravações por dia/);
  assert.match(flat, /até cerca de 20 gravações por dia/);
  assert.match(flat, /nunca produziu `PROVEN`/);
});

test("subrequest exhaustion is asserted against the heartbeat evidence, labels are honest", () => {
  // Evidence chain: nurture failure text goes into the hourly beat, putBeat stamps finishedAt,
  // the snapshot publishes serverCycle.at = finishedAt.
  assert.match(hourly, /mark\("nurture", false, error instanceof Error \? error\.message : error\)/);
  assert.match(hourly, /putBeat\(normalized\.ZEVANORY_PRIVATE_ARTIFACTS, "zpc:cron:v1:hourly", beat\)/);
  assert.match(meter, /finishedAt: new Date\(now\)\.toISOString\(\)/);
  assert.match(snapshotScript, /serverCycle: cronBeat \? \{ at: cronBeat\.finishedAt/);
  const rows = [...doc.matchAll(/^\| (2026-10-\d\dT[\d:.]+Z) \| (\d{11}) \|$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, TOO_MANY_BEATS);
  assert.match(flat, /em 10 dos 66 batimentos distintos/);
  assert.match(flat, /Too many subrequests by single Worker invocation/);
  assert.match(flat, /\*\*Inferência \(do código, não observada\):\*\* na janela das sondagens, o ramo horário teria tentado auditar em cerca de 16 horas/);
  assert.match(flat, /\*\*Hipótese \(não verificada;/);
  assert.match(flat, /em 2026-10-26, das 20h às 23h UTC, o `nurture` terminou `ok`/);
  assert.match(flat, /50 subrequisições externas \+ 1\.000 para serviços Cloudflare/);
  assert.match(flat, /essa classificação fica ambígua/);
  assert.match(flat, /limite de 6 conexões de saída simultâneas/);
  assert.match(flat, /O ponto exato da falha da prova \(etapa, exceção e contagens\) \*\*não está provado\*\*/);
});

test("hourly 409 risk and fail-closed semantics match the code", () => {
  assert.match(audit, /catch\{last=\{status:0,body:null\};\}/);
  assert.match(audit, /TRANSIENT_LOOKUP_REASONS=new Set\(\["production_provider_unavailable_or_unexpected_http"/);
  assert.match(flat, /um 409 causado por GETs sem orçamento \*\*invalidaria uma prova válida\*\*/);
  assert.match(flat, /503 transitório não apaga a prova válida, 409 a invalida, e nada sintetiza PASS/);
  assert.match(flat, /409 \(pagamento ambíguo, inclusive o `ambiguous_transient` de 429\/5xx do Mercado Pago\): a prova é \*\*apagada na hora\*\*, em qualquer cadência/);
});

test("pre-existing stale-overwrite defect is cited with exact file:line", () => {
  assert.match(line(projection, 85), /sqlFactory,now=Date\.now\(\),force=false/);
  assert.match(line(projection, 91), /prior=JSON\.parse\(String\(await kv\.get\(COMMERCIAL_PROOF_KV_KEY\)/);
  assert.match(line(projection, 99), /const audited=await audit\(env,\{sqlFactory\}\)/);
  assert.match(line(projection, 111), /await kv\.put\(COMMERCIAL_PROOF_KV_KEY/);
  assert.match(line(projection, 117), /await kv\.put\(COMMERCIAL_PROOF_KV_KEY/);
  assert.match(line(projection, 168), /persistClassificationSnapshot\(env,classified,\{now=Date\.now\(\)/);
  assert.match(line(projection, 173), /await kv\.put\(COMMERCIAL_PROOF_KV_KEY/);
  assert.match(line(worker, 168), /persistClassificationSnapshot\(normalized, \{ code: 200, result: body \}, \{ sqlFactory: whatsappProofDatabase \}\)/);
  // No re-read of the stored measured_at between the audit and the write.
  const refresh = projection.slice(projection.indexOf("const audited=await audit"), projection.indexOf("export function projectProductionOnlyStatus"));
  assert.doesNotMatch(refresh, /kv\.get\(/);
  const persist = projection.slice(projection.indexOf("export async function persistClassificationSnapshot"), projection.indexOf("export async function describeFinancialProofSnapshot"));
  assert.doesNotMatch(persist, /kv\.get\(|measured_at/);
  assert.match(doc, /## Defeito pré-existente: resultado antigo sobrescreve um novo/);
  assert.match(flat, /\*\*Confirmado pelo código; não observado em produção\.\*\*/);
  for (const ref of ["commercial-metrics-projection.mjs:85", "commercial-metrics-projection.mjs:91", "commercial-metrics-projection.mjs:111", "commercial-metrics-projection.mjs:168", "commercial-metrics-projection.mjs:173", "cloudflare-worker.compat.mjs:168"])
    assert.ok(doc.includes(ref), ref);
  assert.match(flat, /3\. A termina depois e grava `PROVEN` por cima de B/);
});

test("proposal: monotonic guard, residual risk and DB authority option", () => {
  assert.match(flat, /\*\*o caminho do GitHub carimba no início da leitura\*\*, não ao persistir/);
  assert.match(flat, /só grava se o seu `measured_at` for \*\*estritamente mais novo\*\*\. Em empate, 409 vence/);
  assert.match(flat, /todo 409 grava também um marcador de invalidação com o `measured_at`/);
  assert.match(flat, /leitores só aceitam um snapshot verificado se ele tiver 65 minutos ou menos \*\*e\*\* for mais novo que o último marcador/);
  assert.match(flat, /O KV não oferece compare-and-set/);
  assert.match(flat, /por até cerca de 60 segundos/);
  assert.match(flat, /Desenho sem nenhum FRESH falso/);
  assert.match(flat, /`update … where measured_at < \$novo` \(atômico e monotônico\)/);
  assert.match(flat, /por exemplo `17,47`, a 7 ou 8 minutos/);
});

test("C3 acceptance criteria cover every required scenario", () => {
  assert.match(flat, /\*\*nenhum FRESH falso, vencimento reconhecido em até 65 minutos e recuperação correta\*\*/);
  for (const scenario of ["Um tique ausente", "Dois tiques consecutivos ausentes", "Execução atrasada",
    "Dois produtores simultâneos", "Resultado antigo depois de um novo", "Erro de banco seguido de recuperação"])
    assert.match(doc, new RegExp(`^\\| ${scenario} \\|`, "m"), scenario);
  assert.match(flat, /GitHub `11,41` e Worker `10,25,40,55` com vendas abertas/);
  assert.match(flat, /503 do banco com prova válida armazenada/);
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

test("margin table is computed, failure types distinguished, finishedAt not start", () => {
  const ages = (c, f) => [0, 1, 2].map((k) => renewalAge(c, f, k));
  const perDay = (c, f) => 1440 / renewalAge(c, f);
  const cell = (a) => (a > 65 ? `${a}: vence` : null);
  assert.deepEqual(ages(30, 50), [60, 90, 120]);
  assert.deepEqual(ages(30, 25), [30, 60, 90]);
  assert.deepEqual(ages(15, 40), [45, 60, 75]);
  assert.deepEqual(ages(15, 25), [30, 45, 60]);
  assert.deepEqual([perDay(30, 50), perDay(30, 25), perDay(15, 40), perDay(15, 25)], [24, 48, 32, 48]);
  assert.equal(cell(90), "90: vence");
  assert.match(flat, /\| Revisão 1: tiques de 30 min \(`15,45`\), piso 50 \| 60 \(margem 5\) \| 90: vence \| vence \| 24 \| apaga na hora \|/);
  assert.match(flat, /\| Tiques de 30 min \(`15,45`\), piso 25 \(renova em todo tique\) \| 30 \(margem 35\) \| 60 \(margem 5, menos atrasos\) \| 90: vence \| 48 \| apaga na hora \|/);
  assert.match(flat, /\| Tiques de 15 min, piso 40 \| 45 \(margem 20\) \| 60 \(margem 5, menos atrasos\) \| 75: vence \| 32 \| apaga na hora \|/);
  assert.match(flat, /\| \*\*Tiques de 15 min, piso 25 \(recomendado\)\*\* \| \*\*30 \(margem 35\)\*\* \| \*\*45 \(margem 20\)\*\* \| 60 \(margem 5, menos atrasos\) \| 48 \| apaga na hora \|/);
  assert.match(flat, /com idade \*\*60\*\*: a margem nominal é de cerca de \*\*5 minutos\*\*/);
  assert.doesNotMatch(flat, /margem nominal de 15 minutos/);
  assert.match(flat, /o batimento isolado registra `finishedAt`, não o início/);
  assert.doesNotMatch(flat, /registra início entre/);
  assert.match(flat, /até 60 segundos/);
});

test("proposal: 15-min cadence, floor dedup, no KV reservation, hourly proof removed", () => {
  assert.match(flat, /`10,25,40,55 \* \* \* \*`/);
  assert.match(flat, /Continua sendo um único Cron Trigger, então o limite de 5 Cron Triggers por conta/);
  assert.match(flat, /Piso de 25 minutos, sem `force: true`/);
  assert.match(flat, /\*\*Sem reserva no KV:\*\* o KV não tem compare-and-set/);
  assert.doesNotMatch(flat, /reserva idempotente/);
  assert.match(flat, /Tirar a prova do ramo horário/);
  assert.match(worker, /put\?\.\("zpc:financial-proof:last-isolated-run:v1"/);
  assert.match(flat, /`zpc:financial-proof:last-isolated-run:v1` só depois de uma auditoria real/);
  assert.match(flat, /limitado a no máximo um por hora/);
});

test("cost table: ranges, preflight writes, attempted vs effective, sales-open concurrency", () => {
  assert.match(meter, /SHED_AT_PCT = 70;/);
  assert.match(meter, /"zpc:cron:v1"/);
  const shed = 0.70 * 1000;
  assert.equal(shed, 700);
  assert.match(flat, new RegExp(`\`SHED_AT_PCT=70\` \\(${shed}\\)`));
  // Writes: current 36 + 0..20 unverified + 24 preflight; proposed 48 + 48 + 24 + 24 (or 48 + 2 + 24 + 24).
  const cur = [28 + 4 + 4 + 0 + 24, 28 + 4 + 4 + 20 + 24], prop = 48 + 48 + 24 + 24, opt = 48 + 2 + 24 + 24;
  assert.deepEqual(cur, [60, 80]);
  assert.equal(prop, 144);
  assert.equal(opt, 98);
  assert.match(flat, /\| Gravações tentadas no KV \| 60 a 80 \(batimento 28, prova 4, `last-isolated-run` 4, não verificadas 0 a 20, preflight 24\) \| 144 .*; 98 com o item 6 opcional \| \+64 a \+84 \(ou \+18 a \+38\) \| 1\.000\/dia/);
  const worst = 694;
  assert.match(flat, new RegExp(`\\*\\*${worst + prop - cur[1]} a ${worst + prop - cur[0]}\\*\\*`));
  assert.match(flat, new RegExp(`\\(${worst + opt - cur[1]} a ${worst + opt - cur[0]} no pior dia\\)`));
  assert.match(flat, /\| Instruções SQL no Neon \(prova\) \| 8 a 48 \(8 \+ 0 a 40\) \| 96 \| \+48 a \+88 \|/);
  assert.match(flat, /\| Invocações de cron do Worker central \| 120 \(24 \+ 48 \+ 48\) \| 168 \(24 \+ 96 \+ 48\) \| \+48 \|/);
  assert.match(flat, /\| Auditorias concluídas \| 4 \| 48 \|/);
  assert.match(flat, /\| Auditorias tentadas e falhas \(ramo horário\) \| 0 a 20 \| 0 \|/);
  assert.match(flat, /\| Retentativas MP \| até 6 por auditoria/);
  assert.match(flat, /\| Gravações efetivas no KV \|/);
  assert.match(flat, /\| Leituras no KV \| cerca de 148 .*\| cerca de 240 .*\| \+92 \| 100\.000\/dia/);
  assert.match(flat, /\| `list` no KV \| 0 da prova/);
  assert.match(flat, /\| `delete` no KV \| 0 \| 0 \| 0 \| 1\.000\/dia \|/);
  assert.match(flat, /\| Instruções SQL \| 3 × \(48 \+ 5 a 48\) = 159 a 288 \| igual \|/);
  assert.equal(3 * (48 + 5), 159);
  assert.equal(3 * (48 + 48), 288);
  assert.match(flat, /\| Distância entre produtores \| 4 min \(`11,41` × `15,45`\) \| 7 a 8 min/);
  assert.match(flat, /100\.000 leituras, 1\.000 gravações, 1\.000 exclusões e 1\.000 `list` por dia/);
  assert.match(flat, /6 conexões de saída simultâneas e 5 Cron Triggers por conta/);
  assert.match(flat, /developers\.cloudflare\.com\/kv\/platform\/limits\//);
});

test("KV daily-limit alert section: measured data, list hypothesis, proposals only", () => {
  assert.match(doc, /## Alerta de limite diário do KV/);
  for (const [day, writes, reads] of KV_PEAKS)
    assert.match(flat, new RegExp(`\\| ${day} \\| ${writes} \\| ${reads.replace(".", "\\.")} \\|`), day);
  assert.equal(Math.max(...KV_PEAKS.map(([, w]) => Number(w))), 694);
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
