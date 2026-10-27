// M-B (reauditoria do PR #946, rodada 3): a lista de espera usa o MESMO estado canônico de vendas de /api/sales/status
// (interruptor do proprietário autorizado E prova financeira verificada E ABSOLUTE_RELEASE_APPROVED E
// PRE_SALE_GATES_APPROVED E Mercado Pago em produção E processo fiscal definido), na rota e no job agendado. Com o
// interruptor LIGADO e as travas DESLIGADAS: nenhum aviso sai, a lista não é apagada e a página não diz "vendas abertas".
// Rótulos [CSn.k].
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { canonicalSalesOpen, canonicalSalesState, resetSalesSwitchCache, handleSalesControl } from "../worker/sales-control.mjs";
import { runWaitlistNotify, handleWaitlist, WAITLIST_PRODUCTS } from "../worker/waitlist.mjs";
import { db, provider, waitlistEnv } from "./helpers/waitlist-model.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.now();
// Interruptor do proprietário LIGADO, autorizado ("LIBERAR VENDAS") e preflight verde e recente.
const switchOnKv = (extra = new Map()) => ({
  async get(k) {
    if (k === "sales:open:v1") return JSON.stringify({ enabled: true, at: new Date(NOW - 60e3).toISOString(), by: "proprietario", authorization: "LIBERAR VENDAS", ref: "owner-decision#cs-test" });
    if (k === "zpc-sales-preflight:v1") return JSON.stringify({ ok: true, at: new Date(NOW - 60e3).toISOString() });
    return extra.get(k) ?? null;
  },
  async put(k, v) { extra.set(k, v); }, async delete(k) { extra.delete(k); },
});
const LOCKS_ON = { ABSOLUTE_RELEASE_APPROVED: "true", PRE_SALE_GATES_APPROVED: "true", MERCADOPAGO_ENV: "production" };

test("CS1 interruptor ligado e travas desligadas: estado canônico fechado (cada trava sozinha fecha)", async () => {
  for (const [label, env] of [
    ["todas as travas desligadas", {}],
    ["sem ABSOLUTE_RELEASE_APPROVED", { ...LOCKS_ON, ABSOLUTE_RELEASE_APPROVED: "false" }],
    ["sem PRE_SALE_GATES_APPROVED", { ...LOCKS_ON, PRE_SALE_GATES_APPROVED: "false" }],
    ["Mercado Pago em sandbox", { ...LOCKS_ON, MERCADOPAGO_ENV: "sandbox" }],
    ["todas as liberações, sem prova financeira nem processo fiscal", LOCKS_ON],
  ]) {
    resetSalesSwitchCache();
    const e = { ...env, ZEVANORY_PRIVATE_ARTIFACTS: switchOnKv() };
    const st = await canonicalSalesState(e);
    assert.deepEqual([st.sw.enabled, st.sw.authorized], [true, true], `[CS1.0] o interruptor está de fato LIGADO e autorizado: ${label}`);
    assert.equal(st.open, false, `[CS1.1] ${label}`);
    assert.equal(await canonicalSalesOpen(e), false, `[CS1.2] ${label}`);
    resetSalesSwitchCache();
    const pub = await (await handleSalesControl(new Request("https://zevanory.api.br/api/sales/status"), e)).json();
    assert.equal(pub.open, st.open, `[CS1.3] mesma resposta de /api/sales/status: ${label}`);
  }
  resetSalesSwitchCache();
  assert.equal(await canonicalSalesOpen({ ...LOCKS_ON, ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => { throw new Error("kv_down"); } } }), false, "[CS1.4] KV em falha: fechado");
  resetSalesSwitchCache();
});

test("CS2 job agendado com o interruptor ligado e travas desligadas: nenhum aviso, lista intacta", async () => {
  resetSalesSwitchCache();
  const e = { ...waitlistEnv(), ZEVANORY_PRIVATE_ARTIFACTS: switchOnKv() };
  const salesOpen = await canonicalSalesOpen(e);
  const d = db(), pv = provider();
  const P = Object.keys(WAITLIST_PRODUCTS).sort();
  d.add("a@ex.com", P[0]); d.add("b@ex.com", P[1]);
  const out = await runWaitlistNotify(e, { sqlFactory: d.sqlFactory, salesOpen, fetchImpl: pv.fetchImpl });
  assert.equal(salesOpen, false, "[CS2.1]");
  assert.equal(out.sent, 0, "[CS2.2] nenhum aviso");
  assert.equal(pv.calls.length, 0, "[CS2.3] nenhuma chamada ao provedor");
  assert.equal(d.rows.length, 2, "[CS2.4] a lista não é apagada");
  assert.equal(d.notices.length, 0, "[CS2.5] nenhum aviso congelado");
  resetSalesSwitchCache();
});

test("CS3 rota com o interruptor ligado e travas desligadas: formulário de espera, nunca 'vendas abertas'", async () => {
  resetSalesSwitchCache();
  const e = { ...waitlistEnv(), ZEVANORY_PRIVATE_ARTIFACTS: switchOnKv() };
  const P = Object.keys(WAITLIST_PRODUCTS).sort();
  const page = await (await handleWaitlist(new Request(`https://zevanory.api.br/lista-de-espera?produto=${P[0]}`), e, { sqlFactory: db().sqlFactory, fetchImpl: provider().fetchImpl, salesOpen: await canonicalSalesOpen(e) })).text();
  assert.match(page, /Avise-me quando as vendas/, "[CS3.1] formulário de espera");
  assert.doesNotMatch(page, /As vendas estão abertas/, "[CS3.2]");
  resetSalesSwitchCache();
});

test("CS4 o Worker central passa o estado canônico à rota e ao job da lista de espera (nunca só o interruptor)", () => {
  const src = readTextNormalized(join(ROOT, "worker/cloudflare-worker.compat.mjs"));
  assert.match(src, /handleWaitlist\(request, normalized, \{ sqlFactory: whatsappProofDatabase, salesOpen: await canonicalSalesOpen\(normalized\) \}\)/, "[CS4.1] rota");
  assert.match(src, /const waitlistSalesOpen = await canonicalSalesOpen\(normalized\);\n\s+tasks\.push\(runWaitlistNotify\(normalized, \{ sqlFactory: whatsappProofDatabase, salesOpen: waitlistSalesOpen \}\)/, "[CS4.2] job");
  assert.doesNotMatch(src, /runWaitlistNotify\([^)]*salesOpen(?:Now)?\s*\}/, "[CS4.3] nenhum caminho com o interruptor puro");
  assert.doesNotMatch(src, /handleWaitlist\([^)]*salesOpenNow/, "[CS4.4]");
});
