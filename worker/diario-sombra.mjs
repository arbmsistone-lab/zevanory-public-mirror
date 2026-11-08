// ZEVANORY | P20 diário D1, PR 3 (docs/p20/diario-d1.md, seção "Gravação em modo sombra").
//
// Grava os eventos críticos no diário (worker/diario-p20.mjs) em MODO SOMBRA:
//  - sem binding D1 (env.DIARIO ausente) é no-op: nada é lido, nada é gravado, nada é registrado;
//  - nunca bloqueia: a gravação vai para ctx.waitUntil; quem chama NUNCA espera (não use await no gancho);
//  - nunca lança: tudo, inclusive o construtor do evento, roda dentro de try/catch e de uma promessa que não rejeita;
//  - nunca altera a resposta: o gancho não devolve nada que o chamador use;
//  - falhas (tabela ausente, conflito, corrida, PII recusada) viram um log estruturado SEM PII
//    ({"evt":"diario_sombra", tipo, ok, code, seq}). O roteiro proíbe KV para o diário, então não há contador em KV:
//    só o log e um contador em memória do isolate (diarioSombraStats), útil para teste e diagnóstico.
//
// Contexto por requisição: o Worker central (worker/cloudflare-worker.compat.mjs) chama comDiario(env, ctx, fn) em
// volta do processamento da requisição. Os ganchos que não recebem env/ctx (o bundle legado, que roda atrás do
// servidor node:http, e funções internas como recordEvent do lead-magnet) acham o banco e o waitUntil por
// AsyncLocalStorage. Sem AsyncLocalStorage (runtime sem o módulo), o gancho usa o binding guardado em
// globalThis.__ZEVANORY_DIARIO__ (o mesmo objeto em todas as requisições, como o KV em __ZEVANORY_PRIVATE_KV__) e,
// sem waitUntil, deixa a promessa correr sozinha (pode ser cortada no fim da requisição: aceitável em sombra).
import { appendEvent, eventKey } from "./diario-p20.mjs";

export const DIARIO_SOMBRA_LOG = "diario_sombra";
const NOOP = Object.freeze({ queued: false, reason: "sem_binding" });

// AsyncLocalStorage sem import estático: um runtime sem node:async_hooks não derruba o Worker na carga do módulo.
let als = null;
try {
  const mod = globalThis.process?.getBuiltinModule?.("node:async_hooks");
  if (mod?.AsyncLocalStorage) als = new mod.AsyncLocalStorage();
} catch {
  als = null;
}

const stats = { agendados: 0, gravados: 0, duplicados: 0, falhas: 0, por_codigo: {} };
export function diarioSombraStats() {
  return { ...stats, por_codigo: { ...stats.por_codigo } };
}
export function resetDiarioSombraStats() {
  stats.agendados = stats.gravados = stats.duplicados = stats.falhas = 0;
  stats.por_codigo = {};
}

// Fila por isolate: as gravações do mesmo isolate saem uma de cada vez. Sem ela, várias gravações simultâneas
// disputam a cabeça (compare-and-set) e esgotam MAX_TENTATIVAS (diario_corrida). Entre isolates o CAS continua
// valendo. Cada gravação tem um limite de tempo para que um D1 travado não pare a fila: vira diario_timeout.
export const GRAVACAO_TIMEOUT_MS = 5000;
let timeoutMs = GRAVACAO_TIMEOUT_MS;
// Agendador do limite de tempo: agendar(fn, ms) -> cancelar(). Produção: setTimeout real.
const AGENDAR_REAL = (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };
let agendar = AGENDAR_REAL;
// Só para testes: encurta o limite de tempo de cada gravação ou injeta um relógio manual (agendar), para que o limite
// só dispare quando o teste mandar. Sem isso, uma gravação legítima numa máquina carregada passava do limite curto e
// virava diario_timeout (instabilidade do DS5.6 sob carga).
export function configurarDiarioSombra({ timeoutMs: ms, agendar: ag } = {}) {
  timeoutMs = Number.isSafeInteger(ms) && ms > 0 ? ms : GRAVACAO_TIMEOUT_MS;
  agendar = typeof ag === "function" ? ag : AGENDAR_REAL;
}
let fila = Promise.resolve();
function comLimite(p, ms) {
  let cancelar = null;
  const limite = new Promise((resolve) => {
    cancelar = agendar(() => resolve({ ok: false, code: "diario_timeout" }), ms);
  });
  return Promise.race([p, limite]).finally(() => { try { if (typeof cancelar === "function") cancelar(); } catch {} });
}

const dbOk = (db) => Boolean(db) && typeof db.prepare === "function" && typeof db.batch === "function";

// Envolve o processamento de uma requisição. Sem env.DIARIO chama fn() direto: comportamento idêntico ao de hoje.
export function comDiario(env, ctx, fn) {
  let db = null;
  try { db = env?.DIARIO ?? null; } catch { db = null; }
  try { globalThis.__ZEVANORY_DIARIO__ = dbOk(db) ? db : null; } catch {}
  if (!dbOk(db) || !als) return fn();
  return als.run({ db, ctx }, fn);
}

function registrar(tipo, r) {
  const code = r?.ok ? (r.duplicate ? "duplicado" : "gravado") : String(r?.code || "diario_erro");
  if (r?.ok && r.duplicate) stats.duplicados++;
  else if (r?.ok) stats.gravados++;
  else { stats.falhas++; stats.por_codigo[code] = (stats.por_codigo[code] || 0) + 1; }
  try {
    // Sem PII por construção: só o tipo, o resultado, o código e o seq. Nunca a chave, a ref ou o payload.
    const line = { evt: DIARIO_SOMBRA_LOG, tipo: typeof tipo === "string" ? tipo : null, ok: Boolean(r?.ok), code };
    if (r?.ok && Number.isSafeInteger(r.seq)) line.seq = r.seq;
    if (!r?.ok) line.falhas_isolate = stats.falhas;
    console.log(JSON.stringify(line));
  } catch {}
}

// Gancho best-effort. ev é o evento ({tipo, event_key, ts_ms, ref?, payload}) ou uma função que o constrói (preferível:
// a construção também fica protegida). Devolve {queued, task}; task nunca rejeita e só existe para os testes.
export function diarioSombra(env, ctx, ev) {
  try {
    const store = als ? als.getStore() : undefined;
    let db = null;
    try { db = env?.DIARIO ?? null; } catch { db = null; }
    if (!dbOk(db)) db = store?.db ?? globalThis.__ZEVANORY_DIARIO__ ?? null;
    if (!dbOk(db)) return NOOP;
    const host = ctx && typeof ctx.waitUntil === "function" ? ctx : store?.ctx && typeof store.ctx.waitUntil === "function" ? store.ctx : null;
    stats.agendados++;
    let tipo = null;
    const gravar = async () => {
      const evt = typeof ev === "function" ? await ev() : ev;
      if (!evt) return null; // o construtor decidiu que não há evento (ex.: evento de lead sem tipo do diário)
      tipo = evt.tipo;
      const r = await comLimite(appendEvent(db, evt), timeoutMs);
      registrar(tipo, r);
      return r;
    };
    const task = fila.then(gravar).catch((error) => {
      const code = error && typeof error.code === "string" && error.code.startsWith("diario_") ? error.code : "diario_excecao";
      const r = { ok: false, code };
      registrar(tipo, r);
      return r;
    });
    fila = task.then(() => null, () => null); // a fila nunca carrega uma rejeição para a próxima gravação
    if (host) { try { host.waitUntil(task); } catch {} }
    return { queued: true, task };
  } catch {
    return { queued: false, reason: "diario_sombra_erro" };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Construtores de evento (puros). Só fatos não pessoais: ids técnicos, valor, moeda, provedor, status, versão do
// consentimento.
//
// Ids técnicos são NORMALIZADOS (techRef): prefixo de letras + só [A-Za-z0-9]. O detector de PII do diário recusa
// sequências de dígitos com formato de CPF ou telefone delimitadas por caractere não alfanumérico; com a forma
// normalizada nenhum dígito fica delimitado, então nenhum id técnico é recusado por engano. Sem isso, cerca de 1 em
// 10 mil UUIDs aleatórios seria recusado (último bloco de 12 dígitos lido como +55 e telefone) e "mp_1234567890"
// também. A forma é determinística: a reconciliação aplica a mesma função ao valor do Neon.
//   pedido (UUID)         -> "ord" + 32 hex           (3f2a9c1e-7b4d-... -> ord3f2a9c1e7b4d...)
//   Mercado Pago          -> "mp" + id                (1234567890 -> mp1234567890)
//   Asaas / Stripe        -> "as" / "st" + id         (pay_abc -> aspayabc; pi_3Abc -> stpi3Abc)
//   Hotmart (transação)   -> "hm" + id                (HP1722... -> hmHP1722...)
const str = (v) => String(v ?? "");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const now = (t) => (Number.isSafeInteger(t) && t > 0 ? t : Date.now());
const parte = (v) => str(v).toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 96) || "x";
export const REF_PREFIX = Object.freeze({ order: "ord", mercadopago: "mp", asaas: "as", stripe: "st", hotmart: "hm" });

export function techRef(kind, id) {
  const body = str(id).trim().replace(/[^A-Za-z0-9]/g, "");
  if (!body) return "";
  return ((REF_PREFIX[kind] ?? "id") + body).slice(0, 96);
}
export const orderRef = (orderId) => techRef("order", orderId);
export const providerRef = (provider, id) => techRef(provider, id);

export function eventoPedidoCriado({ orderId, provider, offerId, amount, currency = "BRL", certification = false, ts } = {}) {
  const order_ref = orderRef(orderId);
  return {
    tipo: "order_created",
    event_key: eventKey("order_created", order_ref),
    ts_ms: now(ts),
    ref: order_ref,
    payload: { order_ref, provider: str(provider), offer_id: str(offerId), amount: num(amount), currency: str(currency), status: "created", certification: certification === true },
  };
}

export function eventoPagamento({ orderId, provider, paymentId, status, normalized, amount, refundedTotal = null, currency = "BRL", certification = false, ts } = {}) {
  const order_ref = orderRef(orderId);
  const payment_ref = providerRef(provider, paymentId);
  const refunded = num(refundedTotal);
  return {
    tipo: "payment_status",
    event_key: eventKey("payment_status", order_ref, payment_ref, parte(status), "r" + (refunded ?? 0)),
    ts_ms: now(ts),
    ref: order_ref,
    payload: { order_ref, provider: str(provider), payment_ref, status: str(status), normalized_event: str(normalized), amount: num(amount), refunded_total: refunded, currency: str(currency), certification: certification === true },
  };
}

// Entrega: pedido próprio (orderId) ou transação do provedor (Hotmart, sem pedido no Neon).
export function eventoEntrega({ orderId = null, provider, transaction = null, channel, status = "sent", artifactSha256 = null, ts } = {}) {
  const order_ref = orderId ? orderRef(orderId) : null;
  const transaction_ref = transaction ? techRef(provider, transaction) : null;
  const payload = { provider: str(provider), channel: str(channel), status: str(status) };
  if (order_ref) payload.order_ref = order_ref;
  if (transaction_ref) payload.transaction_ref = transaction_ref;
  if (artifactSha256) payload.artifact_sha256 = str(artifactSha256);
  return {
    tipo: "delivery_sent",
    event_key: eventKey("delivery_sent", order_ref || transaction_ref, parte(channel)),
    ts_ms: now(ts),
    ref: order_ref || transaction_ref,
    payload,
  };
}

export function eventoReembolso({ orderId = null, provider, transaction = null, stage, refundId = null, amount = null, currency = "BRL", certification = false, ts } = {}) {
  const order_ref = orderId ? orderRef(orderId) : null;
  const transaction_ref = transaction ? techRef(provider, transaction) : null;
  const refund_ref = refundId ? providerRef(provider, refundId) : null;
  const payload = { provider: str(provider), stage: str(stage), amount: num(amount), currency: str(currency), certification: certification === true };
  if (order_ref) payload.order_ref = order_ref;
  if (transaction_ref) payload.transaction_ref = transaction_ref;
  if (refund_ref) payload.refund_ref = refund_ref;
  const partes = [order_ref || transaction_ref, parte(stage), ...(refund_ref ? [refund_ref] : [])];
  return { tipo: "refund", event_key: eventKey("refund", ...partes), ts_ms: now(ts), ref: order_ref || transaction_ref, payload };
}

// Consentimento (lead-magnet recordEvent). ts = instante do registro no Neon (coluna at, por neonTsMs), para que a
// reconciliação derive a mesma chave. ref = subject_ref HMAC já existente (64 hex). Sem ref, não há como chavear
// o titular sem dado pessoal: nenhum evento. Eventos sem tipo no diário (erase_kv_pending, ...) também não geram nada.
// Instante do Neon em ms (inteiro), a mesma expressão no gancho (RETURNING do insert) e na reconciliação (PR 4): o
// event_key de consentimento leva o instante, então os dois lados precisam do MESMO arredondamento.
export const neonTsMs = (col) => `(floor(extract(epoch from ${col}) * 1000))::bigint`;
export const LEAD_EVENTO_TIPO = Object.freeze({ consent_given: "consent_given", confirmed: "consent_confirmed", revoked_and_erased: "consent_revoked" });
export function eventoConsentimento({ event, subjectRef, consentVersion = null, ts } = {}) {
  const tipo = LEAD_EVENTO_TIPO[str(event)];
  const ref = str(subjectRef);
  if (!tipo || !/^[0-9a-f]{64}$/.test(ref)) return null;
  const ts_ms = now(ts);
  return {
    tipo,
    event_key: eventKey(tipo, ref, parte(consentVersion || "sem_versao"), "t" + ts_ms),
    ts_ms,
    ref,
    payload: { subject_hmac: ref, lead_event: str(event), consent_version: consentVersion == null ? null : str(consentVersion) },
  };
}
