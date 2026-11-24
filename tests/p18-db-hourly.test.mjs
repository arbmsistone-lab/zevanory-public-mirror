// ZEVANORY | P0 24/11/2026: o P18 esgotou a cota de 100 CU-h/mês do Neon (Free) ao sondar /api/status e /api/health
// a cada 5 min (o banco nunca ficava 5 min ocioso). Prova SINTÉTICA de que:
//  - só a janela do minuto 0 de cada hora (ou a 1ª depois de 65 min sem leitura) chama rotas que tocam o PostgreSQL;
//  - as páginas de venda e os controles sem E/S continuam a cada 5 min (detecção de queda do site preservada);
//  - banco fora NÃO aumenta a frequência das chamadas ao banco (sem cascata);
//  - incidente do banco fica aberto até a próxima leitura horária boa (não "recupera" numa janela sem banco);
//  - página fora numa janela sem banco confirma e alerta sem acordar o banco;
//  - P22 passa a esperar 24 leituras/dia; o validador recusa sondagem "sem banco" que tenha rota do banco.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextNormalized } from "./helpers/text.mjs";
import {
  SCHEMA_PROBE, ALERT_TITLE, SALES_PAGES, STATUS_URL, CONTROL_URLS, validateProbe, aggregateProbes, shouldProbeDb, lastDbProbeAt,
  DB_PROBE_MAX_AGE_MIN, DB_PROBES_PER_DAY, DB_PROBE_SKIPPED, isDbDependent,
} from "../scripts/b0/b0-lib.mjs";
import { main as monitorMain, targetId } from "../scripts/b0/p18-monitor.mjs";

const at = (hms, day = "2026-11-25") => Date.parse(`${day}T${hms}Z`);
const DB_PATHS = new Set(["/api/status", "/api/health"]);  // em zevanory.api.br e edge.zevanory.api.br
const isDbCall = (c) => { const u = new URL(c.url); return u.host !== "api.github.com" && DB_PATHS.has(u.pathname); };
const res = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

function net(ctl) {
  const calls = [], issues = [], comments = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url: String(url), method, at: ctl.clock() });
    const u = new URL(String(url));
    if (u.host === "api.github.com") {
      if (u.pathname.endsWith("/issues") && method === "GET") return res(issues.filter((i) => i.state === "open"));
      if (u.pathname.endsWith("/issues")) { const b = JSON.parse(init.body); const i = { number: 70 + issues.length, title: b.title, body: b.body, state: "open" }; issues.push(i); return res(i, 201); }
      const m = /\/issues\/(\d+)$/.exec(u.pathname);
      if (m && method === "PATCH") { const i = issues.find((x) => x.number === Number(m[1])); const b = JSON.parse(init.body); if (b.state) i.state = b.state; return res(i); }
      const c = /\/issues\/(\d+)\/comments$/.exec(u.pathname);
      if (c) { comments.push({ issue: Number(c[1]), body: JSON.parse(init.body).body }); return res({ id: comments.length }, 201); }
      return res({}, 404);
    }
    if (DB_PATHS.has(u.pathname) && ctl.dbDown) return res({ error: "db" }, 503);
    if (ctl.pageDown && u.host + u.pathname === ctl.pageDown) return res("down", 503);
    if (u.pathname === "/api/status") return res({ commercial_metrics_provenance: { state: "UNVERIFIED_FAIL_CLOSED", measured_at: null, commercial_release_allowed: false }, sales_authorization: { state: "closed" } });
    return res("<html>ok</html>", 200);
  };
  return { calls, issues, comments, fetchImpl };
}

// Uma execução por janela de 5 min, pedida pelo cron da Cloudflare (window_id), 2 min depois do início da janela.
function harness(startHms, day = "2026-11-25") {
  const dir = mkdtempSync(join(tmpdir(), "zev-p18db-"));
  const ctl = { dbDown: false, pageDown: null };
  let clock = at(startHms, day);
  ctl.clock = () => clock;
  const n = net(ctl);
  let seq = 0;
  const run = async () => {
    const w = Math.floor((clock - 120000) / 300000) * 300000;  // janela pedida = início da janela de 5 min
    const s = new Date(w).toISOString();
    const windowId = "p18w-" + s.slice(0, 4) + s.slice(5, 7) + s.slice(8, 10) + "T" + s.slice(11, 13) + s.slice(14, 16) + "Z";
    seq += 1;
    const env = { EVIDENCE_DIR: dir, GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "fake", GITHUB_RUN_ID: String(900 + seq), GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "workflow_dispatch",
      P18_WINDOW_ID: windowId, P18_DISPATCHED_AT: new Date(clock - 1000).toISOString(), P18_DISPATCH_SOURCE: "cloudflare-cron" };
    const startedAt = clock;
    const r = await monitorMain({ env, fetchImpl: n.fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; }, pause: async () => {}, log: () => {} });
    clock = startedAt + 300000;  // próxima janela
    return r;
  };
  const skip = () => { clock += 300000; };  // janela perdida (nenhuma execução)
  return { dir, ctl, n, run, skip, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const probesOf = (dir, month = "2026-11") => {
  const f = join(dir, "p18", `probes-${month}.jsonl`);
  return existsSync(f) ? readTextNormalized(f).trim().split("\n").filter(Boolean).map((l) => validateProbe(JSON.parse(l))) : [];
};

test("[DBH-1] política: minuto 0 sempre; fora dele só depois de 65 min sem leitura; sem histórico sonda", () => {
  assert.equal(DB_PROBE_MAX_AGE_MIN, 65);
  assert.equal(shouldProbeDb({ windowMs: at("10:00:00"), lastDbAt: new Date(at("09:58:00")).toISOString(), nowMs: at("10:02:00") }), true, "minuto 0");
  assert.equal(shouldProbeDb({ windowMs: at("10:05:00"), lastDbAt: new Date(at("10:02:00")).toISOString(), nowMs: at("10:07:00") }), false, "dentro da hora");
  assert.equal(shouldProbeDb({ windowMs: at("10:55:00"), lastDbAt: new Date(at("10:02:00")).toISOString(), nowMs: at("10:57:00") }), false, "55 min: ainda não");
  assert.equal(shouldProbeDb({ windowMs: at("11:05:00"), lastDbAt: new Date(at("10:02:00")).toISOString(), nowMs: at("11:07:20") }), true, "janela do minuto 0 perdida: 65 min");
  assert.equal(shouldProbeDb({ windowMs: at("10:05:00"), lastDbAt: null, nowMs: at("10:07:00") }), true, "sem histórico");
  assert.equal(shouldProbeDb({ windowMs: NaN, lastDbAt: null, nowMs: at("10:07:00") }), true, "entrada estranha: fail-safe");
  assert.deepEqual(CONTROL_URLS.filter((c) => isDbDependent(c.deps)).map((c) => targetId(c.url)).sort(), ["edge.zevanory.api.br/api/status", "zevanory.api.br/api/health"]);
  // Linhas antigas (sem db_probed) contam como leitura do banco.
  assert.equal(lastDbProbeAt([{ at: "2026-11-25T10:02:00.000Z" }, { at: "2026-11-25T10:07:00.000Z", db_probed: false }]), "2026-11-25T10:02:00.000Z");
});

test("[DBH-2] 24 h de execuções a cada 5 min: banco lido 24 vezes (3 rotas cada), páginas em todas as 288", async () => {
  const h = harness("00:02:00");
  try {
    for (let i = 0; i < 288; i += 1) await h.run();
    const probes = probesOf(h.dir);
    assert.equal(probes.length, 288, "uma sondagem por janela (site a cada 5 min)");
    assert.equal(probes.filter((p) => p.db_probed).length, 24, "banco 1x por hora");
    assert.ok(probes.filter((p) => p.db_probed).every((p) => new Date(p.at).getUTCMinutes() < 5), "sempre na janela do minuto 0");
    assert.equal(h.n.calls.filter(isDbCall).length, 24 * 3, "3 rotas do banco por leitura horária, nenhuma outra");
    const pages = SALES_PAGES.map(targetId);
    assert.ok(probes.every((p) => pages.every((id) => p.targets.some((t) => t.id === id))), "todas as páginas em todas as janelas");
    assert.ok(probes.every((p) => p.controls.some((c) => c.id === "zevanory.api.br/api/release")), "controle sem E/S em todas as janelas");
    // Maior intervalo entre chamadas ao banco <= 65 min; menor >= 55 min (nada em cascata).
    const ts = h.n.calls.filter(isDbCall).map((c) => c.at);
    const starts = ts.filter((t, i) => i === 0 || t - ts[i - 1] > 60000);
    const gaps = starts.slice(1).map((t, i) => (t - starts[i]) / 60000);
    assert.ok(Math.max(...gaps) <= 65 && Math.min(...gaps) >= 55, "intervalos " + JSON.stringify([Math.min(...gaps), Math.max(...gaps)]));
    // P22: 24 esperadas no dia, cobertura completa.
    const ag = aggregateProbes(probes, "2026-11-25");
    assert.equal(ag.p22.expected, DB_PROBES_PER_DAY); assert.equal(ag.p22.readings, 24); assert.equal(ag.p22.coverage, 1);
    assert.equal(ag.enough22, true); assert.equal(ag.p18.expected, 288); assert.equal(ag.p18.coverage, 1);
  } finally { h.done(); }
});

test("[DBH-3] banco fora: confirma na janela do minuto 0, mantém o alerta aberto nas janelas sem banco e fecha na próxima leitura boa", async () => {
  const h = harness("10:02:00");
  try {
    await h.run();                                   // 10:00 ok (lê o banco)
    h.ctl.dbDown = true;
    for (let i = 0; i < 11; i += 1) await h.run();   // 10:05..10:55: sem banco, site ok
    assert.equal(h.n.calls.filter(isDbCall).length, 3, "banco fora ainda não visto: nenhuma chamada extra");
    const r = await h.run();                          // 11:00: lê o banco, falha, re-sonda em 60 s e confirma
    assert.equal(r.action, "confirm"); assert.equal(h.n.issues.length, 1); assert.equal(h.n.issues[0].title, ALERT_TITLE);
    assert.match(h.n.issues[0].body, /api\/status/, "o alerta diz que é o banco/status");
    // Com falha, cada rota do banco tem 1 nova tentativa após 3 s (probeUrl retries:1): leitura 3x2 + confirmação 3x2,
    // tudo dentro de ~70 s da mesma janela (mesmo despertar do banco).
    const dbCalls = h.n.calls.filter(isDbCall);
    assert.equal(dbCalls.length, 3 + 6 + 6, "leitura + confirmação, com nova tentativa por rota");
    assert.ok(dbCalls.at(-1).at - dbCalls[3].at <= 70000, "todas as chamadas da falha em até 70 s");
    const before = h.n.calls.filter(isDbCall).length;
    for (let i = 0; i < 11; i += 1) {
      const x = await h.run();                        // 11:05..11:55: site ok, banco não lido
      assert.equal(x.action, "hold_db_unprobed", "não recupera sem ler o banco");
    }
    assert.equal(h.n.calls.filter(isDbCall).length, before, "banco fora NÃO aumenta a frequência (sem cascata)");
    assert.equal(h.n.issues[0].state, "open", "alerta continua aberto");
    assert.equal(h.n.comments.length, 0, "nenhum comentário de recuperação falso");
    h.ctl.dbDown = false;
    const rec = await h.run();                        // 12:00: leitura boa
    assert.equal(rec.action, "recover"); assert.equal(h.n.issues[0].state, "closed");
  } finally { h.done(); }
});

test("[DBH-4] página fora numa janela sem banco: confirma e alerta sem acordar o banco", async () => {
  const h = harness("10:02:00");
  try {
    await h.run();                                    // 10:00 ok
    const dbBefore = h.n.calls.filter(isDbCall).length;
    h.ctl.pageDown = "vendas.zevanory.api.br/ia-na-pratica";
    const r = await h.run();                          // 10:05: falha + re-sondagem em 60 s
    assert.equal(r.action, "confirm"); assert.equal(r.probes.length, 2);
    assert.ok(r.probes.every((p) => p.db_probed === false), "confirmação usa a mesma decisão (sem banco)");
    assert.equal(h.n.calls.filter(isDbCall).length, dbBefore, "nenhuma rota do banco");
    assert.match(h.n.issues[0].body, /ia-na-pratica/);
    h.ctl.pageDown = null;
    const rec = await h.run();                        // 10:10: página volta; incidente era de página: recupera já
    assert.equal(rec.action, "recover"); assert.equal(h.n.issues[0].state, "closed");
  } finally { h.done(); }
});

test("[DBH-5] validador: sondagem sem banco não pode ter rota do banco nem leitura P22", () => {
  const base = { schema: SCHEMA_PROBE, at: "2026-11-25T10:07:00.000Z", kind: "scheduled", up: true,
    targets: SALES_PAGES.map((u) => ({ id: targetId(u), ok: true, status: 200 })), p22: { readable: false, reason: DB_PROBE_SKIPPED },
    controls: [{ id: "zevanory.api.br/api/release", ok: true, status: 200 }], db_probed: false };
  assert.equal(validateProbe(structuredClone(base)).db_probed, false);
  assert.throws(() => validateProbe({ ...structuredClone(base), targets: [...base.targets, { id: targetId(STATUS_URL), ok: true, status: 200 }] }), /probe_db_skip_mismatch/);
  assert.throws(() => validateProbe({ ...structuredClone(base), controls: [{ id: "zevanory.api.br/api/health", ok: true, status: 200 }] }), /probe_db_skip_mismatch/);
  assert.throws(() => validateProbe({ ...structuredClone(base), p22: { readable: true } }), /probe_db_skip_mismatch/);
  assert.throws(() => validateProbe({ ...structuredClone(base), db_probed: "no" }), /bad_probe_db_probed/);
  // Linha antiga (sem db_probed) continua válida.
  const { db_probed, ...old } = structuredClone(base);
  assert.equal(validateProbe({ ...old, p22: { readable: false, reason: "x" } }).db_probed, undefined);
});

test("[DBH-6] desempenho do /api/status: 2 leituras horárias lentas seguidas degradam; 2 rápidas recuperam (janelas sem banco não zeram)", async () => {
  const { foldPerf } = await import("../scripts/b0/p18-latency.mjs");
  const ST = targetId(STATUS_URL), HOME = targetId(SALES_PAGES[0]);
  const mk = (iso, db, stMs) => validateProbe({ schema: SCHEMA_PROBE, at: iso, kind: "scheduled", up: true,
    targets: [{ id: HOME, ok: true, status: 200, latency_ms: 100 }, ...(db ? [{ id: ST, ok: true, status: 200, latency_ms: stMs }] : [])],
    p22: db ? { readable: false, reason: "x" } : { readable: false, reason: DB_PROBE_SKIPPED }, db_probed: db });
  const hour = (h, stMs) => Array.from({ length: 12 }, (_, i) => mk(new Date(Date.UTC(2026, 10, 25, h, i * 5, 30)).toISOString(), i === 0, stMs));
  const slow = foldPerf([...hour(10, 9000), ...hour(11, 9000)]);
  assert.equal(slow.view.state, "DEGRADADO", "2 leituras horárias lentas"); assert.deepEqual(slow.incident.routes, [ST]);
  const rec = foldPerf([...hour(10, 9000), ...hour(11, 9000), ...hour(12, 100), ...hour(13, 100)]);
  assert.notEqual(rec.view.state, "DEGRADADO", "2 leituras horárias rápidas recuperam");
  assert.equal(foldPerf([...hour(10, 9000), ...hour(11, 100)]).incident, null, "uma lenta isolada não degrada");
});

// ---- Contraprovas pedidas pelo GPT-6 (24/11, 19:31) ---------------------------------------------------------
test("[DBH-7] banco e página fora ao mesmo tempo: a volta de um nunca fecha o alerta do outro", async () => {
  const issueOpen = (h) => h.n.issues.length === 1 && h.n.issues[0].state === "open";
  // (a) os dois caem juntos na janela do banco; a página volta antes: alerta segue aberto até o banco voltar.
  let h = harness("11:02:00");
  try {
    h.ctl.dbDown = true; h.ctl.pageDown = "vendas.zevanory.api.br/ia-na-pratica";
    assert.equal((await h.run()).action, "confirm");
    h.ctl.pageDown = null;
    for (let i = 0; i < 11; i += 1) assert.equal((await h.run()).action, "hold_db_unprobed", "a-página voltou, banco não lido");
    assert.ok(issueOpen(h), "a-aberto"); assert.equal(h.n.comments.length, 0, "a-sem recuperação falsa");
    assert.equal((await h.run()).action, "update", "a-12:00 banco ainda fora");
    h.ctl.dbDown = false;
    for (let i = 0; i < 11; i += 1) await h.run();
    assert.equal((await h.run()).action, "recover", "a-13:00 banco bom"); assert.equal(h.n.issues[0].state, "closed");
  } finally { h.done(); }
  // (b) os dois fora; o banco volta antes e a página não: o alerta segue aberto até a página voltar.
  h = harness("11:02:00");
  try {
    h.ctl.dbDown = true; h.ctl.pageDown = "vendas.zevanory.api.br/ia-na-pratica";
    assert.equal((await h.run()).action, "confirm");
    h.ctl.dbDown = false;
    for (let i = 0; i < 11; i += 1) assert.equal((await h.run()).action, "update", "b-página ainda fora");
    assert.equal((await h.run()).action, "update", "b-12:00 banco bom, página fora: não fecha"); assert.ok(issueOpen(h));
    h.ctl.pageDown = null;
    assert.equal((await h.run()).action, "recover", "b-página voltou e o banco foi lido bom às 12:00"); assert.equal(h.n.issues[0].state, "closed");
  } finally { h.done(); }
  // (c) o alerta nasce da PÁGINA (janela sem banco); o banco cai na hora seguinte; a página volta numa janela sem banco:
  //     o alerta NÃO pode fechar, porque a última leitura do banco falhou.
  h = harness("10:57:00");
  try {
    h.ctl.pageDown = "vendas.zevanory.api.br/ia-na-pratica";
    assert.equal((await h.run()).action, "confirm", "c-10:55 página fora");
    h.ctl.dbDown = true;
    assert.equal((await h.run()).action, "update", "c-11:00 página e banco fora");
    h.ctl.pageDown = null;
    for (let i = 0; i < 11; i += 1) assert.equal((await h.run()).action, "hold_db_unprobed", "c-página voltou, última leitura do banco falhou");
    assert.ok(issueOpen(h), "c-aberto"); assert.equal(h.n.comments.length, 0, "c-sem recuperação falsa");
    h.ctl.dbDown = false;
    assert.equal((await h.run()).action, "recover", "c-12:00 banco bom"); assert.equal(h.n.issues[0].state, "closed");
  } finally { h.done(); }
});

test("[DBH-8] janela do minuto 0 perdida: a 1ª janela após 65 min lê o banco, sem duplicar nem aumentar as leituras", async () => {
  const h = harness("00:02:00");
  const missed = new Set(["03:00", "07:00", "08:00", "15:00", "15:05", "15:10"]);
  try {
    for (let i = 0; i < 288; i += 1) {
      const hhmm = new Date(at("00:00:00") + i * 300000).toISOString().slice(11, 16);
      if (missed.has(hhmm)) h.skip(); else await h.run();
    }
    const all = probesOf(h.dir), db = all.filter((p) => p.db_probed);
    const ts = db.map((p) => Date.parse(p.at));
    const gaps = ts.slice(1).map((t, i) => (t - ts[i]) / 60000);
    // Regra exata: nenhuma execução que pulou o banco estava a mais de 65 min da última leitura (o atraso além disso
    // só existe quando nenhuma execução aconteceu, como às 15:00-15:10).
    let last = null;
    for (const p of all) {
      const t = Date.parse(p.at);
      if (!p.db_probed) assert.ok(last !== null && t - last <= 65 * 60000, "pulou o banco com " + ((t - last) / 60000) + " min em " + p.at);
      else last = t;
    }
    assert.ok(db.some((p) => p.at.slice(11, 16) === "15:17"), "15h: 1ª execução depois das 3 janelas perdidas lê o banco");
    // Realinhamento depois do fallback pode aproximar duas leituras (ex.: 08:22 e 09:02), mas nunca 2 na mesma hora.
    assert.ok(Math.min(...gaps) >= 30, "nunca duas leituras próximas: " + Math.min(...gaps));
    const perHour = {}; for (const p of db) perHour[p.at.slice(0, 13)] = (perHour[p.at.slice(0, 13)] || 0) + 1;
    assert.ok(Object.values(perHour).every((v) => v === 1), "no máximo 1 leitura por hora: " + JSON.stringify(perHour));
    assert.ok(db.length <= 24, "não aumenta as leituras do dia: " + db.length);
    assert.ok(db.length >= 23, "fallback cobre as horas perdidas: " + db.length);
    const at0 = (hhmm) => db.some((p) => p.at.slice(11, 16) === hhmm);
    assert.ok(!at0("03:02") && db.some((p) => p.at.slice(11, 13) === "03"), "03h: lido por fallback");
    assert.ok(db.some((p) => p.at.slice(11, 13) === "15"), "15h: três janelas perdidas, lido por fallback");
    assert.equal(h.n.calls.filter(isDbCall).length, db.length * 3, "3 rotas por leitura, nenhuma duplicada");
    assert.equal(probesOf(h.dir).length, 288 - missed.size, "uma sondagem por janela executada");
  } finally { h.done(); }
});
