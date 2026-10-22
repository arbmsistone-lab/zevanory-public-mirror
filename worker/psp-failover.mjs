// B05/B08 — failover entre provedores de pagamento (PSP) com disjuntor por provedor.
//
// Regras (todas cobertas por tests/psp/ e por mutantes em scripts/ci/psp_mutants.py):
//  1. Ordem FIXA e determinística: mercadopago -> asaas. Nunca balanceamento por hash.
//  2. Disjuntor por provedor: abre depois de N falhas de disponibilidade (timeout/rede/5xx/429) dentro da
//     janela; depois do resfriamento deixa passar UMA sondagem (meio aberto); sucesso fecha, falha reabre.
//  3. Trava comercial: avaliada imediatamente antes de CADA tentativa. Vendas fechadas bloqueiam os dois
//     provedores; o failover nunca reabre vendas.
//  4. Resultado ambíguo (o pedido pode ter chegado ao provedor: timeout no meio da requisição, 5xx, resposta
//     inválida, falha ao persistir) => NUNCA tenta o próximo provedor para o mesmo pedido. O pedido fica
//     "checkout_uncertain" e vai para reconciliação; segunda cobrança só depois de reconciliar.
//  5. Só "not_attempted" (o provedor não foi chamado e nenhum pedido foi gravado) permite tentar o próximo.
//  6. Nenhum provedor disponível => 503 fail-closed.
import crypto from "node:crypto";

export const PSP_FALLBACK_ORDER = Object.freeze(["mercadopago", "asaas"]);
export const BREAKER_DEFAULTS = Object.freeze({ threshold: 3, windowMs: 5 * 60 * 1000, cooldownMs: 2 * 60 * 1000 });
export const BREAKER_FAILURE_KINDS = Object.freeze(["timeout", "network", "5xx", "throttled"]);
export const BREAKER_KEY_PREFIX = "psp:circuit:v1:";
// Saúde EXPLÍCITA (além do disjuntor automático): o proprietário/operação marca um provedor como fora
// (PSP_FORCE_DOWN=mercadopago,asaas no ambiente, ou KV psp:health:v1:<provedor> = {"status":"down"}).
// Provedor marcado fora nunca é chamado; marcar os dois => 503 fail-closed.
export const HEALTH_KEY_PREFIX = "psp:health:v1:";

// Respostas dos handlers que provam que o provedor NÃO foi chamado e nenhum pedido foi gravado.
export const NOT_ATTEMPTED_ERRORS = Object.freeze(["checkout_provider_unavailable", "checkout_environment_invalid"]);
// Respostas em que o provedor pode ter criado a cobrança/checkout: reconciliar antes de qualquer nova tentativa.
export const AMBIGUOUS_ERRORS = Object.freeze(["checkout_provider_uncertain", "checkout_response_invalid", "checkout_persist_failed"]);
// Falha provada sem cobrança criada, mas com o pedido já gravado neste provedor: não troca de provedor
// (o request_id pertence a ele), porém conta como indisponibilidade no disjuntor.
export const UNAVAILABLE_AFTER_ORDER_ERRORS = Object.freeze(["boleto_provider_unavailable"]);

const memoryStores = new Map();
function memoryStore(name = "default") {
  if (!memoryStores.has(name)) {
    const map = new Map();
    memoryStores.set(name, { async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v) { map.set(k, String(v)); }, _map: map });
  }
  return memoryStores.get(name);
}

const boundedInt = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function breakerConfigFromEnv(env = {}) {
  return Object.freeze({
    threshold: boundedInt(env.PSP_BREAKER_THRESHOLD, BREAKER_DEFAULTS.threshold, 1, 20),
    windowMs: boundedInt(env.PSP_BREAKER_WINDOW_MS, BREAKER_DEFAULTS.windowMs, 10_000, 3_600_000),
    cooldownMs: boundedInt(env.PSP_BREAKER_COOLDOWN_MS, BREAKER_DEFAULTS.cooldownMs, 5_000, 3_600_000),
    forcedDown: Object.freeze(String(env.PSP_FORCE_DOWN || "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => PSP_FALLBACK_ORDER.includes(x))),
  });
}

// Erros do armazenamento do disjuntor/saúde (KV) NUNCA são engolidos: viram estado "unknown", log estruturado
// `psp_breaker_store_error` e contador (stats()). Semântica fail-safe (decisão conservadora, Sol AVAL 083):
//  * leitura falhou (ou registro ilegível) => saúde DESCONHECIDA. Provedor desconhecido só é tentado se for o
//    PRIMEIRO do plano (o que aconteceria sem failover). Nunca se abre o fallback às cegas: fallback desconhecido
//    é pulado => sem provedor utilizável => 503 fail-closed. Dupla cobrança continua impossível (regra do ambíguo).
//  * escrita falhou => o resultado da tentativa não muda (nada é refeito); erro registrado/contado.
// Meia-abertura: a sondagem ÚNICA entre isolates é garantida por um coordenador FORTEMENTE consistente
// (probeLease; em produção, linha do PostgreSQL com INSERT ... ON CONFLICT DO UPDATE ... WHERE lease vencido).
// Sem coordenador, ou se ele falhar, a sondagem é NEGADA (o provedor segue tratado como aberto).
export const PROBE_LEASE_MS = 30_000;
export const PROBE_LEASE_SQL = `INSERT INTO psp_circuit_probes (provider, lease_owner, lease_until, updated_at)
VALUES ($1::text, $2::text, now() + ($3::int * interval '1 millisecond'), now())
ON CONFLICT (provider) DO UPDATE SET lease_owner = EXCLUDED.lease_owner, lease_until = EXCLUDED.lease_until, updated_at = now()
WHERE psp_circuit_probes.lease_until <= now()
RETURNING lease_owner`;

export function createPgProbeLease(sql, { ttlMs = PROBE_LEASE_MS } = {}) {
  return Object.freeze({
    async acquire(provider, owner) {
      const rows = await sql.query(PROBE_LEASE_SQL, [String(provider), String(owner), ttlMs]);
      return Array.isArray(rows) && rows.length === 1 && String(rows[0].lease_owner) === String(owner);
    },
  });
}

// Só para testes de unidade/isolate único (NÃO é coordenação entre isolates).
export function createMemoryProbeLease({ now = () => Date.now(), ttlMs = PROBE_LEASE_MS } = {}) {
  const leases = new Map();
  return Object.freeze({
    async acquire(provider, owner) {
      const t = now();
      const cur = leases.get(provider);
      if (cur && cur.until > t) return false;
      leases.set(provider, { owner, until: t + ttlMs });
      return true;
    },
  });
}

const errorClass = (error) => String(error?.name || "Error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error";

export function createCircuitBreaker({ store, now = () => Date.now(), threshold = BREAKER_DEFAULTS.threshold, windowMs = BREAKER_DEFAULTS.windowMs, cooldownMs = BREAKER_DEFAULTS.cooldownMs, forcedDown = [], probeLease = null, logger = console, owner = "" } = {}) {
  const kv = store && typeof store.get === "function" && typeof store.put === "function" ? store : memoryStore();
  const errors = { read: 0, write: 0, health: 0, lease: 0 };
  const leaseOwner = owner || crypto.randomUUID();
  function storeError(op, provider, error) {
    errors[op] += 1;
    try { logger.error("psp_breaker_store_error", JSON.stringify({ op, provider, error: errorClass(error), count: errors[op] })); } catch {}
  }
  async function load(provider) {
    let raw;
    try { raw = await kv.get(BREAKER_KEY_PREFIX + provider); } catch (error) { storeError("read", provider, error); return { error: "read_failed" }; }
    if (raw === null || raw === undefined || raw === "") return { failures: [], opened_at: null };
    let rec;
    try { rec = JSON.parse(String(raw)); } catch (error) { storeError("read", provider, error); return { error: "record_unreadable" }; }
    if (!rec || typeof rec !== "object" || !Array.isArray(rec.failures)) { storeError("read", provider, new TypeError("record_shape")); return { error: "record_unreadable" }; }
    return { failures: rec.failures.filter((t) => Number.isFinite(t)), opened_at: Number.isFinite(rec.opened_at) ? rec.opened_at : null };
  }
  async function save(provider, rec) {
    try {
      await kv.put(BREAKER_KEY_PREFIX + provider, JSON.stringify(rec), { expirationTtl: Math.max(60, Math.ceil((windowMs + cooldownMs) / 1000) * 4) });
      return true;
    } catch (error) {
      storeError("write", provider, error);
      return false;
    }
  }
  function view(provider, rec, t) {
    const failures = rec.failures.filter((x) => t - x < windowMs);
    if (rec.opened_at !== null) {
      if (t - rec.opened_at < cooldownMs) return { provider, state: "open", allow: false, failures: failures.length, opened_at: rec.opened_at };
      return { provider, state: "half_open", allow: true, failures: failures.length, opened_at: rec.opened_at };
    }
    return { provider, state: "closed", allow: true, failures: failures.length, opened_at: null };
  }
  async function explicitHealth(provider) {
    if (forcedDown.includes(provider)) return "env";
    let raw;
    try { raw = await kv.get(HEALTH_KEY_PREFIX + provider); } catch (error) { storeError("health", provider, error); return "unknown"; }
    if (raw === null || raw === undefined || raw === "") return "";
    try {
      const status = String(JSON.parse(String(raw))?.status || "").toLowerCase();
      if (status === "down") return "kv";
      if (status === "up") return "";
    } catch {}
    storeError("health", provider, new TypeError("health_unreadable"));
    return "unknown";
  }
  async function state(provider) {
    const rec = await load(provider);
    const health = await explicitHealth(provider);
    if (health === "env" || health === "kv") return { provider, state: "forced_down", allow: false, source: health };
    if (rec.error || health === "unknown") return { provider, state: "unknown", allow: false, reason: rec.error || "health_unreadable" };
    return view(provider, rec, now());
  }
  return Object.freeze({
    state,
    // Decide se ESTA tentativa pode chamar o provedor. primary = é o primeiro provedor do plano.
    async admit(provider, { primary = false } = {}) {
      const s = await state(provider);
      if (s.state === "closed") return { ...s, admitted: true };
      if (s.state === "unknown") return { ...s, admitted: primary === true, reason: primary === true ? "unknown_primary_attempted" : "unknown_fallback_not_opened" };
      if (s.state === "half_open") {
        if (!probeLease || typeof probeLease.acquire !== "function") return { ...s, admitted: false, reason: "probe_coordinator_unavailable" };
        let got = false;
        try { got = (await probeLease.acquire(provider, leaseOwner)) === true; } catch (error) { storeError("lease", provider, error); return { ...s, admitted: false, reason: "probe_lease_error" }; }
        return { ...s, admitted: got, probe: got, reason: got ? "half_open_probe" : "probe_in_flight" };
      }
      return { ...s, admitted: false, reason: s.state };
    },
    async recordFailure(provider, kind) {
      const t = now();
      const rec = await load(provider);
      if (rec.error) return { provider, state: "unknown", persisted: false, reason: rec.error };
      const before = view(provider, rec, t);
      if (!BREAKER_FAILURE_KINDS.includes(kind)) return before;
      const failures = [...rec.failures.filter((x) => t - x < windowMs), t];
      let openedAt = rec.opened_at;
      if (before.state === "half_open") openedAt = t;
      else if (before.state === "closed" && failures.length >= threshold) openedAt = t;
      const next = { failures, opened_at: openedAt };
      const persisted = await save(provider, next);
      return { ...view(provider, next, t), persisted };
    },
    async recordSuccess(provider) {
      const rec = await load(provider);
      if (rec.error) return { provider, state: "unknown", persisted: false, reason: rec.error };
      if (rec.failures.length === 0 && rec.opened_at === null) return view(provider, rec, now());
      const next = { failures: [], opened_at: null };
      const persisted = await save(provider, next);
      return { ...view(provider, next, now()), persisted };
    },
    stats() { return Object.freeze({ store_errors: Object.freeze({ ...errors }) }); },
  });
}

export function breakerFailureKind(out = {}) {
  const body = out?.body || {};
  const http = Number(body.provider_http_status || 0);
  if (http === 429) return "throttled";
  if (http >= 500 && http <= 599) return "5xx";
  if (http >= 400 && http <= 499) return null; // rejeição definitiva do provedor: erro de configuração, não indisponibilidade.
  const text = String(body.provider_error || body.provider_error_code || "");
  const m = text.match(/_(\d{3})(?:_|$)/);
  if (m) {
    const code = Number(m[1]);
    if (code === 429) return "throttled";
    if (code >= 500) return "5xx";
    if (code >= 400) return null;
  }
  if (/abort|timeout|timed out/i.test(text)) return "timeout";
  return "network";
}

export function classifyCheckoutOutcome(out = {}) {
  const status = Number(out?.status || 0);
  const body = out?.body || {};
  const error = String(body.error || "");
  if ((status === 200 || status === 201) && body.accepted === true && /^https:\/\//.test(String(body.checkout_url || ""))) return Object.freeze({ class: "success", breakerFailure: null });
  if (NOT_ATTEMPTED_ERRORS.includes(error)) return Object.freeze({ class: "not_attempted", breakerFailure: null });
  if (AMBIGUOUS_ERRORS.includes(error)) return Object.freeze({ class: "ambiguous", breakerFailure: error === "checkout_provider_uncertain" ? breakerFailureKind(out) : null });
  if (UNAVAILABLE_AFTER_ORDER_ERRORS.includes(error)) return Object.freeze({ class: "terminal", breakerFailure: breakerFailureKind(out) });
  return Object.freeze({ class: "terminal", breakerFailure: null });
}

export function pspCommercialLockOpen(env = {}) {
  return String(env.SALE_GLOBALLY_ENABLED || "").trim().toLowerCase() === "true";
}

export function planPspOrder(candidates = [], { only = null } = {}) {
  const ready = new Set((candidates || []).filter((c) => c && c.ready === true).map((c) => c.provider));
  return PSP_FALLBACK_ORDER.filter((p) => ready.has(p) && (!only || only.includes(p)));
}

export function idempotencyKeyForOrder(orderId) {
  const id = String(orderId || "").trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(id)) return "";
  return `zevanory-order-${id}`;
}

// Orquestra a criação do checkout. `invoke(provider)` devolve {status, body} do handler daquele provedor.
export async function runCheckoutWithFailover({ lockOpen, candidates, breaker, invoke, only = null, log = () => {} } = {}) {
  const plan = planPspOrder(candidates, { only });
  const called = [];
  const skipped = [];
  let locked = false;
  for (const [index, provider] of plan.entries()) {
    const open = (await lockOpen()) === true;
    if (!open) { locked = true; break; }
    const health = await breaker.admit(provider, { primary: index === 0 });
    if (!health.admitted) { skipped.push({ provider, reason: health.state === "forced_down" ? "forced_down" : health.state === "open" ? "circuit_open" : String(health.reason || health.state) }); continue; }
    called.push(provider);
    const out = await invoke(provider);
    const verdict = classifyCheckoutOutcome(out);
    log({ event: "psp_attempt", provider, circuit: health.state, probe: health.probe === true, outcome: verdict.class, breaker_failure: verdict.breakerFailure, http_status: Number(out?.status || 0) });
    if (verdict.class === "success") {
      await breaker.recordSuccess(provider);
      return { status: out.status, body: { ...out.body, provider, failover: plan[0] !== provider, providers_called: called } };
    }
    if (verdict.class === "not_attempted") { skipped.push({ provider, reason: String(out?.body?.error || "not_attempted") }); continue; }
    if (verdict.class === "ambiguous") {
      if (verdict.breakerFailure) await breaker.recordFailure(provider, verdict.breakerFailure);
      return { status: out.status || 503, body: { ...out.body, provider, fallback_suppressed: true, reconciliation_required: true, providers_called: called } };
    }
    if (verdict.breakerFailure) await breaker.recordFailure(provider, verdict.breakerFailure);
    return { status: out.status, body: { ...out.body, provider, providers_called: called } };
  }
  if (locked || (plan.length === 0 && (await lockOpen()) !== true)) {
    return { status: 503, body: { error: "sales_globally_blocked", accepted: false, providers_called: called } };
  }
  return { status: 503, body: { error: "payment_capacity_unavailable", accepted: false, fail_closed: true, providers_called: called, skipped } };
}

// Plano público de continuidade de PSP (sem segredos): só nomes, prontidão e estado do disjuntor.
export async function pspContinuityPlan({ candidates = [], breaker, lockOpen = false, minQuorum = 2 } = {}) {
  const ready = planPspOrder(candidates);
  const circuits = {};
  const usable = [];
  for (const provider of PSP_FALLBACK_ORDER) {
    const s = await breaker.state(provider);
    circuits[provider] = s.state;
    if (ready.includes(provider) && s.allow) usable.push(provider);
  }
  return Object.freeze({
    schema: "zevanory.psp-continuity.v1",
    fallback_order: PSP_FALLBACK_ORDER,
    ready_providers: ready,
    usable_providers: usable,
    circuits,
    min_ready_quorum: minQuorum,
    quorum_ok: ready.length >= minQuorum,
    sales_locked: lockOpen !== true,
    mode: lockOpen !== true ? "sales_locked" : usable.length === 0 ? "fail_closed" : usable.length < minQuorum ? "degraded" : "redundant",
    ambiguous_never_fails_over: true,
    store_errors: typeof breaker.stats === "function" ? breaker.stats().store_errors : null,
  });
}

// Comparação de segredos em tempo constante e independente do comprimento (resumos SHA-256 de 32 bytes).
export function constantTimeEqual(expected, provided) {
  const a = String(expected ?? "");
  const b = String(provided ?? "");
  const da = crypto.createHash("sha256").update(a, "utf8").digest();
  const db = crypto.createHash("sha256").update(b, "utf8").digest();
  const same = crypto.timingSafeEqual(da, db);
  return a.length > 0 && same;
}

export function __resetMemoryStoresForTests() { memoryStores.clear(); }
