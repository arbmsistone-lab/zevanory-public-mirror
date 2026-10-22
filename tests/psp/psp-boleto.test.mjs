// B05 — boleto Asaas (unidade). API do Asaas simulada no formato documentado; nenhuma chamada real.
import test from "node:test";
import assert from "node:assert/strict";
import { BoletoError, boletoDueDate, buildBoletoPaymentPayload, createAsaasBoletoCharge, normalizeBoletoPayer, normalizeBoletoPayment, validCnpj, validCpf } from "../../worker/asaas-boleto.mjs";

const REF = "ZEVANORY:EXP-0001:0f8fad5b-d9cb-469f-a165-70867728950e";
const ORDER = { external_reference: REF, amount: 197, description: "Produto 1.0 (ZEV-IA-011)" };
const PAYER = normalizeBoletoPayer({ name: "Cliente Sintético", cpf_cnpj: "529.982.247-25", email: "cliente@example.com" });
const NOW = Date.parse("2026-10-22T15:00:00Z");

function fakeAsaas({ existing = [], customers = [], createMode = "ok", lookupMode = "ok", customerLookupMode = "ok", afterTimeoutVisible = false, slipHost = "sandbox.asaas.com" } = {}) {
  const w = { calls: [], payments: [...existing], customers: [...customers], posts: { customers: 0, payments: 0 } };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  w.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    w.calls.push({ method, path: url.pathname, search: url.search, host: url.hostname, token: init.headers?.access_token, ua: init.headers?.["user-agent"], body: init.body ? JSON.parse(init.body) : null, hasSignal: Boolean(init.signal) });
    if (url.hostname !== "api-sandbox.asaas.com") throw new Error("host inesperado " + url.hostname);
    if (method === "GET" && url.pathname === "/v3/payments") {
      if (lookupMode === "500") return json(500, {});
      const ref = url.searchParams.get("externalReference");
      const data = w.payments.filter((p) => p.externalReference === ref);
      return json(200, { object: "list", hasMore: false, totalCount: data.length, limit: 10, offset: 0, data });
    }
    if (method === "GET" && url.pathname === "/v3/customers") {
      if (customerLookupMode === "500") return json(500, {});
      const data = w.customers.filter((c) => c.cpfCnpj === url.searchParams.get("cpfCnpj"));
      return json(200, { object: "list", hasMore: false, totalCount: data.length, data });
    }
    if (method === "POST" && url.pathname === "/v3/customers") {
      w.posts.customers++;
      const c = { id: "cus_00000" + (w.customers.length + 1), ...JSON.parse(init.body) };
      w.customers.push(c);
      return json(200, c);
    }
    if (method === "POST" && url.pathname === "/v3/payments") {
      w.posts.payments++;
      const b = JSON.parse(init.body);
      const p = { object: "payment", id: "pay_sim" + String(w.posts.payments).padStart(6, "0"), status: "PENDING", billingType: b.billingType, value: b.value, dueDate: b.dueDate, externalReference: b.externalReference, customer: b.customer, deleted: false, bankSlipUrl: `https://${slipHost}/b/pdf/x${w.posts.payments}`, invoiceUrl: `https://${slipHost}/i/x${w.posts.payments}` };
      if (createMode === "timeout") {
        if (afterTimeoutVisible) w.payments.push(p);
        const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e;
      }
      if (createMode === "500") { if (afterTimeoutVisible) w.payments.push(p); return json(500, {}); }
      if (createMode === "400") return json(400, { errors: [{ code: "invalid_customer" }] });
      w.payments.push(p);
      return json(200, p);
    }
    return json(404, {});
  };
  return w;
}
const run = (w, extra = {}) => createAsaasBoletoCharge({ fetchImpl: w.fetch, env: "sandbox", apiKey: "$aact_synthetic", order: ORDER, payer: PAYER, now: NOW, timeoutMs: 1000, ...extra });

test("B01 CPF/CNPJ: dígitos verificadores e repetidos", () => {
  assert.equal(validCpf("529.982.247-25"), true);
  assert.equal(validCpf("529.982.247-24"), false);
  assert.equal(validCpf("111.111.111-11"), false);
  assert.equal(validCnpj("11.222.333/0001-81"), true);
  assert.equal(validCnpj("11.222.333/0001-80"), false);
  assert.equal(validCnpj("00000000000000"), false);
});

test("B02 pagador: nome, documento e e-mail validados; nada passa sem documento válido", () => {
  assert.equal(PAYER.cpfCnpj, "52998224725");
  assert.equal(normalizeBoletoPayer({ name: "Ab", cpf_cnpj: "52998224725" }), null);
  assert.equal(normalizeBoletoPayer({ name: "Nome <script>", cpf_cnpj: "52998224725" }), null);
  assert.equal(normalizeBoletoPayer({ name: "Nome Válido", cpf_cnpj: "12345678900" }), null);
  assert.equal(normalizeBoletoPayer({ name: "Nome Válido", cpf_cnpj: "52998224725", email: "sem-arroba" }), null);
  assert.equal(normalizeBoletoPayer({ name: "Empresa Ltda", cpfCnpj: "11222333000181" }).cpfCnpj, "11222333000181");
});

test("B03 vencimento em America/Sao_Paulo (UTC-3), inclusive perto da meia-noite UTC", () => {
  assert.equal(boletoDueDate(NOW, 3), "2026-10-25");
  assert.equal(boletoDueDate(Date.parse("2026-10-23T02:00:00Z"), 3), "2026-10-25");
  assert.equal(boletoDueDate(Date.parse("2026-10-23T03:00:00Z"), 3), "2026-10-26");
  assert.equal(boletoDueDate(NOW, 99), "2026-10-25");
});

test("B04 fluxo feliz: consulta antes, cria cliente e UMA cobrança BOLETO com externalReference do pedido", async () => {
  const w = fakeAsaas();
  const out = await run(w);
  assert.match(out.id, /^pay_/);
  assert.equal(out.bankSlipUrl, "https://sandbox.asaas.com/b/pdf/x1");
  assert.equal(out.reused, false);
  assert.deepEqual(w.calls.map((c) => `${c.method} ${c.path}`), ["GET /v3/payments", "GET /v3/customers", "POST /v3/customers", "POST /v3/payments"]);
  const pay = w.calls.at(-1).body;
  assert.deepEqual(pay, { customer: "cus_000001", billingType: "BOLETO", value: 197, dueDate: "2026-10-25", externalReference: REF, description: ORDER.description, daysAfterDueDateToRegistrationCancellation: 1 });
  assert.ok(w.calls.every((c) => c.token === "$aact_synthetic" && c.hasSignal && /sandbox\)$/.test(c.ua)));
  assert.equal(w.calls[1].search, "?cpfCnpj=52998224725&limit=1");
});

test("B05 cliente existente é reutilizado (sem duplicar cliente)", async () => {
  const w = fakeAsaas({ customers: [{ id: "cus_existing1", cpfCnpj: "52998224725", deleted: false }] });
  await run(w);
  assert.equal(w.posts.customers, 0);
  assert.equal(w.calls.at(-1).body.customer, "cus_existing1");
});

test("B06 retentativa do mesmo pedido: boleto existente é devolvido, nenhum POST novo", async () => {
  const w = fakeAsaas();
  const first = await run(w);
  const second = await run(w);
  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.equal(w.posts.payments, 1);
});

test("B07 timeout no POST com cobrança criada: reconcilia e devolve a MESMA cobrança (sem segunda)", async () => {
  const w = fakeAsaas({ createMode: "timeout", afterTimeoutVisible: true });
  // O desfecho é verificado por asserção (devolver a cobrança existente, sem lançar), não por exceção não tratada.
  const out = await run(w).catch((e) => ({ thrown: String(e?.code || e) }));
  assert.deepEqual({ reconciled: out.reconciled, thrown: out.thrown }, { reconciled: true, thrown: undefined });
  assert.equal(w.posts.payments, 1);
  assert.equal(w.payments.length, 1);
});

test("B08 timeout no POST sem cobrança visível: erro AMBÍGUO e nenhum reenvio", async () => {
  const w = fakeAsaas({ createMode: "timeout" });
  await assert.rejects(run(w), (e) => e instanceof BoletoError && e.ambiguous === true && e.definitive === false && e.code === "boleto_provider_uncertain");
  assert.equal(w.posts.payments, 1);
});

test("B09 5xx no POST também é ambíguo (reconcilia antes de qualquer nova tentativa)", async () => {
  const w = fakeAsaas({ createMode: "500" });
  await assert.rejects(run(w), (e) => e.ambiguous === true && e.providerHttpStatus === 500);
  assert.equal(w.posts.payments, 1);
  const w2 = fakeAsaas({ createMode: "500", afterTimeoutVisible: true });
  const out = await run(w2).catch((e) => ({ thrown: String(e?.code || e) }));
  assert.deepEqual({ reconciled: out.reconciled, thrown: out.thrown }, { reconciled: true, thrown: undefined });
});

test("B10 400 no POST é rejeição definitiva (nada criado, pedido pode voltar a 'created')", async () => {
  const w = fakeAsaas({ createMode: "400" });
  await assert.rejects(run(w), (e) => e.definitive === true && e.ambiguous === false && e.providerHttpStatus === 400);
});

test("B11 consulta prévia indisponível: definitivo e NENHUM POST (não cria às cegas)", async () => {
  const w = fakeAsaas({ lookupMode: "500" });
  await assert.rejects(run(w), (e) => e.definitive === true && e.code === "boleto_lookup_unavailable");
  assert.equal(w.posts.payments, 0);
  assert.equal(w.posts.customers, 0);
  const w2 = fakeAsaas({ customerLookupMode: "500" });
  await assert.rejects(run(w2), (e) => e.definitive === true && e.code === "boleto_customer_lookup_unavailable");
  assert.equal(w2.posts.payments, 0);
});

test("B12 duas cobranças vivas para o mesmo pedido: conflito ambíguo, nada criado", async () => {
  const base = { billingType: "BOLETO", value: 197, externalReference: REF, status: "PENDING", deleted: false, bankSlipUrl: "https://sandbox.asaas.com/b/1" };
  const w = fakeAsaas({ existing: [{ ...base, id: "pay_aaaaaa1" }, { ...base, id: "pay_aaaaaa2" }] });
  await assert.rejects(run(w), (e) => e.ambiguous === true && e.code === "boleto_reconciliation_conflict");
  assert.equal(w.posts.payments, 0);
});

test("B13 cobrança excluída/estornada não conta como existente", async () => {
  const w = fakeAsaas({ existing: [{ id: "pay_deleted1", billingType: "BOLETO", value: 197, externalReference: REF, status: "PENDING", deleted: true, bankSlipUrl: "https://sandbox.asaas.com/b/1" }] });
  const out = await run(w);
  assert.equal(out.reused, false);
  assert.equal(w.posts.payments, 1);
});

test("B14 resposta com host de boleto estranho ou valor/referência divergente é rejeitada", async () => {
  const w = fakeAsaas({ slipHost: "evil.example" });
  await assert.rejects(run(w), (e) => e.ambiguous === true && e.code === "boleto_response_invalid");
  const good = { id: "pay_abcdef1", billingType: "BOLETO", value: 197, externalReference: REF, status: "PENDING", bankSlipUrl: "https://www.asaas.com/b/pdf/1" };
  assert.ok(normalizeBoletoPayment(good, { externalReference: REF, amount: 197, env: "production" }));
  assert.equal(normalizeBoletoPayment(good, { externalReference: REF, amount: 197, env: "sandbox" }), null);
  assert.equal(normalizeBoletoPayment({ ...good, value: 19.7 }, { externalReference: REF, amount: 197, env: "production" }), null);
  assert.equal(normalizeBoletoPayment({ ...good, externalReference: REF + "x" }, { externalReference: REF, amount: 197, env: "production" }), null);
  assert.equal(normalizeBoletoPayment({ ...good, billingType: "PIX" }, { externalReference: REF, amount: 197, env: "production" }), null);
  assert.equal(normalizeBoletoPayment({ ...good, bankSlipUrl: "http://www.asaas.com/b" }, { externalReference: REF, amount: 197, env: "production" }), null);
});

test("B15 payload: só com cliente cus_, valor positivo e data válida", () => {
  assert.equal(buildBoletoPaymentPayload({ customerId: "x", amount: 1, externalReference: REF, dueDate: "2026-10-25" }), null);
  assert.equal(buildBoletoPaymentPayload({ customerId: "cus_123", amount: 0, externalReference: REF, dueDate: "2026-10-25" }), null);
  assert.equal(buildBoletoPaymentPayload({ customerId: "cus_123", amount: 1, externalReference: REF, dueDate: "25/10/2026" }), null);
  assert.equal(buildBoletoPaymentPayload({ customerId: "cus_123", amount: 19.9, externalReference: REF, dueDate: "2026-10-25" }).value, 19.9);
});

test("B16 sem API key ou ambiente inválido: definitivo, sem rede", async () => {
  const w = fakeAsaas();
  await assert.rejects(run(w, { apiKey: "" }), (e) => e.definitive === true);
  await assert.rejects(run(w, { env: "staging" }), (e) => e.definitive === true);
  assert.equal(w.calls.length, 0);
});
