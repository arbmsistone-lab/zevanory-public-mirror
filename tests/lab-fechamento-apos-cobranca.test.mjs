import test from "node:test";
import assert from "node:assert/strict";
import { mercadoPagoExpiryWindow } from "../worker/payment-link-expiry.mjs";
import { invalidatePendingMercadoPagoCheckouts, closedExpiryPatch, preferenceIsClosed } from "../worker/close-invalidation.mjs";
import { applySalesSwitch, readSalesSwitch, resetSalesSwitchCache } from "../worker/sales-control.mjs";

// LABORATÓRIO (Ordens 016-A/016-B): cobrança SIMULADA -> fechar interruptor -> o link ainda paga?
// Provedor simulado com as regras documentadas:
//  - preferência com expires=true só inicia pagamento entre expiration_date_from e expiration_date_to;
//  - Pix/boleto GERADO vira pagamento próprio, com vencimento fixado na geração (date_of_expiration),
//    e NÃO é cancelado pela mudança de vigência da preferência.
function provedorSimulado({ ignorarPut = false } = {}) {
  const prefs = new Map(), pix = new Map(); let seq = 0;
  const abre = (p, at) => !(p.expires === true && !(Date.parse(p.expiration_date_from) <= at && at <= Date.parse(p.expiration_date_to)));
  return {
    prefs,
    criar(payload) { const id = `pref-lab-${++seq}`; prefs.set(id, { ...payload }); return id; },
    pagarCartao(id, at) { const p = prefs.get(id); if (!p) return "not_found"; return abre(p, at) ? "approved" : "expired"; },
    gerarPix(id, at) {
      const p = prefs.get(id); if (!p || !abre(p, at)) return null;
      const venc = p.date_of_expiration ? Date.parse(p.date_of_expiration) : Infinity;
      const pid = `pix-${++seq}`; pix.set(pid, venc); return pid;
    },
    pagarPix(pid, at) { return pix.has(pid) && at <= pix.get(pid) ? "approved" : "expired"; },
    fetch: async (url, init = {}) => {
      const id = decodeURIComponent(String(url).split("/").pop());
      if (!prefs.has(id)) return { ok: false, status: 404 };
      if (init.method === "PUT") { if (!ignorarPut) Object.assign(prefs.get(id), JSON.parse(init.body)); return { ok: true, status: 200 }; }
      return { ok: true, status: 200, json: async () => ({ id, ...prefs.get(id) }) };
    }
  };
}
// Banco simulado que respeita o cursor keyset (updated_at, order_id) e o limite.
function bancoComFila(ordens) {
  const fila = [...ordens].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.order_id.localeCompare(b.order_id));
  return { consultas: 0, query: async function (_q, [at, id, lim]) {
    this.consultas++;
    return fila.filter((o) => o.updated_at > at || (o.updated_at === at && o.order_id > id)).slice(0, lim)
      .map((o) => ({ ...o, cursor_at: o.updated_at }));
  } };
}
const T0 = Date.parse("2026-10-20T16:00:00.000Z"), HORA = 3600 * 1000;
const ordem = (i, pref) => ({ order_id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, provider_checkout_id: pref, updated_at: new Date(T0 - (1000 - i) * 1000).toISOString() });

test("LAB 1: fechar o interruptor NÃO invalida link já emitido (risco residual comprovado)", () => {
  const mp = provedorSimulado();
  const id = mp.criar({ ...mercadoPagoExpiryWindow(T0) });
  assert.equal(applySalesSwitch({ enabled: false }), false);
  assert.equal(mp.pagarCartao(id, T0 + HORA), "approved");
  assert.equal(mp.pagarCartao(id, T0 + 25 * HORA), "expired");
});

test("LAB 2: link legado sem expiração segue pagável indefinidamente", () => {
  const mp = provedorSimulado(); const id = mp.criar({});
  assert.equal(mp.pagarCartao(id, T0 + 365 * 24 * HORA), "approved");
});

test("LAB 3: invalidação + confirmação no provedor torna novos e legados impagáveis na hora", async () => {
  const mp = provedorSimulado();
  const novo = mp.criar({ ...mercadoPagoExpiryWindow(T0) }), legado = mp.criar({});
  applySalesSwitch({ enabled: false });
  const out = await invalidatePendingMercadoPagoCheckouts(bancoComFila([ordem(1, novo), ordem(2, legado)]),
    { accessToken: "lab-token-simulado", fetchImpl: mp.fetch, now: T0 + HORA, dryRun: false });
  assert.deepEqual([out.ok, out.checked, out.invalidated, out.failed.length, out.exhausted], [true, 2, 2, 0, true]);
  assert.equal(mp.pagarCartao(novo, T0 + HORA + 1000), "expired");
  assert.equal(mp.pagarCartao(legado, T0 + HORA + 1000), "expired");
  assert.equal(mp.gerarPix(novo, T0 + HORA + 1000), null, "Pix novo não pode mais ser gerado");
});

test("LAB 4: provedor responde 2xx mas não aplica — leitura posterior detecta e NÃO declara invalidado", async () => {
  const mp = provedorSimulado({ ignorarPut: true }); const id = mp.criar({});
  const out = await invalidatePendingMercadoPagoCheckouts(bancoComFila([ordem(1, id)]), { accessToken: "x", fetchImpl: mp.fetch, now: T0, dryRun: false });
  assert.equal(out.ok, false); assert.equal(out.invalidated, 0); assert.equal(out.failed[0].reason, "provider_not_closed");
});

test("LAB 5: fila maior que a página é esgotada por cursor (230 pendentes, página 50)", async () => {
  const mp = provedorSimulado(); const db = bancoComFila(Array.from({ length: 230 }, (_, i) => ordem(i + 1, mp.criar({}))));
  const out = await invalidatePendingMercadoPagoCheckouts(db, { accessToken: "x", fetchImpl: mp.fetch, now: T0, dryRun: false, pageSize: 50 });
  assert.deepEqual([out.ok, out.checked, out.invalidated, out.exhausted, out.pages], [true, 230, 230, true, 6]);
  assert.ok([...mp.prefs.values()].every((p) => preferenceIsClosed(p, T0)));
});

test("LAB 6: teto atingido sem esgotar a fila => ok=false, exhausted=false (nunca declara fechamento completo)", async () => {
  const mp = provedorSimulado(); const db = bancoComFila(Array.from({ length: 30 }, (_, i) => ordem(i + 1, mp.criar({}))));
  const out = await invalidatePendingMercadoPagoCheckouts(db, { accessToken: "x", fetchImpl: mp.fetch, now: T0, dryRun: false, pageSize: 10, maxTotal: 20 });
  assert.equal(out.ok, false); assert.equal(out.exhausted, false); assert.equal(out.checked, 20);
});

test("LAB 7 (corrida): Pix GERADO antes do fechamento continua pagável até o próprio vencimento (≤ 24 h) e é HONRADO", async () => {
  const mp = provedorSimulado(); const id = mp.criar({ ...mercadoPagoExpiryWindow(T0) });
  const pix = mp.gerarPix(id, T0 + 10 * 60 * 1000);                 // cliente gera Pix 10 min após a criação
  await invalidatePendingMercadoPagoCheckouts(bancoComFila([ordem(1, id)]), { accessToken: "x", fetchImpl: mp.fetch, now: T0 + HORA, dryRun: false });
  assert.equal(mp.pagarCartao(id, T0 + HORA + 1), "expired", "preferência fechada");
  assert.equal(mp.pagarPix(pix, T0 + 2 * HORA), "approved", "Pix já gerado: risco residual delimitado, honrado pela política do proprietário");
  assert.equal(mp.pagarPix(pix, T0 + 24 * HORA + 1), "expired", "limite máximo = date_of_expiration da criação (24 h)");
});

test("LAB 8 (corrida): Pix legado gerado sem date_of_expiration NÃO é limitado — risco residual explícito", () => {
  const mp = provedorSimulado(); const id = mp.criar({}); const pix = mp.gerarPix(id, T0);
  assert.equal(mp.pagarPix(pix, T0 + 30 * 24 * HORA), "approved");
});

test("LAB 9: padrão é simulação (dryRun) — nenhuma chamada ao provedor; sem token não chama", async () => {
  let chamadas = 0; const f = async () => { chamadas++; return { ok: true, status: 200 }; };
  const out = await invalidatePendingMercadoPagoCheckouts(bancoComFila([ordem(1, "pref-1")]), { accessToken: "x", fetchImpl: f });
  assert.equal(out.dry_run, true); assert.equal(chamadas, 0); assert.equal(out.pending.length, 1);
  const sem = await invalidatePendingMercadoPagoCheckouts(bancoComFila([ordem(1, "pref-1")]), { accessToken: "", fetchImpl: f, dryRun: false });
  assert.equal(sem.reason, "provider_token_unavailable"); assert.equal(chamadas, 0);
});

test("patch de fechamento: vigência e vencimento de meios offline encerrados no instante do fechamento", () => {
  const p = closedExpiryPatch(T0);
  assert.equal(preferenceIsClosed(p, T0), true);
  assert.ok(Date.parse(p.date_of_expiration) < T0);
});

// SLA: parte controlada pelo código = cache do isolate (10 s). A propagação global do KV é do provedor
// ("até 60 s ou mais", documentação Cloudflare) e NÃO é provada aqui.
test("SLA (parte do código): fechamento no KV é visto em ≤ 10 s; erro de leitura = fechado", async () => {
  resetSalesSwitchCache();
  const now0 = Date.now();
  let valor = JSON.stringify({ enabled: true, authorization: "LIBERAR VENDAS", by: "lab-owner", at: new Date(now0 - 1000).toISOString(), ref: "lab-ref-001" });
  const kv = { get: async (k) => k === "sales:open:v1" ? valor : JSON.stringify({ ok: true, at: new Date(now0).toISOString() }) };
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, now0)).enabled, true);
  valor = JSON.stringify({ enabled: false });
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, now0 + 9_999)).enabled, true);
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, now0 + 10_000)).enabled, false);
  resetSalesSwitchCache();
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => { throw new Error("kv_down"); } } }, now0 + 20_000)).enabled, false);
  resetSalesSwitchCache();
});
