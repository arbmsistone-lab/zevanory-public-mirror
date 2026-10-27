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
  assert.match(line(worker, 169), /persistClassificationSnapshot\(normalized, \{ code: 200, result: body \}, \{ sqlFactory: whatsappProofDatabase \}\)/);
  // No re-read of the stored measured_at between the audit and the write.
  const refresh = projection.slice(projection.indexOf("const audited=await audit"), projection.indexOf("export function projectProductionOnlyStatus"));
  assert.doesNotMatch(refresh, /kv\.get\(/);
  const persist = projection.slice(projection.indexOf("export async function persistClassificationSnapshot"), projection.indexOf("export async function describeFinancialProofSnapshot"));
  assert.doesNotMatch(persist, /kv\.get\(|measured_at/);
  assert.match(doc, /## Defeito pré-existente: resultado antigo sobrescreve um novo/);
  assert.match(flat, /\*\*Confirmado pelo código; não observado em produção\.\*\*/);
  for (const ref of ["commercial-metrics-projection.mjs:85", "commercial-metrics-projection.mjs:91", "commercial-metrics-projection.mjs:111", "commercial-metrics-projection.mjs:168", "commercial-metrics-projection.mjs:173", "cloudflare-worker.compat.mjs:169"])
    assert.ok(doc.includes(ref), ref);
  assert.match(flat, /3\. A termina depois e grava `PROVEN` por cima de B/);
});

test("C3 acceptance criteria fix every scenario and its required outcome", () => {
  assert.match(flat, /\*\*nenhum FRESH falso, vencimento reconhecido em até 65 minutos e recuperação correta\*\*/);
  const rows = [
    ["Um tique ausente", "prova continua `PROVEN` (idade 45 no tique seguinte) e é renovada"],
    ["Dois tiques consecutivos ausentes", "prova ainda válida no tique seguinte aos dois falhos (idade 60, margem nominal 5) ou vencida e reconhecida como `UNVERIFIED_FAIL_CLOSED` se os atrasos passarem de 5 min; renovação no tique seguinte"],
    ["Execução atrasada", "`measured_at` continua marcando o início; nenhum snapshot com idade acima de 65 aceito"],
    ["Dois produtores simultâneos", "a linha do banco só avança; nenhum resultado mais antigo substitui um mais novo; nenhum FRESH falso"],
    ["Resultado antigo depois de um novo", "o `update` do resultado antigo afeta zero linhas; estado `UNVERIFIED_FAIL_CLOSED` até auditoria verificada mais nova"],
    ["Erro de banco seguido de recuperação", "liberação: `UNVERIFIED_FAIL_CLOSED` enquanto o banco estiver fora; exibição: prova válida preservada enquanto tiver até 65 min, sem autorizar venda; auditoria com 503 não altera a linha; renovação no primeiro tique com banco de volta"],
    ["Falha de gravação no KV", "a decisão de liberação não muda, porque lê o banco; cache defasado nunca libera venda; na variante só KV o cenário reprova por desenho (resíduo de até 65 min declarado)"],
    ["Commit do 409 falha no banco", "pendência aberta; liberação suspensa quando completa G (6 min); `UNVERIFIED_FAIL_CLOSED` até desfecho commitado mais novo"],
    ["Pendência seguida de novas tentativas (A/B/C)", "`unresolved_since` fica em T+30; liberação suspensa a partir de T+36; B e C não reabrem a janela; volta só com desfecho commitado"],
    ["Tentativas concorrentes com espera de lock (X e Y)", "`attempt_at` só avança (X grava instante posterior ao de Y e só então lê os provedores); só um desfecho com leitura posterior à última tentativa limpa a pendência; nenhum desfecho mais velho reabre a liberação; zero linhas com a linha presente não dispara `seed_missing`"],
    ["Três tentativas sobrepostas", "pendência continua em tA; o desfecho de A não a move nem a limpa; liberação suspensa a partir de tA + 6 min até desfecho commitado de C"],
    ["Linha semente ausente", "`update` da tentativa afeta zero linhas; auditoria não começa; batimento `seed_missing` e alerta; liberação `UNVERIFIED_FAIL_CLOSED`"],
    ["Orçamento de subrequisições no commit do desfecho", "pico medido de no máximo 47 subrequisições externas (46 sem vendas abertas); o commit do desfecho nunca é cortado"],
  ];
  const table = [...doc.matchAll(/^\| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)].map((m) => m.slice(1).map((c) => c.trim()));
  const at = table.findIndex((r) => r[0] === "Cenário (C3)");
  assert.ok(at >= 0, "C3 table located");
  assert.deepEqual(table.slice(at + 1, at + 1 + rows.length).map((r) => [r[0], r[2]]), rows);
  assert.equal(rows.length, 13);
  // A/B/C: pending opened at T+30 by A; release stops at T+30+G regardless of B (T+45) and C (T+60).
  const T = 0, G = 6, pendingSince = T + 30;
  for (const attempt of [T + 45, T + 60]) assert.equal(Math.min(pendingSince, attempt), pendingSince);
  assert.equal(pendingSince + G, T + 36);
  assert.match(flat, /dispatch cronometrado do workflow do GitHub a menos de 60 s de um tique do Worker `10,25,40,55`, com vendas abertas/);
  assert.match(flat, /cota diária de gravações esgotada, 429 na mesma chave ou erro transitório no cache/);
  assert.match(flat, /derrubar a conexão entre a leitura dos provedores e o commit do 409/);
});

test("recommended design: Postgres authority, DB clock, per-pending G, seed-row failure", () => {
  assert.match(flat, /3\. \*\*Autoridade da prova no Postgres \(desenho recomendado\)\.\*\* Segue a Sol ORDEM 294/);
  assert.match(flat, /values \(1, '-infinity', '-infinity', null, 'unverified'\) on conflict \(id\) do nothing/);
  assert.match(flat, /todos os carimbos vêm do `now\(\)` do Postgres, nunca do Worker nem do runner do GitHub\. A idade e o G são calculados em SQL/);
  assert.match(flat, /\*\*o caminho do GitHub carimba no início da leitura\*\*, não ao persistir/);
  assert.match(flat, /o script do runner nunca envia carimbo/);
  assert.match(flat, /`update financial_proof_state set attempt_at = clock_timestamp\(\), unresolved_since = coalesce\(unresolved_since, clock_timestamp\(\)\) where id = 1 and attempt_at < clock_timestamp\(\) returning attempt_at`/);
  assert.match(flat, /o `attempt_at` \*\*só avança\*\*: uma tentativa que espera o lock de outra grava um instante posterior ao dela/);
  assert.match(flat, /`select exists \(select 1 from financial_proof_state where id = 1\)`/);
  assert.match(flat, /linha presente \(concorrência ou relógio\) significa pular esta tentativa sem alerta/);
  assert.match(flat, /\*\*idêntico\*\* \(`\$novo = \$inicio`\)\. Se esse commit falhar, a auditoria não começa/);
  assert.match(flat, /\*\*linha semente ausente\*\* é erro: a auditoria não começa, o batimento registra `seed_missing` e sai um alerta/);
  assert.match(flat, /unresolved_since = case when \$novo >= attempt_at then null else unresolved_since end where id = 1 and \(measured_at < \$novo or \(measured_at = \$novo and \$desfecho = 'ambiguous'\)\)`/);
  assert.match(doc, /Só grava o que for \*\*estritamente mais novo\*\*\. Em empate, 409 vence\./);
  assert.match(flat, /Zero linhas afetadas significa resultado antigo, que é descartado e não vai ao cache/);
  assert.match(flat, /A pendência \(`unresolved_since`\) só é limpa por um desfecho commitado da tentativa mais recente; o desfecho de uma tentativa mais velha \*\*nunca move nem limpa\*\* a pendência \(`else unresolved_since`\)/);
  assert.match(flat, /now\(\) - measured_at <= interval '65 minutes' and \(unresolved_since is null or now\(\) - unresolved_since < interval '6 minutes'\) from financial_proof_state where id = 1`/);
  // G pinned and justified against the reduced MP budget (42 GETs x 7 s timeout + retry pauses).
  assert.match(flat, /\*\*G = 6 minutos\*\*, acima do pior caso da auditoria com o orçamento do item 10/);
  assert.equal(42 * 7 + 9 + 4 * 5, 323);
  assert.ok(323 < 6 * 60, "worst-case audit with 5 s SQL timeouts fits in G");
  assert.match(flat, /\*\*toda consulta ao Neon exige timeout de no máximo 5 s\*\* \(`AbortSignal\.timeout` no fetch do driver HTTP e `statement_timeout` no banco\)/);
  assert.match(flat, /42 GETs de 7 s \(294 s\), mais as pausas de retentativa \(cerca de 9 s\), mais 4 SQL de 5 s \(20 s\) = 323 s, cerca de 5,4 min/);
  assert.equal((323 / 60).toFixed(1), "5.4");
  assert.match(flat, /Banco indisponível significa `UNVERIFIED_FAIL_CLOSED`/);
  assert.match(flat, /Ele alimenta a exibição \(`\/api\/status`, `\/api\/sales\/status`\) e o pulo por piso, nunca a liberação/);
  assert.match(flat, /Novas tentativas \*\*não\*\* reabrem a janela, porque `coalesce` preserva o início da primeira pendência\. O FRESH falso residual é de até G, uma vez por pendência, e não recorrente/);
  assert.match(flat, /uma gravação ausente ou falha significa UNVERIFIED, nunca FRESH/);
  assert.match(flat, /alternativa para o proprietário: G = 0 \(nenhuma janela\)/);
  assert.match(flat, /\| Autoridade no Postgres \(recomendado\) \| `update` monotônico afeta zero linhas; descartado \| pendência preservada por `coalesce`: para de liberar quando completa G \(6 min\); novas tentativas não reabrem a janela \| até 6 min, uma vez por pendência \(0 com G = 0\) \|/);
});

test("checkout gate is new: today the guard does not read the proof; owner and Sol decide", () => {
  const guard = read("../worker/commercial-checkout-guard.mjs");
  const sales = read("../worker/sales-control.mjs");
  assert.equal(line(guard, 5), 'export const REQUIRED = Object.freeze(["global","pre_sale","absolute","checkout","financial","kv","preflight","environment","fiscal","token"]);');
  assert.doesNotMatch(guard, /FinancialProof|financial-proof|commercial-metrics-projection/);
  assert.match(line(worker, 598), /const snapshot = await readFinancialProofSnapshot\(normalized\);/);
  assert.match(line(sales, 145), /const proof = await readFinancialProofSnapshot\(env\);/);
  assert.match(doc, /## Gate de checkout: decisão do proprietário e da Sol/);
  assert.match(flat, /\*\*Fato:\*\* hoje a criação de checkout \*\*não lê a prova\*\*\. `worker\/commercial-checkout-guard\.mjs:5` define/);
  assert.match(flat, /é, portanto, um \*\*gate novo\*\*, a ser implementado depois num PR próprio e autorizado/);
  for (const ev of ["um 409 transitório do Mercado Pago (429/5xx, `ambiguous_transient`)", "uma tentativa sem resolução, depois de G (6 min)", "indisponibilidade do banco", "esgotamento dos 100 CU-h do Neon Free"])
    assert.ok(flat.includes(ev), ev);
  assert.match(flat, /até a próxima auditoria verificada \(15 a 30 min\)/);
  assert.match(flat, /\| \*\*Bloquear \(fail-closed; padrão recomendado, coerente com P22 e a ORDEM 294\)\*\* \| checkout só com a prova do banco válida \|/);
  assert.match(flat, /\| Degradar \| checkout continua como hoje \(sem exigir a prova\); a prova só governa a exibição \|/);
  assert.match(flat, /\| Degradar só no transitório \|/);
  assert.match(flat, /\*\*Esta decisão é do proprietário e da Sol\*\* e não é tomada por este documento/);
});

test("subrequest budget under the proposal stays below 50 with margin", () => {
  assert.match(audit, /remaining:46/);
  assert.match(recovered, /No database connection string was provided to `neon\(\)`/);
  const today = 2 + 46, unchanged = 1 + 2 + 1 + 46, reduced = 1 + 2 + 1 + 42;
  assert.deepEqual([today, today + 1, unchanged, unchanged + 1, reduced, reduced + 1], [48, 49, 50, 51, 46, 47]);
  assert.ok(reduced + 1 <= 50 - 3, "margin of at least 3 with sales open");
  assert.match(flat, /chegaria a 1 \(tentativa\) \+ 2 SQL de leitura \+ 1 desfecho \+ até 46 GETs MP = \*\*até 50\*\*, e \*\*51\*\* com vendas abertas/);
  assert.match(flat, /reduzir o orçamento de GETs MP da auditoria de 46 para \*\*42\*\*, o que dá \*\*até 46\*\* por invocação \(47 com vendas abertas\), com margem de pelo menos 3/);
  assert.match(flat, /reprova se passar de 46 \(47 com vendas abertas\)/);
  assert.match(flat, /\| Subrequisições externas por invocação da prova \| até 48 \(2 SQL \+ até 46 GETs MP, `\/users\/me` e retentativas incluídos\); 49 com vendas abertas \| até 46 \(tentativa \+ 2 SQL \+ desfecho \+ até 42 GETs MP\); 47 com vendas abertas\. Sem reduzir o orçamento MP: até 50, ou 51 com vendas abertas \|/);
});

test("KV-only variant is a fallback with the corrected guard and an honest 65-minute residual", () => {
  assert.match(flat, /3a\. \*\*Variante só com KV \(cache\/fallback, não recomendada\)\.\*\*/);
  assert.match(flat, /\*\*marcador antes do snapshot:\*\* todo 409 grava primeiro o marcador de invalidação/);
  assert.match(flat, /\*\*marcador monotônico:\*\* o marcador só é gravado se for mais novo que o atual/);
  assert.match(flat, /\*\*sem marcador, sem liberação:\*\* se a gravação do marcador falhar, o produtor não grava snapshot verificado/);
  assert.match(doc, /\*\*e\*\* for mais novo que o último marcador de invalidação;/);
  assert.match(flat, /\*\*pulo por piso com marcador:\*\* a checagem de pulo do produtor também respeita o marcador/);
  assert.match(flat, /\*\*marcador só com 409:\*\* na variante KV, o marcador só é gravado quando há 409/);
  assert.match(flat, /na variante só KV, o marcador só é gravado quando há 409/);
  assert.match(flat, /\*\*Resíduo honesto da variante:\*\* até \*\*65 minutos de FRESH falso\*\*/);
  assert.match(flat, /cota diária de gravações esgotada, como em 12\/10; 429 por mais de 1 gravação\/s na mesma chave; erro transitório/);
  assert.match(flat, /Só a autoridade no banco fecha esse resíduo/);
  assert.match(flat, /\| Só KV, com a guarda corrigida \(fallback\) \| .* \| até 65 minutos \|/);
  assert.doesNotMatch(flat, /cerca de 60 segundos/);
  assert.doesNotMatch(flat, /Desenho sem nenhum FRESH falso/);
});

test("GitHub minute offsets are not claimed to separate producers; timed dispatch is required", () => {
  assert.doesNotMatch(flat, /por exemplo `17,47`/);
  assert.doesNotMatch(flat, /\(`17,47` ×/);
  assert.match(flat, /começaram nos minutos :30, :24, :32, :50, :04, :41, :07, :03, :59, :15, :02, :21, :11, :30, :37, :54, :08, :53, :47, :53 e :26/);
  assert.match(flat, /o cenário de concorrência é provocado por \*\*dispatch cronometrado\*\* no ensaio/);
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
  assert.match(flat, new RegExp(`dá \\*\\*758 a 778\\*\\*, abaixo de 1\\.000, mas acima do \`SHED_AT_PCT=70\` \\(${shed}\\), a partir do qual`));
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
  assert.match(flat, /\| Retentativas MP \| até 6 por auditoria, dentro do orçamento de 46 \| até 6 por auditoria, dentro do orçamento de 42 \|/);
  assert.match(flat, /\| Gravações efetivas no KV \|/);
  assert.match(flat, /\| Leituras no KV \| cerca de 148 .*\| cerca de 240 .*\| \+92 \| 100\.000\/dia/);
  assert.match(flat, /\| `list` no KV \| 0 da prova/);
  assert.match(flat, /\| `delete` no KV \| 0 \| 0 \| 0 \| 1\.000\/dia \|/);
  assert.match(flat, /\| Instruções SQL \| 3 × \(48 \+ 5 a 48\) = 159 a 288 \| igual \|/);
  assert.equal(3 * (48 + 5), 159);
  assert.equal(3 * (48 + 48), 288);
  assert.match(flat, /\| Distância entre produtores \| 4 min \(`11,41` × `15,45`\) nominais, aleatória na prática \| aleatória/);
  assert.match(flat, /\| SQL da autoridade no Postgres \(recomendado\) \| 0 \| 96 \(tentativa \+ desfecho em cada uma das 48 auditorias\), mais 1 por criação de checkout com vendas abertas \| \+96 \|/);
  assert.equal(48 * 2, 96);
  assert.match(flat, /\| Leituras extras da variante só KV \| 0 \| 96 \(releitura do snapshot e do marcador antes de cada uma das 48 gravações\) mais 1 leitura do marcador por chamada a `readFinancialProofSnapshot`, proporcional ao tráfego \(só as sondagens P18 em `\/api\/status` são 288\/dia\) \| \+96 mais o tráfego \|/);
  assert.equal((24 * 60) / 5, 288);
  for (const call of ["const snapshot = await readFinancialProofSnapshot(normalized);", "if (salesOpen && !(await readFinancialProofSnapshot(normalized)))"]) assert.ok(worker.includes(call), call);
  assert.match(flat, /\| Tempo ativo do compute Neon \(estimativa, as duas variantes\) \| .* \| \+10 min\/h, cerca de \+120 h\/mês, cerca de \+30 CU-h\/mês a 0,25 CU \| 100 CU-h\/mês por projeto/);
  assert.equal(Math.round((10 / 60) * 24 * 30), 120);
  assert.equal(120 * 0.25, 30);
  assert.match(flat, /o Free dá 100 CU-hours por projeto por mês e 5 GB de transferência; o compute é suspenso após 5 minutos de inatividade/);
  assert.match(flat, /\| SQL da autoridade \| 0 \| 2 por auditoria: 106 a 192 \(53 a 96 auditorias\)/);
  assert.equal(2 * (48 + 5), 106);
  assert.equal(2 * (48 + 48), 192);
  assert.match(flat, /100\.000 leituras, 1\.000 gravações, 1\.000 exclusões e 1\.000 `list` por dia/);
  assert.match(flat, /6 conexões de saída simultâneas e 5 Cron Triggers por conta/);
  assert.match(flat, /developers\.cloudflare\.com\/kv\/platform\/limits\//);
});

test("KV alert section: 50% threshold warnings explained by writes; P22 write budget", () => {
  assert.match(doc, /## Alerta de limite diário do KV/);
  assert.match(flat, /"\[Alerta\] Limite diário de operações do KV atingido em 50% para a conta …"/);
  assert.match(flat, /São \*\*avisos de limiar de 50%\*\*, não de limite atingido/);
  for (const [day, writes, reads] of KV_PEAKS)
    assert.match(flat, new RegExp(`\\| ${day} \\| ${writes} \\| ${Math.round(Number(writes) / 10)}% \\| ${reads.replace(".", "\\.")} \\|`), day);
  const w = KV_PEAKS.map(([, x]) => Number(x));
  assert.deepEqual([Math.min(...w), Math.max(...w)], [568, 694]);
  assert.ok(w.every((x) => x > 500 && x < 1000), "every day above the 50% warning, none at the limit");
  assert.match(flat, /explicados pelas \*\*gravações diárias de 568 a 694 \(57% a 69% de 1\.000\)\*\*/);
  assert.match(flat, /\*\*Nenhum limite foi atingido\*\* entre 20 e 27\/10/);
  assert.match(flat, /operações `list` não são medidas pelo snapshot, mas não são necessárias para explicar os avisos/);
  assert.doesNotMatch(flat, /Hipótese principal, não medida/);
  // Worst day + proposal deltas, against SHED_AT_PCT (70% of 1,000).
  const worst = 694, pct = (x) => Math.round(x / 10);
  assert.deepEqual([worst + 64, worst + 84, pct(worst + 64), pct(worst + 84)], [758, 778, 76, 78]);
  assert.match(flat, /isso dá \*\*758 a 778 \(76% a 78%\)\*\*, acima do `SHED_AT_PCT=70` \(700\)/);
  assert.match(flat, /\| Proposta padrão \| \+64 a \+84 \| 758 a 778 \(76% a 78%\) \|/);
  assert.match(flat, /\| Variante econômica \(item 6: `last-isolated-run` só em falha ou mudança\) \| \+18 a \+38 \| 712 a 732 \(71% a 73%\) \|/);
  assert.match(flat, /\| \+6 a \+26 \| 700 a 720 \(70% a 72%\) \|/);
  assert.match(flat, /\| −4 a \+16 \| 690 a 710 \(69% a 71%\) \|/);
  assert.deepEqual([18 - 12, 38 - 12, 18 - 12 - 10, 38 - 12 - 10], [6, 26, -4, 16]);
  assert.match(flat, /1\. \*\*Adotar a variante econômica\*\* e as reduções de gravação acima/);
  assert.match(flat, /Recomendações \(somente propostas; nada foi alterado\)/);
});

test("proposal is explicitly independent of GitHub schedule and not activated", () => {
  assert.match(doc, /Status: \*\*diagnóstico e proposta; nada ativado\*\*/);
  assert.match(doc, /cron já existente do Worker da\s+Cloudflare/);
  assert.match(doc, /sem `force: true`/);
  assert.match(doc, /Sol e o proprietário/);
  assert.match(doc, /não muda cron, workflow, chave, credencial, flag comercial ou\s+runtime/);
});
