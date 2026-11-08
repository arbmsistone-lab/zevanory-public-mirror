// ZEVANORY | P20 diário D1: o ensaio mensal lê o diário (scripts/p20/diario-d1-read.mjs) e reconstrói os eventos
// posteriores à cópia restaurada (scripts/p20/restore-drill-diario.mjs), com a prova no registro (restore-drill-lib.mjs).
// Rede falsa (nenhuma requisição real), D1 falso com SQL de verdade (node:sqlite, migrações reais) só para gerar a cadeia,
// "banco restaurado" falso que responde às consultas da reconciliação pela forma. A reaplicação real num PostgreSQL e o
// caminho completo com o código real do Worker estão em tests/test_p20_restore_drill.py (testes 8 a 10).
// Marcadores [DEn.k] usados pelos mutantes (scripts/ci/mutants_p20_restore_drill.py).
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { createD1 } from "./helpers/d1-sqlite.mjs";
import { makeBackup } from "./helpers/p20-backup-fixture.mjs";
import { appendEvent } from "../worker/diario-p20.mjs";
import { eventoPedidoCriado, eventoPagamento } from "../worker/diario-sombra.mjs";
import { lerDiario, d1Query, D1_QUERY_URL, SQL_HEAD, SQL_PAGINA, SCHEMA_LEITURA } from "../scripts/p20/diario-d1-read.mjs";
import { provarDiario, TABELA_RECONSTRUCAO } from "../scripts/p20/restore-drill-diario.mjs";
import { validateRecord, NOT_COVERED, notCoveredFor } from "../scripts/p20/restore-drill-lib.mjs";
import { runDrill, DIARIO_FASE_ENSAIO } from "../scripts/p20/restore-drill.mjs";
import { DIARIO_FASE } from "../worker/diario-reconcilia.mjs";

const MIGRATION = readTextNormalized(new URL("../migrations/d1/0001_diario_v1.sql", import.meta.url)) + "\n" + readTextNormalized(new URL("../migrations/d1/0002_diario_v1_ts.sql", import.meta.url));
const INVENTORY = JSON.parse(readTextNormalized(new URL("../docs/p20/inventario-estado-critico.json", import.meta.url)));
const TOKEN = "sintetico".repeat(5); // valor de teste, sem formato de chave
const H = 3600 * 1000;
const FALHA = "2026-11-02T07:23:00.000Z";
const LIDO = "2026-11-02T07:22:30.000Z";
const CORTE = Date.parse("2026-11-02T05:10:00.000Z"); // início mais antigo das partes (makeBackup)
const OA = "3f2a9c1e-7b4d-4abc-9def-0123456789ab", OB = "9b1c0d2e-3f4a-4b5c-8d6e-7f8091a2b3c4", OC = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

// Diário real (cadeia de verdade): OA antes do corte (está na cópia), OB e o pagamento de OB depois (só no diário).
async function diario({ extra = [] } = {}) {
  const db = createD1(MIGRATION);
  const evs = [
    eventoPedidoCriado({ orderId: OA, provider: "mercadopago", offerId: "ia", amount: 97, ts: CORTE - 3 * H }),
    eventoPedidoCriado({ orderId: OB, provider: "mercadopago", offerId: "ia", amount: 97, ts: CORTE + 1 * H }),
    eventoPagamento({ orderId: OB, provider: "mercadopago", paymentId: "1234567890", status: "approved", normalized: "payment_confirmed", amount: 97, ts: CORTE + 1.5 * H }),
    ...extra,
  ].sort((a, b) => a.ts_ms - b.ts_ms);
  for (const e of evs) assert.equal((await appendEvent(db, e)).ok, true);
  return { schema: SCHEMA_LEITURA, estado: "lido", lido_em: LIDO, head: db.head(), rows: db.rows(), consultas: 2 };
}
// Banco restaurado falso: só a linha de OA (a cópia é anterior a OB). Responde pela forma da consulta, na janela pedida.
function restaurado(orders = [{ order_id: OA, provider: "mercadopago", ts_ms: CORTE - 3 * H + 400 }]) {
  const calls = [];
  return { calls, query: async (text, params) => {
    calls.push(text);
    if (/from orders where/.test(text)) return orders.filter((r) => r.ts_ms >= params[0] && r.ts_ms <= params[1]);
    return [];
  } };
}
const eco = (log = []) => async (rows) => { log.push(rows.length); return structuredClone(rows); };
const prova = (leitura, extra = {}) => provarDiario({ leitura, corteIso: new Date(CORTE).toISOString(), falhaIso: FALHA, restoreOk: true, restauradoSql: restaurado(), reconstruir: eco(), ...extra });

function fakeFetch(head, rows, log = []) {
  return async (url, init) => {
    log.push({ url, method: init.method, auth: init.headers.authorization, body: JSON.parse(init.body) });
    const { sql, params } = JSON.parse(init.body);
    let results;
    if (sql === SQL_HEAD) results = [head];
    else if (sql === SQL_PAGINA) results = rows.filter((r) => r.seq > params[0] && r.seq <= params[1]).slice(0, params[2]);
    else return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ success: true, result: [{ success: true, results, meta: {} }] }), { status: 200 });
  };
}

test("DE1 leitor do D1: só POST na URL do banco do diário, token de leitura dedicado, só as duas SELECT fixas, cabeça antes das linhas", async () => {
  const d = await diario();
  const log = [];
  const r = await lerDiario({ token: TOKEN, fetchImpl: fakeFetch(d.head, d.rows, log), now: () => new Date(LIDO), pagina: 2 });
  assert.equal(r.estado, "lido", "[DE1.1] lido");
  assert.equal(r.rows.length, 3, "[DE1.2] todas as linhas até a cabeça, por páginas");
  assert.ok(log.every((c) => c.url === D1_QUERY_URL && c.method === "POST" && c.auth === "Bearer " + TOKEN), "[DE1.3] só a URL do banco, POST, token dedicado");
  assert.match(D1_QUERY_URL, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/1b26415802588185a86c1d4d3ebf5bdb\/d1\/database\/1b1bfa19-ccc5-423a-bc1f-62d89020c8e2\/query$/, "[DE1.4] conta e banco do diário");
  assert.equal(log[0].body.sql, SQL_HEAD, "[DE1.5] a cabeça é lida primeiro");
  assert.ok(log.every((c) => /^select /.test(c.body.sql)), "[DE1.6] só SELECT");
  assert.ok(log.slice(1).every((c) => c.body.params[1] === d.head.seq), "[DE1.7] linhas limitadas ao seq da cabeça (retrato consistente)");
  await assert.rejects(d1Query({ token: TOKEN, fetchImpl: fakeFetch(d.head, d.rows) })("delete from diario_v1"), /d1_sql_nao_permitida/, "[DE1.8] outra SQL é recusada antes da rede");
  const sem = [];
  const s = await lerDiario({ token: "", fetchImpl: async (...a) => { sem.push(a); return new Response("{}"); } });
  assert.equal(s.estado, "sem_token", "[DE1.9] sem o segredo: sem_token");
  assert.equal(sem.length, 0, "[DE1.10] sem o segredo, nenhuma chamada");
  const e = await lerDiario({ token: TOKEN, fetchImpl: async () => new Response("{}", { status: 403 }) });
  assert.equal(e.estado, "erro", "[DE1.11] HTTP 403: erro, sem lançar");
});

test("DE2 prova completa: cadeia, reaplicação em p20_diario_reconstruido e restaurado ∪ reconstruído = diário; RPO crítico medido", async () => {
  const log = [];
  const r = await prova(await diario(), { reconstruir: eco(log) });
  assert.equal(r.estado, "provado", "[DE2.1] provado: " + r.motivo);
  assert.equal(r.cadeia_ok, true, "[DE2.2] cadeia íntegra da genesis à cabeça");
  assert.equal(r.reconstruidos, 2, "[DE2.3] reconstruídos = os 2 eventos posteriores à cópia");
  assert.deepEqual(log, [2], "[DE2.4] só as linhas posteriores ao corte (com margem) vão para a reconstrução");
  assert.equal(r.restaurados, 1, "[DE2.5] o pedido anterior ao corte vem da cópia restaurada");
  assert.equal(r.faltando + r.sobrando, 0, "[DE2.6] conjunto igual");
  assert.equal(r.rpo_critico_medido_s, 30, "[DE2.7] RPO crítico = falha simulada − leitura do diário");
  assert.equal(r.tabela, TABELA_RECONSTRUCAO);
  const rec = await runDrill({ mode: "sintetica", env: { PGHOST: "localhost", PGDATABASE: "p20_drill", GITHUB_RUN_ID: "9", GITHUB_SHA: "abc" }, fixture: makeBackup(),
    restoreImpl: async ({ tablesJson }) => ({ ok: true, tables: Object.fromEntries(Object.keys(tablesJson).map((t) => [t, JSON.parse(tablesJson[t]).length])), preserved_without_schema: [], worker_schema_ready: true }),
    now: () => new Date(FALHA), clock: (() => { let t = 0; return () => (t += 2500); })(), inventory: INVENTORY, diarioLeitura: await diario(),
    diarioImpl: (args) => provarDiario({ ...args, restauradoSql: restaurado(), reconstruir: eco() }) });
  assert.equal(rec.verdict, "APROVADO", "[DE2.8] ensaio aprovado");
  assert.ok(!rec.not_covered.some((s) => s.startsWith("diario_d1:")), "[DE2.9] diario_d1 sai de not_covered com a prova");
  assert.equal(rec.rpo_critico_medido_s, 30, "[DE2.10] RPO crítico no registro");
  validateRecord(structuredClone(rec));
});

test("DE3 sem o token no ensaio: diario_d1 continua em not_covered com o motivo; o ensaio dos dados não muda", async () => {
  const r = await prova({ schema: SCHEMA_LEITURA, estado: "sem_token", lido_em: LIDO, head: null, rows: [], consultas: 0, motivo: "x" });
  assert.equal(r.estado, "nao_lido", "[DE3.1] nao_lido");
  assert.match(r.motivo, /CF_TOKEN_D1_DIARIO_READ ausente/, "[DE3.2] motivo nomeia o segredo");
  const nc = notCoveredFor(false, false, r);
  assert.ok(nc.includes("diario_d1: token CF_TOKEN_D1_DIARIO_READ ausente no ensaio"), "[DE3.3] linha do diário com o motivo");
  assert.equal(nc.length, NOT_COVERED.length, "[DE3.4] nenhuma lacuna some");
  assert.equal((await prova(null)).motivo, "leitura_ausente", "[DE3.5] sem arquivo de leitura");
  assert.equal(DIARIO_FASE_ENSAIO, DIARIO_FASE, "[DE3.7] a fase do ensaio é a mesma do Worker (worker/diario-reconcilia.mjs)");
  const quase = { ...(await prova(await diario())), sobrando: 1 };
  assert.ok(notCoveredFor(false, false, quase).some((s) => s.startsWith("diario_d1:")), "[DE3.6] estado provado sem a prova completa não retira a lacuna");
});

test("DE4 cadeia adulterada ou cortada: nao_provado; em sombra o ensaio segue aprovado, em ativo reprova", async () => {
  const d = await diario();
  d.rows[1].payload_json = d.rows[1].payload_json.replace("97", "98");
  const r = await prova(d);
  assert.equal(r.estado, "nao_provado", "[DE4.1] adulteração derruba a prova");
  assert.equal(r.motivo, "cadeia_quebrada", "[DE4.2] motivo");
  const cortada = await diario(); cortada.rows.pop();
  assert.equal((await prova(cortada)).motivo, "cadeia_quebrada", "[DE4.3] fim cortado (cabeça diverge)");
  const base = { env: { PGHOST: "localhost", PGDATABASE: "p20_drill" }, mode: "sintetica", fixture: makeBackup(), now: () => new Date(FALHA), inventory: INVENTORY, diarioLeitura: d,
    restoreImpl: async ({ tablesJson }) => ({ ok: true, tables: Object.fromEntries(Object.keys(tablesJson).map((t) => [t, JSON.parse(tablesJson[t]).length])), preserved_without_schema: [], worker_schema_ready: true }) };
  const sombra = await runDrill({ ...base, clock: (() => { let t = 0; return () => (t += 2500); })(), diarioImpl: (a) => provarDiario({ ...a, restauradoSql: restaurado(), reconstruir: eco() }) });
  assert.equal(sombra.verdict, "APROVADO", "[DE4.4] sombra: o ensaio dos dados não reprova pelo diário");
  assert.ok(sombra.not_covered.includes("diario_d1: cadeia_quebrada"), "[DE4.5] lacuna com o motivo");
  // Um registro recusado pela releitura (runDrill lança) também é falha desta asserção: o ensaio tem de SAIR reprovado.
  const ativo = await runDrill({ ...base, clock: (() => { let t = 0; return () => (t += 2500); })(), diarioFase: "ativo", diarioImpl: (a) => provarDiario({ ...a, restauradoSql: restaurado(), reconstruir: eco() }) })
    .catch((e) => assert.fail("[DE4.6] ativo: o ensaio devia sair REPROVADO, mas o registro foi recusado: " + e.message));
  assert.equal(ativo.verdict, "REPROVADO", "[DE4.6] ativo: diário sem prova reprova o ensaio");
  assert.ok(ativo.failures.includes("diario_sem_prova:nao_provado:cadeia_quebrada"), "[DE4.7] falha nomeada");
});

test("DE5 conjunto divergente: evento do diário sem origem na cópia nem na reconstrução, ou evento da cópia fora do diário", async () => {
  const sobra = await prova(await diario({ extra: [eventoPedidoCriado({ orderId: OC, provider: "mercadopago", ts: CORTE - 5 * H })] }));
  assert.equal(sobra.estado, "nao_provado", "[DE5.1] diário com pedido que a cópia não tem");
  assert.equal(sobra.sobrando, 1, "[DE5.2] sobrando");
  assert.equal(sobra.motivo, "conjunto_divergente", "[DE5.3] motivo");
  const falta = await prova(await diario(), { restauradoSql: restaurado([{ order_id: OA, provider: "mercadopago", ts_ms: CORTE - 3 * H }, { order_id: OC, provider: "mercadopago", ts_ms: CORTE - 4 * H }]) });
  assert.equal(falta.faltando, 1, "[DE5.4] cópia com pedido que o diário não tem");
  assert.equal(falta.estado, "nao_provado", "[DE5.5] nao_provado");
  const antigo = await prova(await diario({ extra: [eventoPedidoCriado({ orderId: OC, provider: "mercadopago", ts: CORTE - 60 * H })] }));
  assert.equal(antigo.estado, "provado", "[DE5.6] evento anterior à janela de 48 h antes do corte não entra no conjunto: " + antigo.motivo);
  assert.equal(antigo.reconstruidos, 2, "[DE5.7] e não é reconstruído");
  assert.equal(sobra.rpo_critico_medido_s, null, "[DE5.8] sem prova, sem RPO crítico");
  // Relógio do Worker 1 min antes do corte, mas a linha do Neon depois dele (fora da cópia): a margem reconstrói.
  const OD = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
  const borda = await prova(await diario({ extra: [eventoPedidoCriado({ orderId: OD, provider: "mercadopago", ts: CORTE - 60 * 1000 })] }));
  assert.equal(borda.estado, "provado", "[DE5.9] evento na borda do corte entra pela reconstrução: " + borda.motivo);
  assert.equal(borda.reconstruidos, 3, "[DE5.10] reconstruído com a margem");
});

test("DE6 reaplicação divergente (linha relida diferente ou faltando) e restauração não aprovada: nao_provado", async () => {
  const mexe = async (rows) => rows.map((r, i) => (i === 0 ? { ...r, payload_json: r.payload_json.replace("97", "96") } : { ...r }));
  assert.equal((await prova(await diario(), { reconstruir: mexe })).motivo, "reconstrucao_divergente", "[DE6.1] releitura diferente");
  assert.equal((await prova(await diario(), { reconstruir: async (rows) => rows.slice(1) })).motivo, "reconstrucao_divergente", "[DE6.2] linha faltando na releitura");
  const consultas = restaurado();
  const naoAprovada = await prova(await diario(), { restoreOk: false, restauradoSql: consultas });
  assert.equal(naoAprovada.motivo, "restauracao_nao_aprovada", "[DE6.3] sem restauração conferida não há prova");
  assert.equal(consultas.calls.length, 0, "[DE6.4] e nenhum acesso ao banco");
});

test("DE7 releitura estrita: diario_d1 só sai de not_covered com a prova completa; RPO crítico sem prova é recusado", async () => {
  const rec = await runDrill({ mode: "sintetica", env: { PGHOST: "localhost", PGDATABASE: "p20_drill" }, fixture: makeBackup(), now: () => new Date(FALHA), clock: (() => { let t = 0; return () => (t += 2500); })(), inventory: INVENTORY,
    restoreImpl: async ({ tablesJson }) => ({ ok: true, tables: Object.fromEntries(Object.keys(tablesJson).map((t) => [t, JSON.parse(tablesJson[t]).length])), preserved_without_schema: [], worker_schema_ready: true }),
    diarioLeitura: await diario(), diarioImpl: (a) => provarDiario({ ...a, restauradoSql: restaurado(), reconstruir: eco() }) });
  validateRecord(structuredClone(rec));
  const semProva = await runDrill({ mode: "sintetica", env: { PGHOST: "localhost", PGDATABASE: "p20_drill" }, fixture: makeBackup(), now: () => new Date(FALHA), clock: (() => { let t = 0; return () => (t += 2500); })(), inventory: INVENTORY,
    restoreImpl: async ({ tablesJson }) => ({ ok: true, tables: Object.fromEntries(Object.keys(tablesJson).map((t) => [t, JSON.parse(tablesJson[t]).length])), preserved_without_schema: [], worker_schema_ready: true }) });
  const f1 = structuredClone(semProva); f1.not_covered = f1.not_covered.filter((s) => !s.startsWith("diario_d1:"));
  assert.throws(() => validateRecord(f1), /diario_d1_unproven/, "[DE7.1] lacuna retirada sem prova é recusada");
  const f2 = structuredClone(rec); f2.diario.sobrando = 1;
  assert.throws(() => validateRecord(f2), /diario_d1_unproven/, "[DE7.2] prova com sobra é recusada");
  const f3 = structuredClone(rec); f3.diario.cadeia_ok = false;
  assert.throws(() => validateRecord(f3), /diario_d1_unproven/, "[DE7.3] prova com cadeia quebrada é recusada");
  const f4 = structuredClone(semProva); f4.rpo_critico_medido_s = 12;
  assert.throws(() => validateRecord(f4), /diario_d1_rpo_sem_prova/, "[DE7.4] RPO crítico sem prova é recusado");
  const f5 = structuredClone(rec); f5.diario.reconstrucao_ok = false;
  assert.throws(() => validateRecord(f5), /diario_d1_unproven/, "[DE7.5] prova sem reaplicação conferida é recusada");
  const f6 = structuredClone(rec); f6.rpo_critico_medido_s = 1;
  assert.throws(() => validateRecord(f6), /diario_d1_unproven/, "[DE7.6] RPO crítico diferente do medido é recusado");
  const f7 = structuredClone(rec); f7.verdict = "REPROVADO"; f7.failures = ["hash_mismatch:orders"]; f7.rto_seconds = null;
  assert.throws(() => validateRecord(f7), /diario_d1_unproven/, "[DE7.7] lacuna só sai num ensaio APROVADO");
});

test("DE8 workflow mensal: o token de leitura do D1 só no passo que lê o diário (env do passo); o ensaio recebe só o arquivo", () => {
  const wf = readTextNormalized(new URL("../.github/workflows/p20-monthly-restore-drill.yml", import.meta.url));
  const [drillJob, publishJob] = wf.split(/\n  publish:\n/);
  const steps = drillJob.split(/\n      - /).slice(1);
  const comToken = steps.filter((s) => /CF_TOKEN_D1_DIARIO_READ/.test(s));
  assert.equal(comToken.length, 1, "[DE8.1] um único passo menciona o token de leitura do D1");
  assert.match(comToken[0], /^name: P20 diário D1 - leitura para o ensaio/, "[DE8.2] é o passo de leitura do diário");
  assert.match(comToken[0], /\n        env:\n          CF_TOKEN_D1_DIARIO_READ: \$\{\{ secrets\.CF_TOKEN_D1_DIARIO_READ \}\}\n/, "[DE8.3] no env do passo");
  assert.match(comToken[0], /node scripts\/p20\/diario-d1-read\.mjs --out "\$RUNNER_TEMP\/p20\/diario\.json"/, "[DE8.4] só o leitor do diário roda nele");
  assert.doesNotMatch(comToken[0], /CLOUDFLARE_API_TOKEN|P20_BACKUP_KEYS/, "[DE8.5] nenhum outro segredo no passo do diário");
  const ensaio = steps.find((s) => /--mode producao/.test(s));
  assert.match(ensaio, /--diario "\$RUNNER_TEMP\/p20\/diario\.json"/, "[DE8.6] o ensaio lê o arquivo do diário");
  assert.ok(steps.indexOf(comToken[0]) < steps.indexOf(ensaio), "[DE8.7] leitura do diário antes do ensaio (falha simulada depois da leitura)");
  const jobEnv = drillJob.split(/\n  drill:\n/)[1].split(/\n    steps:\n/)[0];
  assert.doesNotMatch(jobEnv + publishJob, /CF_TOKEN_D1/, "[DE8.8] nem no env do job, nem na publicação");
  const leitor = readTextNormalized(new URL("../scripts/p20/diario-d1-read.mjs", import.meta.url));
  assert.equal((leitor.match(/method: "POST"/g) || []).length, 1, "[DE8.9] um único POST, o da consulta D1");
  assert.doesNotMatch(leitor, /CLOUDFLARE_API_TOKEN|CF_TOKEN_D1_DIARIO_MIGRATE/, "[DE8.10] o leitor só conhece o token de leitura");
});

test("DE9 NC-PR6-01: fora da sombra, só o estado provado com a prova completa passa (lista positiva); qualquer outro estado reprova", async () => {
  const restoreImpl = async ({ tablesJson }) => ({ ok: true, tables: Object.fromEntries(Object.keys(tablesJson).map((t) => [t, JSON.parse(tablesJson[t]).length])), preserved_without_schema: [], worker_schema_ready: true });
  const ensaio = (extra) => runDrill({ mode: "sintetica", env: { PGHOST: "localhost", PGDATABASE: "p20_drill" }, fixture: makeBackup(), now: () => new Date(FALHA),
    clock: (() => { let t = 0; return () => (t += 2500); })(), inventory: INVENTORY, restoreImpl, ...extra });
  const real = (leitura) => ({ diarioLeitura: leitura, diarioImpl: (a) => provarDiario({ ...a, restauradoSql: restaurado(), reconstruir: eco() }) });
  const adulterada = await diario(); adulterada.rows[1].payload_json = adulterada.rows[1].payload_json.replace("97", "98");
  const provado = await prova(await diario());
  const casos = [
    ["sem_token", real({ schema: SCHEMA_LEITURA, estado: "sem_token", lido_em: LIDO, head: null, rows: [], consultas: 0 }), /^diario_sem_prova:nao_lido:token/],
    ["leitura_ausente", real(null), /^diario_sem_prova:nao_lido:leitura_ausente/],
    ["leitura_incompleta", real({ schema: SCHEMA_LEITURA, estado: "incompleto", lido_em: LIDO, head: null, rows: [], consultas: 201, motivo: "paginas_excedidas" }), /^diario_sem_prova:nao_lido:leitura_incompleto/],
    ["leitura_erro", real({ schema: SCHEMA_LEITURA, estado: "erro", lido_em: LIDO, head: null, rows: [], consultas: 1, motivo: "d1_http_403" }), /^diario_sem_prova:nao_lido:leitura_erro/],
    ["cadeia_invalida", real(adulterada), /^diario_sem_prova:nao_provado:cadeia_quebrada/],
    ["conjunto_divergente", real(await diario({ extra: [eventoPedidoCriado({ orderId: OC, provider: "mercadopago", ts: CORTE - 5 * H })] })), /^diario_sem_prova:nao_provado:conjunto_divergente/],
    ["provado_forjado", { diarioImpl: async () => ({ ...provado, faltando: 1 }) }, /^diario_sem_prova:provado/],
    ["estado_desconhecido", { diarioImpl: async () => ({ ...provado, estado: "quase_provado" }) }, /^diario_sem_prova:quase_provado/],
    ["excecao", { diarioImpl: async () => { throw new Error("boom"); } }, /^diario_sem_prova:nao_provado:excecao/],
    ["impl_declara_sombra", { diarioImpl: async () => ({ estado: "nao_lido", motivo: "x", fase: "sombra" }) }, /^diario_sem_prova:nao_lido/],
    // Implementação que não devolve objeto: fora da sombra o ensaio reprova (antes passava por não ser objeto).
    ["impl_devolve_null", { diarioImpl: async () => null }, /^diario_sem_prova:ausente:diario_nao_devolvido$/],
    ["impl_devolve_lista", { diarioImpl: async () => [] }, /^diario_sem_prova:ausente:diario_nao_devolvido$/],
    ["impl_devolve_texto", { diarioImpl: async () => "provado" }, /^diario_sem_prova:ausente:diario_nao_devolvido$/],
  ];
  for (const [nome, extra, re] of casos) {
    const a = await ensaio({ ...extra, diarioFase: "ativo" }).catch((e) => assert.fail(`[DE9.1] ativo + ${nome}: o ensaio devia sair REPROVADO, mas o registro foi recusado: ${e.message}`));
    assert.equal(a.verdict, "REPROVADO", `[DE9.1] ativo + ${nome}: reprova`);
    assert.ok(a.failures.some((f) => re.test(f)), `[DE9.2] ativo + ${nome}: falha nomeada (${a.failures.join(",")})`);
    assert.ok(a.not_covered.some((s) => s.startsWith("diario_d1:")), `[DE9.3] ativo + ${nome}: lacuna continua`);
    if (nome !== "excecao" && nome !== "impl_declara_sombra" && nome !== "provado_forjado" && nome !== "estado_desconhecido") {
      const s = await ensaio({ ...extra, diarioFase: "sombra" });
      assert.equal(s.verdict, "APROVADO", `[DE9.4] sombra + ${nome}: só registra`);
    }
  }
  const desconhecida = await ensaio({ ...real(null), diarioFase: "qualquer" }).catch((e) => assert.fail("[DE9.5] fase desconhecida: registro recusado: " + e.message));
  assert.equal(desconhecida.verdict, "REPROVADO", "[DE9.5] fase desconhecida = lado estrito");
  const ok = await ensaio({ ...real(await diario()), diarioFase: "ativo" });
  assert.equal(ok.verdict, "APROVADO", "[DE9.6] ativo + provado: aprovado");
  assert.ok(!ok.not_covered.some((s) => s.startsWith("diario_d1:")), "[DE9.7] e a lacuna sai");
  const forjado = structuredClone(await ensaio({ ...real(null), diarioFase: "sombra" }));
  forjado.diario.fase = "ativo";
  assert.throws(() => validateRecord(forjado), /diario_ativo_sem_prova/, "[DE9.8] releitura: aprovado em ativo sem prova é recusado");
});
