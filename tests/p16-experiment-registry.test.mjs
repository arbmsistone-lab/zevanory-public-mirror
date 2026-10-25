// P16 Experimentos: contrato do gate scripts/p16/experiment_registry_gate.py (registro prévio, cálculo amostral,
// regra de parada, tabela de decisão de inconclusivos [3.1], fechamento obrigatório) e do avaliador que respeita o
// fechamento (scripts/audit/experiments.mjs). Sem rede e sem segredo: cada caso monta uma raiz temporária mínima e
// roda o gate real com python3 -I. Marcadores [Tn.k] identificam a asserção para o classificador de mutantes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { evaluateExperiments } from "../scripts/audit/experiments.mjs";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";

requireTool("python3");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPO, "scripts/p16/experiment_registry_gate.py");
const TODAY = "2026-12-01";

function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
const seal = (rec) => { const { record_sha256, ...body } = rec; return { ...body, record_sha256: createHash("sha256").update(canon(body), "utf8").digest("hex") }; };
const clone = (x) => JSON.parse(JSON.stringify(x));

const SS = { method: "two_proportions_z", alpha: 0.05, power: 0.8, two_sided: true, mde_abs: 0.01,
  baseline: { value: 0.05, source: { kind: "repo", ref: "evidence/baseline.txt", contains: "taxa de base 5%" } }, n_per_arm: 8158 };
function pre(over = {}) {
  return { id: "X-2026-0101", registered_at: "2026-11-01", experiment_key: "cta-texto", hypothesis: "Um botão com o nome do produto gera mais intenção de compra que um botão genérico.",
    metric: { name: "Intenção de compra por visita", definition: "eventos de intenção ÷ visitas filtradas, por braço" }, design: "ab_proportions", arms: ["controle", "variante"],
    sample_size: clone(SS), min_n_per_arm: 8158,
    stop_rule: { min_duration_days: 7, max_duration_days: 28, early_stop: "NENHUMA" }, analysis: { test: "duas proporções, z bilateral", alpha: 0.05 },
    decision_table: { VARIANTE_MELHOR: "REFORCAR", SEM_DIFERENCA: "MANTER", VARIANTE_PIOR: "APOSENTAR", AMOSTRA_INSUFICIENTE: "INCONCLUSIVO" },
    recorded_by: "teste", ...over };
}
const start = (over = {}) => ({ id: "S-2026-0101", prereg: "X-2026-0101", started_at: "2026-11-03",
  evidence: { kind: "repo", ref: "data/experiments.json", contains: '"id": "cta-texto"' }, recorded_by: "teste", ...over });
const closure = (over = {}) => ({ id: "C-2026-0101", prereg: "X-2026-0101", closed_at: "2026-11-20", result: "VARIANTE_MELHOR",
  observed: { status: "MEASURED", n_per_arm: { controle: 9000, variante: 9100 }, p_value: 0.01, source: { kind: "repo", ref: "evidence/result.txt", contains: "resultado medido" } },
  outcome: "REFORCAR", outcome_reason: "Variante melhor com amostra completa e p abaixo do alfa pré-registrado.", action: "Aplicar a variante.", recorded_by: "teste", ...over });
const liveExp = (over = {}) => ({ id: "cta-texto", title: "CTA", hypothesis: "h", metric: "m", kind: "arms", arms: ["controle", "variante"], minPerArm: 8158, startedAt: "2026-11-03", decision: "d", ...over });

function run({ pres = [pre()], starts = [start()], closures = [], live = [liveExp()], p02 = null, base = null, today = TODAY, sealAll = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "p16-"));
  try {
    mkdirSync(join(root, "data/p16"), { recursive: true });
    mkdirSync(join(root, "evidence"), { recursive: true });
    writeFileSync(join(root, "evidence/baseline.txt"), "taxa de base 5% (fixture)\n");
    writeFileSync(join(root, "evidence/result.txt"), "resultado medido (fixture)\n");
    const s = sealAll ? seal : (x) => x;
    const reg = { schema: "zevanory-p16-experiments/v1", schema_version: 1, preregistrations: pres.map(s), starts: starts.map(s), closures: closures.map(s) };
    writeFileSync(join(root, "data/p16/experiments.json"), JSON.stringify(reg, null, 2));
    writeFileSync(join(root, "data/experiments.json"), JSON.stringify({ schema: "zevanory-experiments/v1", experiments: live }, null, 2));
    if (p02) { mkdirSync(join(root, "data/p02"), { recursive: true }); writeFileSync(join(root, "data/p02/decisions.json"), JSON.stringify(p02)); }
    const args = ["-I", GATE, "--root", root, "--today", today];
    if (base) { writeFileSync(join(root, "base.json"), JSON.stringify(base)); args.push("--base", join(root, "base.json")); }
    const r = spawnSync("python3", args, { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), reg };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const fails = (r, re, label) => { assert.equal(r.code, 1, `${label} esperado FAIL:\n${r.out}`); assert.match(r.out, re, `${label} motivo:\n${r.out}`); };
const passes = (r, label) => { assert.equal(r.code, 0, `${label} esperado PASS:\n${r.out}`); assert.match(r.out, /P16_GATE=PASS/, label); };

test("T1 registro real do repositório passa (3 legados fechados INCONCLUSIVO)", () => {
  const r = spawnSync("python3", ["-I", GATE, "--root", REPO, "--today", "2026-10-25"], { encoding: "utf8" });
  assert.equal(r.status, 0, "[T1.1] " + r.stdout + r.stderr);
  assert.match(r.stdout, /P16_EXPERIMENTS preregistered=3 legacy=3 started=3 open=0 closed=3 inconclusivo=3/, "[T1.2]");
});
test("T2 A/B novo com cálculo amostral, início depois do registro e registro vivo coerente passa", () => passes(run(), "[T2.1]"));
test("T3 experimento no registro vivo sem pré-registro reprova", () => fails(run({ pres: [], starts: [] }), /sem pré-registro em data\/p16/, "[T3.1]"));
test("T4 A/B sem cálculo amostral reprova", () => { const p = pre(); delete p.sample_size; fails(run({ pres: [p] }), /A\/B sem cálculo amostral/, "[T4.1]"); });
test("T5 n declarado diferente do recalculado reprova", () => fails(run({ pres: [pre({ sample_size: { ...clone(SS), n_per_arm: 5000 }, min_n_per_arm: 5000 })], live: [liveExp({ minPerArm: 5000 })] }), /difere do recalculado \(8158\)/, "[T5.1]"));
test("T6 mínimo por braço abaixo do n calculado reprova", () => fails(run({ pres: [pre({ min_n_per_arm: 100 })], live: [liveExp({ minPerArm: 100 })] }), /min_n_per_arm deve ser inteiro >= n_per_arm/, "[T6.1]"));
test("T7 início antes do registro prévio reprova", () => fails(run({ starts: [start({ started_at: "2026-10-30" })], live: [liveExp({ startedAt: "2026-10-30" })] }), /antes do registro prévio/, "[T7.1]"));
test("T8 mínimo do registro vivo abaixo do pré-registrado reprova", () => fails(run({ live: [liveExp({ minPerArm: 7 })] }), /minPerArm=7 abaixo do mínimo pré-registrado/, "[T8.1]"));
test("T9 experimento aberto depois do prazo máximo reprova", () => fails(run({ today: "2026-12-15" }), /passou do prazo máximo \(28 dias/, "[T9.1]"));
test("T10 fechamento que contradiz a tabela de decisão reprova", () => fails(run({ closures: [closure({ outcome: "MANTER" })], live: [liveExp({ closed: { at: "2026-11-20", outcome: "MANTER", ref: "data/p16/experiments.json#C-2026-0101" } })] }), /contradiz a tabela de decisão/, "[T10.1]"));
test("T11 decisão com n abaixo do mínimo reprova", () => {
  const c = closure(); c.observed.n_per_arm = { controle: 9000, variante: 100 };
  fails(run({ closures: [c], live: [liveExp({ closed: { at: "2026-11-20", outcome: "REFORCAR", ref: "data/p16/experiments.json#C-2026-0101" } })] }), /result deve ser AMOSTRA_INSUFICIENTE/, "[T11.1]");
});
test("T12 diferença declarada sem p < alfa reprova", () => {
  const c = closure(); c.observed.p_value = 0.2;
  fails(run({ closures: [c], live: [liveExp({ closed: { at: "2026-11-20", outcome: "REFORCAR", ref: "data/p16/experiments.json#C-2026-0101" } })] }), /exige p < alfa/, "[T12.1]");
});
test("T13 decisão antes da janela mínima reprova", () => fails(run({ closures: [closure({ closed_at: "2026-11-06" })], live: [liveExp({ closed: { at: "2026-11-06", outcome: "REFORCAR", ref: "data/p16/experiments.json#C-2026-0101" } })] }), /antes da janela mínima/, "[T13.1]"));
test("T14 fechamento sem decisão reprova", () => { const c = closure(); delete c.outcome; fails(run({ closures: [c], live: [liveExp({ closed: { at: "2026-11-20", ref: "data/p16/experiments.json#C-2026-0101" } })] }), /fechamento sem decisão/, "[T14.1]"); });
test("T15 tabela que decide com amostra insuficiente reprova [3.1]", () => fails(run({ pres: [pre({ decision_table: { VARIANTE_MELHOR: "REFORCAR", SEM_DIFERENCA: "MANTER", VARIANTE_PIOR: "APOSENTAR", AMOSTRA_INSUFICIENTE: "MANTER" } })] }), /AMOSTRA_INSUFICIENTE só pode ser INCONCLUSIVO/, "[T15.1]"));
test("T16 legado fora da lista fechada reprova", () => { const p = pre({ legacy: true }); delete p.sample_size; fails(run({ pres: [p] }), /lista fechada/, "[T16.1]"); });
test("T17 legado fechado com decisão reprova", () => {
  const p = { id: "X-2026-0101", registered_at: "2026-10-25", experiment_key: "short-format", legacy: true, hypothesis: "Shorts com dica prática atraem mais visualizações.", metric: { name: "visualizações", definition: "por vídeo com 3+ dias" }, sample_size: null, recorded_by: "teste" };
  const c = closure({ result: "SEM_PRE_REGISTRO_VALIDO", outcome: "MANTER", observed: { status: "NOT_AVAILABLE", reason: "não lido nesta revisão" } });
  fails(run({ pres: [p], starts: [start({ started_at: "2026-10-12", evidence: { kind: "repo", ref: "data/experiments.json", contains: '"id": "short-format"' } })], closures: [c], live: [liveExp({ id: "short-format", startedAt: "2026-10-12", closed: { at: "2026-11-20", outcome: "MANTER", ref: "data/p16/experiments.json#C-2026-0101" } })] }), /legado \(sem cálculo amostral\) só fecha como SEM_PRE_REGISTRO_VALIDO -> INCONCLUSIVO/, "[T17.1]");
});
test("T18 fechado que segue aberto no registro vivo reprova", () => fails(run({ closures: [closure()] }), /registro vivo não traz closed/, "[T18.1]"));
test("T19 registro só cresce: alterado ou removido em relação à base reprova", () => {
  const base = run().reg;
  fails(run({ pres: [pre({ hypothesis: "Outra hipótese com tamanho suficiente para passar." })], base }), /append-only: preregistrations X-2026-0101 da base foi alterado/, "[T19.1]");
  fails(run({ starts: [], base }), /append-only: starts S-2026-0101 da base foi removido/, "[T19.2]");
});
test("T20 record_sha256 adulterado reprova", () => {
  const p = seal(pre()); p.min_n_per_arm = 9000;
  fails(run({ pres: [p], starts: [seal(start())], sealAll: false, live: [liveExp({ minPerArm: 9000 })] }), /record_sha256 não confere/, "[T20.1]");
});
test("T21 ligação ao P02: decisão inexistente ou divergente reprova; coerente passa", () => {
  const live = [liveExp({ closed: { at: "2026-11-20", outcome: "INCONCLUSIVO", ref: "data/p16/experiments.json#C-2026-0101" } })];
  const c = closure({ result: "AMOSTRA_INSUFICIENTE", outcome: "INCONCLUSIVO", observed: { status: "NOT_AVAILABLE", reason: "agregado não lido nesta revisão" }, p02_decision: "D-2026-0001" });
  fails(run({ closures: [c], live, p02: { decisions: [{ id: "D-2026-0009", outcome: "INCONCLUSIVO" }] } }), /p02_decision D-2026-0001 não existe/, "[T21.1]");
  fails(run({ closures: [c], live, p02: { decisions: [{ id: "D-2026-0001", outcome: "MANTER" }] } }), /diverge da decisão D-2026-0001 do P02/, "[T21.2]");
  passes(run({ closures: [c], live, p02: { decisions: [{ id: "D-2026-0001", outcome: "INCONCLUSIVO" }] } }), "[T21.3]");
});
test("T22 cálculo amostral recalculado bate com valores de referência", () => {
  const n = (ss) => spawnSync("python3", ["-I", GATE, "--sample-size", JSON.stringify(ss)], { encoding: "utf8" }).stdout.trim();
  assert.equal(n({ method: "two_proportions_z", alpha: 0.05, power: 0.8, two_sided: true, mde_abs: 0.01, baseline: { value: 0.05 } }), "8158", "[T22.1]");
  assert.equal(n({ method: "two_means_z", alpha: 0.05, power: 0.8, two_sided: true, mde_abs: 0.5, sd: 1 }), "63", "[T22.2]");
});
test("T23 métrica por abertura de e-mail reprova (abertura não decide)", () => fails(run({ pres: [pre({ metric: { name: "Taxa de abertura", definition: "aberturas ÷ envios" } })] }), /abertura de e-mail não decide/, "[T23.1]"));
test("T24 avaliador não reavalia experimento fechado", () => {
  const reg = JSON.parse(readTextNormalized(join(REPO, "data/experiments.json")));
  const now = Date.parse("2026-11-20T12:00:00Z");
  const vids = [];
  for (let i = 0; i < 8; i++) for (const [s, v] of [["dica", 400 + i * 30], ["oferta", 20 + i], ["calc", 100 + i * 5]]) vids.push({ slot: s, views: v, publishedAt: new Date(now - (5 + i) * 864e5).toISOString() });
  const out = evaluateExperiments(reg, { videos: vids }, now);
  for (const e of out) { assert.equal(e.status, "closed", "[T24.1] " + e.id); assert.equal(e.outcome, "INCONCLUSIVO", "[T24.2] " + e.id); assert.equal(e.winner, undefined, "[T24.3] " + e.id); }
});
test("T25 fechamento válido (n completo, p < alfa, depois da janela) passa", () => passes(run({ closures: [closure()], live: [liveExp({ closed: { at: "2026-11-20", outcome: "REFORCAR", ref: "data/p16/experiments.json#C-2026-0101" } })] }), "[T25.1]"));
