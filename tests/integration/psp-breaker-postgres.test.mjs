// Sol AVAL 083 (#879) — sondagem ÚNICA na meia-abertura entre isolates, coordenada pelo PostgreSQL (fortemente
// consistente), não pelo KV (eventualmente consistente). Conexões concorrentes REAIS (um processo psql por chamada).
// Run: T4_PG_HOST=... T4_PG_PORT=... node --test tests/integration/psp-breaker-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SKIP, psqlRaw, asyncSql, rowsSync } from "./psp-pg.mjs";
import { createCircuitBreaker, createPgProbeLease, runCheckoutWithFailover } from "../../worker/psp-failover.mjs";

const quiet = { error() {} };
function sharedKv() {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, String(v)); } };
}

before(() => {
  if (SKIP) return;
  psqlRaw("drop table if exists psp_circuit_probes;\n");
  psqlRaw(readFileSync(new URL("../../db/b05/psp_circuit_probes.sql", import.meta.url), "utf8"));
});

test("P1 20 aquisições simultâneas do lease (20 conexões) => exatamente 1; depois do vencimento, exatamente mais 1", { skip: SKIP }, async () => {
  psqlRaw("delete from psp_circuit_probes;\n");
  const lease = createPgProbeLease(asyncSql);
  const got = await Promise.all(Array.from({ length: 20 }, (_, i) => lease.acquire("mercadopago", `isolate-${i}`)));
  assert.equal(got.filter(Boolean).length, 1, JSON.stringify(got));
  assert.equal((await Promise.all(Array.from({ length: 5 }, (_, i) => lease.acquire("mercadopago", `late-${i}`)))).filter(Boolean).length, 0, "lease em voo: ninguém mais");
  psqlRaw("update psp_circuit_probes set lease_until = now() - interval '1 second';\n");
  const again = await Promise.all(Array.from({ length: 10 }, (_, i) => lease.acquire("mercadopago", `next-${i}`)));
  assert.equal(again.filter(Boolean).length, 1, "lease vencido: exatamente uma nova sondagem");
  assert.equal(rowsSync("select count(*)::int as n from psp_circuit_probes")[0].n, "1");
});

test("P2 dois 'isolates' com KV defasado em meia-abertura e 6 pedidos concorrentes: UMA sondagem ao MP, o resto vai ao Asaas", { skip: SKIP }, async () => {
  psqlRaw("delete from psp_circuit_probes;\n");
  let t = 1_800_000_000_000;
  const now = () => t;
  const store = sharedKv();
  const lease = createPgProbeLease(asyncSql);
  const isolates = ["a", "b"].map((owner) => createCircuitBreaker({ store, now, threshold: 1, cooldownMs: 30_000, probeLease: lease, owner: `isolate-${owner}`, logger: quiet }));
  await isolates[0].recordFailure("mercadopago", "5xx");
  t += 30_001;
  const calls = [];
  const invoke = async (p) => { calls.push(p); await new Promise((r) => setTimeout(r, 300)); return { status: 201, body: { accepted: true, checkout_url: `https://example.invalid/${p}` } }; };
  const cands = [{ provider: "mercadopago", ready: true }, { provider: "asaas", ready: true }];
  // KV defasado: o fechamento da sondagem não é visto pelos outros (recordSuccess não grava) — todos veem "meio aberto".
  const runs = Array.from({ length: 6 }, (_, i) => runCheckoutWithFailover({ lockOpen: async () => true, candidates: cands, breaker: { ...isolates[i % 2], recordSuccess: async () => ({}) }, invoke }));
  const outs = await Promise.all(runs);
  assert.equal(calls.filter((p) => p === "mercadopago").length, 1, JSON.stringify(calls));
  assert.equal(outs.filter((o) => o.body.provider === "asaas").length, 5);
  assert.ok(outs.filter((o) => o.body.provider === "asaas").every((o) => o.body.providers_called.length === 1), "nenhum pedido chama os dois");
});

test("P3 coordenador indisponível (tabela ausente) => sondagem negada, erro logado e contado; provedor segue aberto", { skip: SKIP }, async () => {
  psqlRaw("drop table if exists psp_circuit_probes;\n");
  try {
    let t = 1_800_000_000_000;
    const lines = [];
    const b = createCircuitBreaker({ store: sharedKv(), now: () => t, threshold: 1, cooldownMs: 30_000, probeLease: createPgProbeLease(asyncSql), logger: { error: (tag, j) => lines.push([tag, JSON.parse(j)]) } });
    await b.recordFailure("mercadopago", "timeout");
    t += 30_001;
    const r = await b.admit("mercadopago", { primary: true });
    assert.equal(r.admitted, false);
    assert.equal(r.reason, "probe_lease_error");
    assert.equal(b.stats().store_errors.lease, 1);
    assert.deepEqual(lines.map(([tag, j]) => [tag, j.op]), [["psp_breaker_store_error", "lease"]]);
  } finally {
    psqlRaw(readFileSync(new URL("../../db/b05/psp_circuit_probes.sql", import.meta.url), "utf8"));
  }
});
