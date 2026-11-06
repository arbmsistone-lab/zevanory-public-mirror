// B05 — boleto via Asaas pela API de cobranças.
//
// Fonte oficial (consultada em 22/10/2026):
//  - O Asaas Checkout (POST /v3/checkouts) aceita SOMENTE billingTypes CREDIT_CARD e PIX:
//    https://docs.asaas.com/reference/criar-novo-checkout · https://docs.asaas.com/docs/asaas-checkout-faq
//  - Boleto = POST /v3/payments com billingType "BOLETO" e campos obrigatórios customer, billingType, value,
//    dueDate; externalReference é campo livre de busca; daysAfterDueDateToRegistrationCancellation só para boleto:
//    https://docs.asaas.com/reference/criar-nova-cobranca · https://docs.asaas.com/docs/cobrancas-via-boleto
//  - Cliente: POST /v3/customers exige name e cpfCnpj; a API ACEITA duplicados e, em timeout/resposta
//    inconclusiva, a orientação é consultar antes de reenviar: https://docs.asaas.com/reference/criar-novo-cliente ·
//    https://docs.asaas.com/docs/creating-customers · filtro cpfCnpj em https://docs.asaas.com/reference/listar-clientes
//  - GET /v3/payments filtra por externalReference (limit ≤ 100): https://docs.asaas.com/reference/listar-cobrancas
//  - Nenhum cabeçalho de idempotência é documentado nesses endpoints. Por isso a idempotência é por pedido:
//    externalReference único por pedido + consulta ANTES de criar + reconciliação imediata em resultado ambíguo.
//  - Não liberar produto pela criação da cobrança; só pelo webhook confirmado e re-consultado.

export const ASAAS_API_BASES = Object.freeze({ sandbox: "https://api-sandbox.asaas.com/v3", production: "https://api.asaas.com/v3" });
const SLIP_HOSTS = Object.freeze({ sandbox: ["sandbox.asaas.com"], production: ["www.asaas.com", "asaas.com"] });
const DEAD_STATUSES = new Set(["DELETED", "REFUNDED", "REFUND_REQUESTED", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL"]);
export const BOLETO_DEFAULT_DUE_DAYS = 3;
export const PROVIDER_TIMEOUT_MS = 10_000;

export class BoletoError extends Error {
  constructor(code, { definitive = false, ambiguous = false, providerHttpStatus = 0, phase = "" } = {}) {
    super(code);
    this.code = code;
    this.definitive = definitive; // provado: nenhuma cobrança criada nesta tentativa
    this.ambiguous = ambiguous;   // a cobrança pode existir: reconciliar antes de nova tentativa
    this.providerHttpStatus = providerHttpStatus;
    this.phase = phase;
  }
}

const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");

export function validCpf(value) {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

export function validCnpj(value) {
  const d = onlyDigits(value);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

export function normalizeBoletoPayer(input) {
  if (!input || typeof input !== "object") return null;
  const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 3 || name.length > 120 || /[\u0000-\u001f\u007f<>]/.test(name)) return null;
  const cpfCnpj = onlyDigits(input.cpf_cnpj ?? input.cpfCnpj);
  if (!(validCpf(cpfCnpj) || validCnpj(cpfCnpj))) return null;
  const email = String(input.email ?? "").trim().toLowerCase();
  if (email && !/^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,24}$/.test(email)) return null;
  return Object.freeze({ name, cpfCnpj, email: email || "" });
}

// America/Sao_Paulo é UTC-3 fixo (sem horário de verão desde 2019).
export function boletoDueDate(nowMs, days = BOLETO_DEFAULT_DUE_DAYS) {
  const n = Number.isInteger(days) && days >= 1 && days <= 30 ? days : BOLETO_DEFAULT_DUE_DAYS;
  const local = new Date(Number(nowMs) - 3 * 3600 * 1000);
  local.setUTCDate(local.getUTCDate() + n);
  return local.toISOString().slice(0, 10);
}

const cents = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };

export function buildBoletoPaymentPayload({ customerId, amount, externalReference, description, dueDate }) {
  if (!/^cus_[A-Za-z0-9_-]{3,80}$/.test(String(customerId || ""))) return null;
  if (!(cents(amount) > 0) || !externalReference || !/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || ""))) return null;
  return Object.freeze({
    customer: String(customerId),
    billingType: "BOLETO",
    value: cents(amount) / 100,
    dueDate: String(dueDate),
    externalReference: String(externalReference),
    description: String(description || "").slice(0, 500),
    daysAfterDueDateToRegistrationCancellation: 1,
  });
}

export function normalizeBoletoPayment(value, { externalReference, amount, env = "sandbox" } = {}) {
  if (!value || typeof value !== "object") return null;
  if (!/^pay_[A-Za-z0-9_-]{6,120}$/.test(String(value.id || ""))) return null;
  if (String(value.billingType || "") !== "BOLETO") return null;
  if (String(value.externalReference || "") !== String(externalReference || "")) return null;
  if (cents(value.value) !== cents(amount)) return null;
  if (value.deleted === true || DEAD_STATUSES.has(String(value.status || ""))) return null;
  const hosts = SLIP_HOSTS[String(env).toLowerCase()];
  if (!hosts) return null;
  const urlOk = (raw) => { try { const u = new URL(String(raw || "")); return u.protocol === "https:" && hosts.includes(u.hostname); } catch { return false; } };
  if (!urlOk(value.bankSlipUrl)) return null;
  const invoiceUrl = urlOk(value.invoiceUrl) ? String(value.invoiceUrl) : "";
  return Object.freeze({ id: String(value.id), bankSlipUrl: String(value.bankSlipUrl), invoiceUrl, dueDate: String(value.dueDate || ""), status: String(value.status || "") });
}

function headersFor(apiKey, env) {
  return { accept: "application/json", "content-type": "application/json", "user-agent": `ZEVANORY/1.0 (Cloudflare Worker; ${env === "production" ? "production" : "sandbox"})`, access_token: apiKey };
}

async function call(fetchImpl, url, init, timeoutMs, signal = null) {
  let response;
  try {
    // B05 (#879-2): na sondagem do disjuntor o prazo total da sondagem também corta cada chamada.
    response = await fetchImpl(url, { ...init, signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, network: true, status: 0, error: String(error?.name || error?.message || "network") };
  }
  const data = await response.json().catch(() => null);
  return { ok: response.ok, network: false, status: Number(response.status || 0), data };
}

const definitiveReject = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

async function findExisting(fetchImpl, base, headers, ref, expect, timeoutMs, signal = null) {
  const r = await call(fetchImpl, `${base}/payments?externalReference=${encodeURIComponent(ref)}&limit=10`, { method: "GET", headers }, timeoutMs, signal);
  if (!r.ok || !Array.isArray(r.data?.data)) return { known: false };
  const live = r.data.data.filter((p) => String(p?.externalReference || "") === ref && p?.deleted !== true && !DEAD_STATUSES.has(String(p?.status || "")));
  if (live.length === 0) return { known: true, payment: null };
  if (live.length > 1) return { known: true, conflict: true };
  const normalized = normalizeBoletoPayment(live[0], expect);
  return normalized ? { known: true, payment: normalized } : { known: true, conflict: true };
}

export async function createAsaasBoletoCharge({ fetchImpl = fetch, env = "sandbox", apiKey, order, payer, now = Date.now(), dueDays = BOLETO_DEFAULT_DUE_DAYS, timeoutMs = PROVIDER_TIMEOUT_MS, signal = null } = {}) {
  const base = ASAAS_API_BASES[String(env).toLowerCase()];
  if (!base || !apiKey) throw new BoletoError("asaas_not_configured", { definitive: true, phase: "config" });
  const ref = String(order?.external_reference || "");
  if (!ref || !(cents(order?.amount) > 0) || !payer) throw new BoletoError("boleto_input_invalid", { definitive: true, phase: "config" });
  const headers = headersFor(apiKey, env);
  const expect = { externalReference: ref, amount: order.amount, env };

  // 1) Reconciliação ANTES de criar: o mesmo pedido nunca recebe um segundo boleto.
  const prior = await findExisting(fetchImpl, base, headers, ref, expect, timeoutMs, signal);
  if (!prior.known) throw new BoletoError("boleto_lookup_unavailable", { definitive: true, phase: "lookup" });
  if (prior.conflict) throw new BoletoError("boleto_reconciliation_conflict", { ambiguous: true, phase: "lookup" });
  if (prior.payment) return Object.freeze({ ...prior.payment, reused: true });

  // 2) Cliente: consultar por CPF/CNPJ antes de criar (a API aceita duplicados).
  let customerId = "";
  const lookup = await call(fetchImpl, `${base}/customers?cpfCnpj=${encodeURIComponent(payer.cpfCnpj)}&limit=1`, { method: "GET", headers }, timeoutMs, signal);
  if (!lookup.ok) throw new BoletoError("boleto_customer_lookup_unavailable", { definitive: true, providerHttpStatus: lookup.status, phase: "customer" });
  const found = Array.isArray(lookup.data?.data) ? lookup.data.data.find((c) => c?.deleted !== true && /^cus_/.test(String(c?.id || ""))) : null;
  if (found) customerId = String(found.id);
  else {
    const created = await call(fetchImpl, `${base}/customers`, { method: "POST", headers, body: JSON.stringify({ name: payer.name, cpfCnpj: payer.cpfCnpj, ...(payer.email ? { email: payer.email } : {}), notificationDisabled: true }) }, timeoutMs, signal);
    if (created.ok && /^cus_/.test(String(created.data?.id || ""))) customerId = String(created.data.id);
    else throw new BoletoError("boleto_customer_unavailable", { definitive: true, providerHttpStatus: created.status, phase: "customer" });
  }

  // 3) Cobrança.
  const payload = buildBoletoPaymentPayload({ customerId, amount: order.amount, externalReference: ref, description: order.description, dueDate: boletoDueDate(now, dueDays) });
  if (!payload) throw new BoletoError("boleto_payload_invalid", { definitive: true, phase: "payload" });
  const res = await call(fetchImpl, `${base}/payments`, { method: "POST", headers, body: JSON.stringify(payload) }, timeoutMs, signal);
  if (res.ok) {
    const normalized = normalizeBoletoPayment(res.data, expect);
    if (normalized) return Object.freeze({ ...normalized, reused: false });
    throw new BoletoError("boleto_response_invalid", { ambiguous: true, providerHttpStatus: res.status, phase: "create" });
  }
  if (!res.network && definitiveReject(res.status)) throw new BoletoError("boleto_rejected", { definitive: true, providerHttpStatus: res.status, phase: "create" });

  // 4) Ambíguo (timeout/rede/5xx/408/429): reconciliar primeiro. Só devolve se achar exatamente a cobrança deste pedido.
  const after = await findExisting(fetchImpl, base, headers, ref, expect, timeoutMs, signal);
  if (after.known && after.payment) return Object.freeze({ ...after.payment, reused: true, reconciled: true });
  throw new BoletoError("boleto_provider_uncertain", { ambiguous: true, providerHttpStatus: res.status, phase: "create" });
}
