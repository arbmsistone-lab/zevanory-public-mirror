// NC-G6-1021-01: ausência de evidência nunca vira "real 0" nem CANAL_PARADO confirmado; zero só com evidência válida.
import test from "node:test";
import assert from "node:assert/strict";
import { lerStatusDoDia, diagnosticarDia, autonomiaDoDia } from "../worker/diagnostico-diario.mjs";
import { runAcquisitionEngine } from "../worker/acquisition-engine.mjs";
const MON = "2026-10-12", ALL = { blog: { ativo: true }, bluesky: { ativo: true } };
const store = (init = {}) => { const data = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])); return { data, kv: { get: async (k) => (data.has(k) ? data.get(k) : null), put: async (k, v) => { data.set(k, String(v)); }, list: async () => ({ keys: [] }), delete: async (k) => { data.delete(k); } } }; };

test("fontes ausentes: publicadas null, SEM_EVIDENCIA, autonomia não medida", async () => {
  const st = await lerStatusDoDia(store().kv, MON);
  for (const c of ["blog", "bluesky"]) { assert.equal(st.porCanal[c].publicadas, null); assert.equal(st.porCanal[c].leitura, "ausente"); }
  const d = diagnosticarDia({ day: MON, hour: 21, ativos: ALL, status: st });
  assert.ok(d.length === 2 && d.every((x) => x.regra === "SEM_EVIDENCIA" && x.publicadas === null));
  assert.ok(!d.some((x) => x.regra === "CANAL_PARADO"));
  assert.equal(autonomiaDoDia({ day: MON, hour: 21, ativos: ALL, status: st }).valor ?? null, null);
});

test("fontes apagadas depois de uma publicação: sem evidência, não 'real 0'", async () => {
  const w = store();
  await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: w.kv }, new Date("2026-10-12T12:35:00Z"), async () => ({ ok: true, status: 200, json: async () => ({}) }), { trigger: "cron" });
  assert.equal((await lerStatusDoDia(w.kv, MON)).porCanal.blog.publicadas, 1);
  for (const k of [...w.data.keys()]) if (k.startsWith("zpc:acquisition:daily:" + MON) || k.startsWith("zpc:blog:status:v1:" + MON)) w.data.delete(k);
  const st = await lerStatusDoDia(w.kv, MON);
  assert.equal(st.porCanal.blog.publicadas, null);
  const d = diagnosticarDia({ day: MON, hour: 21, ativos: { blog: { ativo: true } }, status: st });
  assert.deepEqual(d.map((x) => [x.regra, x.publicadas]), [["SEM_EVIDENCIA", null]]);
});

test("controle positivo: zero só com prova de não publicação (erro definitivo, rejeição do gate antes de publicar, blog rejeitado)", async () => {
  const st = await lerStatusDoDia(store({
    ["zpc:acquisition:daily:" + MON]: { outcomes: [{ channel: "bluesky", status: "erro", code: "bluesky_http_400", definitive: true }] },
    ["zpc:acquisition:daily:" + MON + ":bluesky"]: { status: "erro", code: "bluesky_http_400", definitive: true, needs_reconciliation: false },
    ["zpc:blog:status:v1:" + MON]: { resultado: "rejeitado", motivos: ["duplicado"] },
  }).kv, MON);
  assert.equal(st.porCanal.bluesky.publicadas, 0); assert.equal(st.porCanal.blog.publicadas, 0);
  assert.deepEqual(diagnosticarDia({ day: MON, hour: 21, ativos: ALL, status: st }).map((x) => x.regra), ["CANAL_PARADO", "CANAL_PARADO"]);
});

test("canal pulado no estado do dia (sem outcome nem recibo) também é sem evidência", async () => {
  const st = await lerStatusDoDia(store({ ["zpc:acquisition:daily:" + MON]: { outcomes: [] } }).kv, MON);
  assert.equal(st.porCanal.bluesky.publicadas, null);
});

test("gate reprovou ANTES de publicar (sem recibo, outcome com gate.ok false) = zero comprovado", async () => {
  const st = await lerStatusDoDia(store({ ["zpc:acquisition:daily:" + MON]: { outcomes: [{ channel: "bluesky", status: "erro", code: "similaridade_alta", gate: { ok: false, reasons: ["similaridade_alta"] } }] } }).kv, MON);
  assert.equal(st.porCanal.bluesky.publicadas, 0);
  assert.equal(diagnosticarDia({ day: MON, hour: 21, ativos: { bluesky: { ativo: true } }, status: st })[0].regra, "CANAL_PARADO");
});

test("resultado incerto (pending, needs_reconciliation, erro não definitivo, status desconhecido) = null e RESULTADO_INCERTO, nunca real 0", async () => {
  const casos = [
    { status: "pending", code: "provider_unverified", needs_reconciliation: true },
    { status: "erro", code: "bluesky_http_500", definitive: false, needs_reconciliation: true },
    { status: "erro", code: "bluesky_http_500" },
    { status: "erro", code: "provider_unverified", definitive: true, needs_reconciliation: true },
    { status: "algo_novo" },
  ];
  for (const r of casos) {
    const st = await lerStatusDoDia(store({ ["zpc:acquisition:daily:" + MON]: { outcomes: [{ channel: "bluesky", ...r }] }, ["zpc:acquisition:daily:" + MON + ":bluesky"]: r }).kv, MON);
    assert.equal(st.porCanal.bluesky.publicadas, null, JSON.stringify(r)); assert.equal(st.porCanal.bluesky.leitura, "incerto", JSON.stringify(r));
    const d = diagnosticarDia({ day: MON, hour: 21, ativos: { bluesky: { ativo: true } }, status: st });
    assert.deepEqual(d.map((x) => [x.regra, x.publicadas]), [["RESULTADO_INCERTO", null]], JSON.stringify(r));
  }
});
