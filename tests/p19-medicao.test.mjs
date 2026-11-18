// P19 fase 1 (medição, sem mudar comportamento): etapas com entrada e saída, Server-Timing genérico, /api/status
// real (ok e travado), reviews/summary, tentativas do P18 e controles fora da disponibilidade.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDiag, cleanDiagRid, DIAG_RID_HEADER, openStages } from "../worker/diag-stages.mjs";
import { handleReviews } from "../worker/reviews.mjs";
import { probeUrl } from "../scripts/b0/b0-collector.mjs";
import { runProbe, targetId } from "../scripts/b0/p18-monitor.mjs";
import { CONTROL_URLS, SALES_PAGES, STATUS_URL, validateProbe } from "../scripts/b0/b0-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tick = () => new Promise((r) => setImmediate(r));

test("P19.1 etapa registra a ENTRADA antes de esperar: leitura que nunca termina deixa só o start", async () => {
  const lines = [];
  const d = createDiag("/api/status", { log: (l) => lines.push(JSON.parse(l)) });
  d.stage("operational_read", "db", () => new Promise(() => {}));
  await tick();
  assert.deepEqual(lines.map((l) => [l.stage, l.phase]), [["operational_read", "start"]]);
  assert.match(lines[0].rid, /^[0-9a-f]{12}$/);
  assert.equal(lines[0].route, "/api/status");
});

test("P19.2 saída com ok/ms; erro é relançado SEM alteração e registra a classe", async () => {
  const lines = [];
  let clock = 1000;
  const d = createDiag("/r", { log: (l) => lines.push(JSON.parse(l)), now: () => clock });
  const v = await d.stage("kv_x", "kv", async () => { clock += 7; return 42; });
  assert.equal(v, 42);
  const boom = new TypeError("detalhe que não pode vazar");
  await assert.rejects(d.stage("pg_y", "db", async () => { clock += 5; throw boom; }), (e) => e === boom);
  const ends = lines.filter((l) => l.phase === "end");
  assert.deepEqual(ends.map((l) => [l.stage, l.ok, l.ms]), [["kv_x", true, 7], ["pg_y", false, 5]]);
  assert.equal(ends[1].error_class, "TypeError");
  assert.ok(!JSON.stringify(lines).includes("detalhe"), "mensagem do erro nunca vai ao log");
  assert.equal(d.serverTiming(), "db;dur=5, kv;dur=7, total;dur=12");
});

test("P19.3 Server-Timing público só tem rótulos genéricos; rid externo inválido é descartado", () => {
  const d = createDiag("/api/status", { log: () => {} });
  assert.match(d.serverTiming(), /^total;dur=\d+$/);
  assert.equal(cleanDiagRid("ABCDEF012345"), "abcdef012345");
  for (const bad of ["", "x".repeat(12), "abc", "abcdef0123456", "abcdef01234\n"]) assert.equal(cleanDiagRid(bad), null);
  assert.equal(DIAG_RID_HEADER, "x-zevanory-diag");
});

test("P19.4 reviews/summary: mesmo corpo e status; DDL e consulta medidos em separado; nenhuma SQL no log", async () => {
  const logs = [];
  const real = console.log;
  console.log = (l) => { if (String(l).includes('"diag_stage"')) logs.push(JSON.parse(l)); else real(l); };
  try {
    const sqlFactory = () => ({ query: async (q) => (/select offer_id/.test(q) ? [{ offer_id: "kit-a", n: 3, avg: 4.7 }] : []) });
    const res = await handleReviews(new Request("https://zevanory.api.br/api/reviews/summary"), { DATABASE_URL: "postgresql://x" }, { sqlFactory });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.products, "object");
    assert.match(res.headers.get("server-timing"), /^db;dur=\d+, total;dur=\d+$/);
    assert.match(res.headers.get(DIAG_RID_HEADER), /^[0-9a-f]{12}$/);
    assert.equal(res.headers.get("cache-control"), "public, max-age=600", "cache inalterado");
    const stages = logs.map((l) => `${l.stage}:${l.phase}`);
    assert.ok(stages.includes("pg_review_summary:start") && stages.includes("pg_review_summary:end"));
    assert.ok(!JSON.stringify(logs).match(/select|create table|zevanory_reviews/i), "nenhum texto de consulta no log");
  } finally { console.log = real; }
});

function statusProbe(mode, rid = "") {
  const r = spawnSync(process.execPath, ["--import", "./tests/t4_sim/register.mjs", "tests/helpers/p19_status_probe.mjs", mode, rid], { cwd: ROOT, encoding: "utf8", timeout: 90000 });
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
  assert.ok(line, "sonda sem resultado: " + (r.stderr || "").slice(-800));
  return JSON.parse(line.slice("PROBE_RESULT ".length));
}

test("P19.5 /api/status real (Worker de produção, banco simulado): 200, Server-Timing genérico, início e fim de cada etapa", () => {
  const out = statusProbe("ok");
  assert.equal(out.status, 200);
  assert.equal(out.body_has_project, true);
  assert.match(out.server_timing, /^db;dur=\d+, kv;dur=\d+, total;dur=\d+$/);
  assert.match(out.diag_header, /^[0-9a-f]{12}$/);
  assert.ok(out.logs.every((l) => l.rid === out.diag_header), "um rid correlaciona Worker e runtime recuperado");
  const pairs = (stage) => out.logs.filter((l) => l.stage === stage).map((l) => l.phase);
  for (const s of ["operational_read", "kv_sales_switch", "kv_financial_proof", "kv_proof_evidence"]) assert.deepEqual(pairs(s).filter((p) => p !== "note"), ["start", "end"], s);
  assert.deepEqual(pairs("pg_read"), ["start", "end"]);
  assert.equal(out.logs.find((l) => l.stage === "pg_read").read_route, "canonical");
  assert.equal(out.neon_calls, 9, "as 9 consultas de sempre");
  assert.ok(!JSON.stringify(out.logs).match(/postgresql:|neon\.tech|select /i), "nenhuma URL de banco nem SQL no log");
});

test("P19.6 /api/status com o banco TRAVADO: sem resposta, mas a entrada da leitura do PostgreSQL fica registrada", () => {
  const out = statusProbe("hang");
  assert.equal(out.outcome, "no_response");
  assert.deepEqual(out.logs.map((l) => `${l.stage}:${l.phase}`), ["operational_read:start", "pg_read:start"]);
  assert.equal(out.logs[1].read_route, "canonical");
  assert.equal(out.logs[0].rid, out.logs[1].rid);
  // Sem resposta, o smoke não recebe o rid: o evento interno é recuperado pelas etapas abertas da rota na janela.
  assert.deepEqual(openStages(out.logs, { route: "/api/status" }), [
    { rid: out.logs[0].rid, route: "/api/status", stage: "operational_read" },
    { rid: out.logs[0].rid, route: "/api/status", stage: "pg_read", read_route: "canonical" },
  ]);
  assert.deepEqual(openStages(statusProbe("ok").logs, { route: "/api/status" }), [], "leitura completa não deixa etapa aberta");
});

test("P19.7 probeUrl: cada tentativa com início e duração; 1ª esgota o tempo, a nova responde", async () => {
  let n = 0;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    n += 1;
    if (n === 1) { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))); return; }
    resolve(new Response("ok", { status: 200 }));
  });
  const keep = setInterval(() => {}, 1000);  // AbortSignal.timeout não segura o loop de eventos sozinho
  let r;
  try { r = await probeUrl("https://zevanory.api.br/api/status", { fetchImpl, pause: async () => {}, timeoutMs: 50 }); } finally { clearInterval(keep); }
  assert.equal(r.status, 200); assert.equal(r.attempts, 2);
  assert.equal(r.tries.length, 2);
  assert.equal(r.tries[0].error, "TimeoutError"); assert.ok(r.tries[0].ms >= 40);
  assert.equal(r.tries[1].status, 200);
  for (const t of r.tries) assert.ok(!Number.isNaN(Date.parse(t.started_at)));
  assert.ok(r.elapsed_ms >= r.tries[0].ms);
});

test("P19.8 runProbe: controles na mesma janela, fora de up; versão servida lida de /api/release e vendas /health", async () => {
  const sha = "a".repeat(40), salesSha = "b".repeat(40);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.host === "edge.zevanory.api.br") return new Response("{}", { status: 503 });  // controle falho
    if (u.pathname === "/api/release") return new Response(JSON.stringify({ deployment: { commit_sha: sha } }));
    if (u.pathname === "/health") return new Response(JSON.stringify({ ok: true, release: salesSha }));
    if (u.pathname === "/api/status" || u.pathname === "/api/health") return new Response("{}");
    return new Response("<html>ok</html>");
  };
  const p = await runProbe({ fetchImpl, pause: async () => {}, now: () => Date.parse("2026-11-18T18:00:00Z") });
  assert.equal(p.up, true, "controle falho não derruba a disponibilidade");
  assert.deepEqual(p.targets.map((t) => t.id), [...SALES_PAGES, STATUS_URL].map(targetId));
  assert.deepEqual(p.controls.map((c) => [c.id, c.deps]), CONTROL_URLS.map((c) => [targetId(c.url), c.deps]));
  assert.equal(p.controls.find((c) => c.id === "edge.zevanory.api.br/api/status").ok, false);
  assert.deepEqual(p.served, { central: sha, sales: salesSha });
  assert.ok(p.targets.every((t) => Array.isArray(t.tries) && t.tries.length >= 1));
  assert.ok(calls.every((u) => !/comprar|checkout|pagamento/.test(u)));
  assert.throws(() => validateProbe({ ...p, served: { central: "nao-e-sha" } }), /bad_probe_served/);
  assert.throws(() => validateProbe({ ...p, controls: [{ id: 1 }] }), /bad_probe_control/);
});

async function withServer(handler, fn) {
  const sockets = new Set();
  const srv = http.createServer(handler);
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); }
  finally { for (const s of sockets) s.destroy(); await new Promise((r) => srv.close(r)); }
}

test("P19.9 servidor REAL envia 200 e suspende o corpo: a falha de leitura fica em body_error; status, tentativas e regra de nova tentativa iguais", async () => {
  await withServer((req, res) => { res.writeHead(200, { "content-type": "application/json", "content-length": "100" }); res.write('{"partial":'); /* corpo nunca termina */ }, async (base) => {
    const r = await probeUrl(base + "/api/status", { pause: async () => {}, timeoutMs: 300 });
    assert.equal(r.status, 200, "status HTTP histórico preservado");
    assert.equal(r.attempts, 1, "200 não gera nova tentativa (regra histórica)");
    assert.equal(r.body, "", "corpo histórico: vazio");
    assert.match(r.body_error, /^(TimeoutError|AbortError)$/);
    assert.equal(r.tries.length, 1);
    assert.equal(r.tries[0].status, 200);
    assert.equal(r.tries[0].body_error, r.body_error);
    assert.ok(r.tries[0].ms >= 250, "a duração inclui a espera pelo corpo");
  });
});

test("P19.10 200 com corpo VAZIO lido com sucesso não é classificado como falha", async () => {
  await withServer((req, res) => { res.writeHead(200, { "content-length": "0" }); res.end(); }, async (base) => {
    const r = await probeUrl(base + "/", { pause: async () => {}, timeoutMs: 2000 });
    assert.equal(r.status, 200);
    assert.equal(r.body, "");
    assert.equal(r.body_error, undefined);
    assert.equal(r.tries[0].body_error, undefined);
  });
});

test("P19.11 runProbe leva body_error ao alvo e às tentativas sem mudar up das páginas (regra histórica)", async () => {
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/ia-na-pratica") {
      const stream = new ReadableStream({ start(c) { c.error(Object.assign(new Error("x"), { name: "AbortError" })); } });
      return new Response(stream, { status: 200 });
    }
    if (u.pathname === "/api/status") return new Response("{}");
    return new Response("<html>ok</html>");
  };
  const p = await runProbe({ fetchImpl, pause: async () => {}, now: () => Date.parse("2026-11-18T18:00:00Z") });
  const t = p.targets.find((x) => x.id === "vendas.zevanory.api.br/ia-na-pratica");
  assert.equal(t.status, 200); assert.equal(t.ok, true, "página 200 continua ok (regra histórica da fase 1)");
  assert.equal(t.body_error, "AbortError"); assert.equal(t.tries[0].body_error, "AbortError");
  assert.equal(p.up, true);
});

test("P19.12 correlação DEFINITIVA sem resposta: o rid enviado pelo cliente (smoke) marca a entrada das etapas", () => {
  const rid = "0a1b2c3d4e5f";
  const hang = statusProbe("hang", rid);
  assert.equal(hang.outcome, "no_response");
  assert.deepEqual(hang.logs.map((l) => [l.rid, l.stage, l.phase]), [[rid, "operational_read", "start"], [rid, "pg_read", "start"]],
    "a requisição travada é identificada pelo rid que o smoke registrou antes de chamar, não pelo horário");
  const ok = statusProbe("ok", rid);
  assert.equal(ok.diag_header, rid, "com resposta, o Worker devolve o mesmo rid");
  assert.ok(ok.logs.every((l) => l.rid === rid));
  const bad = statusProbe("ok", "nao-hex-123");
  assert.match(bad.diag_header, /^[0-9a-f]{12}$/); assert.notEqual(bad.diag_header, "nao-hex-123", "rid inválido do cliente é trocado por aleatório");
});
