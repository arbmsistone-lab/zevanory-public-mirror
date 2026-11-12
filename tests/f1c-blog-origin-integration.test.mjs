// Integração #1020 × #1021 (NC-F1B-INT-01): com o blog publicando de verdade (#1020), a origem da publicação do
// blog pertence ao recibo: criado nesta execução = esta origem; reencontrado depois = origem da 1ª publicação
// (estado do dia, mesma URL); sem prova = desconhecida (null), nunca a do tick que o reencontrou.
import test from "node:test";
import assert from "node:assert/strict";
import { runAcquisitionEngine } from "../worker/acquisition-engine.mjs";
const AT = new Date("2026-10-12T12:35:00Z"), DAYKEY = "zpc:acquisition:daily:2026-10-12";
const world = () => { const data = new Map(); return { data, kv: { get: async (k) => (data.has(k) ? data.get(k) : null), put: async (k, v) => { data.set(k, String(v)); }, list: async () => ({ keys: [] }), delete: async (k) => { data.delete(k); } } }; };
const ok = async () => ({ ok: true, status: 200, json: async () => ({}) });
const blogOf = (r) => r.outcomes.find((o) => o.channel === "blog");

test("blog criado pelo cron = cron; reencontrado por execução manual mantém cron", async () => {
  const w = world();
  const first = await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: w.kv }, AT, ok, { trigger: "cron" });
  assert.equal(blogOf(first).status, "publicado"); assert.equal(blogOf(first).trigger, "cron");
  const again = await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: w.kv }, new Date(AT.getTime() + 600000), ok);
  assert.equal(again.trigger, "manual"); assert.equal(blogOf(again).trigger, "cron", "origem é do recibo, não do tick");
  assert.equal(JSON.parse(w.data.get(DAYKEY)).outcomes.find((o) => o.channel === "blog").trigger, "cron");
});

test("blog criado manualmente nunca vira cron, nem se o cron o reencontrar", async () => {
  const w = world();
  await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: w.kv }, AT, ok);
  const cron = await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: w.kv }, new Date(AT.getTime() + 600000), ok, { trigger: "cron" });
  assert.equal(blogOf(cron).trigger, "manual");
});

test("estado do dia perdido: blog reencontrado fica com origem desconhecida (null), fora do numerador", async () => {
  const w = world();
  await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: w.kv }, AT, ok, { trigger: "cron" });
  w.data.delete(DAYKEY);
  const cron = await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: w.kv }, new Date(AT.getTime() + 600000), ok, { trigger: "cron" });
  assert.equal(blogOf(cron).status, "publicado"); assert.equal(blogOf(cron).trigger, null);
});

test("estado do dia ilegível: resumo do proprietário bloqueia (digest_source_unreadable), sem e-mail", async () => {
  const w = world(); let posts = 0;
  w.data.set(DAYKEY, "{ilegível");
  const r = await runAcquisitionEngine({ ZEVANORY_PRIVATE_ARTIFACTS: w.kv, RESEND_API_KEY: "re_test", OWNER_ALERT_EMAIL: "dono@example.test" }, new Date("2026-10-12T23:30:00Z"), async (u) => { if (String(u).includes("resend")) posts++; return ok(); });
  assert.equal(r.ownerDigest.code, "digest_source_unreadable"); assert.equal(posts, 0);
});
