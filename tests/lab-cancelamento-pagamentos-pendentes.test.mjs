import test from "node:test";
import assert from "node:assert/strict";
import { cancelPendingMercadoPagoPayments } from "../worker/close-invalidation.mjs";

// LABORATÓRIO Ordem 017-A, A3 casos (ii) e (iii): Pix/boleto JÁ EMITIDO e pagamento em processamento.
// Provedor simulado com a regra documentada (PUT /v1/payments/{id} status=cancelled só para pending,
// in_process, authorized; senão 400 código 2018). Pagamento aprovado é HONRADO (política do proprietário).
function mp({ aoCancelar } = {}) {
  const pays = new Map(), calls = [];
  return {
    pays, calls,
    criar(orderId, status, extra = {}) { const id = String(9000000 + pays.size + 1); pays.set(id, { id: Number(id), status, external_reference: orderId, ...extra }); return id; },
    pagar(id) { const p = pays.get(id); if (!p || p.status !== "pending") return p?.status || "not_found"; p.status = "approved"; return "approved"; },
    fetch: async (url, init = {}) => {
      const u = new URL(url); calls.push(`${init.method || "GET"} ${u.pathname}`);
      if (u.pathname === "/v1/payments/search") {
        const ref = u.searchParams.get("external_reference"); const forcarOutro = [...pays.values()].filter((p) => p.vazar);
        return { ok: true, status: 200, json: async () => ({ results: [...pays.values()].filter((p) => p.external_reference === ref).concat(forcarOutro) }) };
      }
      const id = u.pathname.split("/").pop(), p = pays.get(id);
      if (!p) return { ok: false, status: 404, json: async () => ({ cause: [{ code: 2000 }] }) };
      if (init.method === "PUT") {
        if (aoCancelar) aoCancelar(p);
        if (p.ignorarCancelamento) return { ok: true, status: 200, json: async () => ({ ...p }) };
        if (!["pending", "in_process", "authorized"].includes(p.status)) return { ok: false, status: 400, json: async () => ({ cause: [{ code: 2018 }] }) };
        p.status = "cancelled"; return { ok: true, status: 200, json: async () => ({ ...p }) };
      }
      return { ok: true, status: 200, json: async () => ({ ...p }) };
    }
  };
}
const banco = (ids) => ({ query: async (_q, [at, id, lim]) => ids.map((o, i) => ({ order_id: o, provider_checkout_id: "pref-" + i, cursor_at: `2026-10-20 10:00:00.${String(i).padStart(6, "0")}+00` }))
  .filter((r) => r.cursor_at > at || (r.cursor_at === at && r.order_id > id)).slice(0, lim) });
const O1 = "00000000-0000-4000-8000-000000000001", O2 = "00000000-0000-4000-8000-000000000002";
const run = (m, ids, extra = {}) => cancelPendingMercadoPagoPayments(banco(ids), { accessToken: "lab", fetchImpl: m.fetch, dryRun: false, ...extra });

test("C1 Pix pendente emitido antes do fechamento: cancelado no provedor e não pode mais ser pago", async () => {
  const m = mp(); const pix = m.criar(O1, "pending", { payment_method_id: "pix" });
  const out = await run(m, [O1]);
  assert.deepEqual([out.ok, out.cancelled, out.failed.length], [true, 1, 0]);
  assert.equal(m.pagar(pix), "cancelled");
});

test("C2 boleto pendente e cartão em processamento (in_process/authorized): todos cancelados", async () => {
  const m = mp(); m.criar(O1, "pending", { payment_method_id: "bolbradesco" }); m.criar(O1, "in_process"); m.criar(O2, "authorized");
  const out = await run(m, [O1, O2]);
  assert.equal(out.cancelled, 3); assert.equal(out.ok, true);
});

test("C3 pagamento APROVADO nunca é cancelado: é honrado (sem PUT)", async () => {
  const m = mp(); const ap = m.criar(O1, "approved");
  const out = await run(m, [O1]);
  assert.equal(out.cancelled, 0); assert.deepEqual(out.honored.map((h) => h.payment_id), [ap]);
  assert.equal(m.calls.filter((c) => c.startsWith("PUT")).length, 0); assert.equal(m.pays.get(ap).status, "approved");
});

test("C4 corrida: aprova entre a busca e o cancelamento => 400/2018, releitura approved => HONRADO, não falha", async () => {
  const m = mp({ aoCancelar: (p) => { if (p.status === "pending") p.status = "approved"; } }); const id = m.criar(O1, "pending");
  const out = await run(m, [O1]);
  assert.equal(out.ok, true); assert.equal(out.cancelled, 0);
  assert.deepEqual(out.honored, [{ order_id: O1, payment_id: id, race: true }]);
});

test("C5 nunca age em pagamento de OUTRO pedido, mesmo se a busca devolver", async () => {
  const m = mp(); const alheio = m.criar(O2, "pending", { vazar: true });
  const out = await run(m, [O1]);
  assert.equal(out.cancelled, 0); assert.equal(m.pays.get(alheio).status, "pending");
});

test("C6 PUT responde 200 mas o pagamento continua pendente => falha registrada (releitura decide)", async () => {
  const m = mp(); m.criar(O1, "pending", { ignorarCancelamento: true });
  const out = await run(m, [O1]);
  assert.equal(out.ok, false); assert.equal(out.failed[0].reason, "provider_status_pending");
});

test("C7 vários pagamentos no mesmo pedido: só os pendentes são cancelados; rejeitado/cancelado ficam intactos", async () => {
  const m = mp(); const rej = m.criar(O1, "rejected"); const pend = m.criar(O1, "pending"); const can = m.criar(O1, "cancelled");
  const out = await run(m, [O1]);
  assert.equal(out.cancelled, 1); assert.equal(m.pays.get(pend).status, "cancelled");
  assert.equal(m.pays.get(rej).status, "rejected"); assert.equal(m.pays.get(can).status, "cancelled");
  assert.equal(m.calls.filter((c) => c.startsWith("PUT")).length, 1);
});

test("C8 falha na busca => listada, ok=false; padrão dryRun não chama o provedor; sem token não chama", async () => {
  const quebrado = { fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) };
  const out = await cancelPendingMercadoPagoPayments(banco([O1]), { accessToken: "x", fetchImpl: quebrado.fetch, dryRun: false });
  assert.equal(out.ok, false); assert.equal(out.failed[0].reason, "search_http_503");
  let n = 0; const f = async () => { n++; return { ok: true, status: 200, json: async () => ({ results: [] }) }; };
  const dry = await cancelPendingMercadoPagoPayments(banco([O1]), { accessToken: "x", fetchImpl: f });
  assert.equal(dry.dry_run, true); assert.equal(dry.to_cancel.length, 1); assert.equal(n, 0);
  const sem = await cancelPendingMercadoPagoPayments(banco([O1]), { accessToken: "", fetchImpl: f, dryRun: false });
  assert.equal(sem.reason, "provider_token_unavailable"); assert.equal(n, 0);
});
