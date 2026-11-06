// R9 (roteiro v4.7; auditoria Sol 164 §4): credencial de OPERADOR da produção com nome e escopo próprios.
//
// Até aqui o Worker de produção autenticava backup, voz, WhatsApp, auditoria financeira, prova de canais e as rotas
// internas com CERTIFICATION_E2E_TOKEN: um nome de certificação (sandbox) amarrado à produção. A credencial passa a se
// chamar ZEVANORY_OPERATOR_TOKEN e TODO consumidor do Worker lê por aqui (resolveOperatorToken/operatorToken).
//
// TRANSIÇÃO (dual-read): na produção vale primeiro ZEVANORY_OPERATOR_TOKEN; só se ele estiver AUSENTE o Worker cai para
// o nome antigo e registra uma categoria não secreta ("operator_token_source" / legacy_fallback), uma vez por isolate.
// O valor nunca é registrado. Um ZEVANORY_OPERATOR_TOKEN presente porém curto NÃO cai para o antigo: os consumidores o
// recusam (fail-closed), para que um valor novo malformado nunca seja mascarado pelo antigo.
// Retirada da queda: PR de seguimento troca OPERATOR_TOKEN_LEGACY_FALLBACK para false (e apaga o ramo) depois que o
// readback /api/internal/audit/credential-identity provar operator_token_source=primary na produção.
//
// Perímetro de certificação (certification-worker.mjs -> zevanory-certification): lá CERTIFICATION_E2E_TOKEN é a
// credencial legítima e própria do Worker de certificação, e continua sendo lida pelo nome dela, sem aviso. O perímetro
// só é reconhecido com as duas marcas que prepare-certification-config.py grava E sem nenhum nome exclusivo da produção
// (incluindo ZEVANORY_OPERATOR_TOKEN), então a produção nunca é confundida com o perímetro.

export const OPERATOR_TOKEN_NAME = "ZEVANORY_OPERATOR_TOKEN";
export const LEGACY_OPERATOR_TOKEN_NAME = "CERTIFICATION_E2E_TOKEN";
export const OPERATOR_TOKEN_LEGACY_FALLBACK = true;

// Nomes que só existem na produção: a presença de qualquer um deles desqualifica o perímetro de certificação.
export const PRODUCTION_ONLY_NAMES = Object.freeze([
  OPERATOR_TOKEN_NAME, "MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET", "MERCADOPAGO_PUBLIC_KEY",
  "STRIPE_SECRET_KEY", "ASAAS_API_KEY",
]);

const text = (value) => (value === undefined || value === null ? "" : String(value));
const present = (env, name) => {
  const value = env?.[name];
  return value !== undefined && value !== null && String(value) !== "";
};

export function isCertificationPerimeter(env) {
  if (!env || typeof env !== "object") return false;
  if (text(env.ZEVANORY_DEPLOYMENT_ENV) !== "certification") return false;
  if (text(env.CERTIFICATION_WORKER_NAME) !== "zevanory-certification") return false;
  return PRODUCTION_ONLY_NAMES.every((name) => !present(env, name));
}

let fallbackUses = 0;
let fallbackLogged = false;

export function resolveOperatorToken(env, { log = console, count = true } = {}) {
  if (!env || typeof env !== "object") return Object.freeze({ token: "", source: "absent" });
  if (isCertificationPerimeter(env)) {
    const token = text(env[LEGACY_OPERATOR_TOKEN_NAME]);
    return Object.freeze({ token, source: token ? "certification" : "absent" });
  }
  const primary = text(env[OPERATOR_TOKEN_NAME]);
  if (primary) return Object.freeze({ token: primary, source: "primary" });
  if (OPERATOR_TOKEN_LEGACY_FALLBACK) {
    const legacy = text(env[LEGACY_OPERATOR_TOKEN_NAME]);
    if (legacy) {
      if (count) fallbackUses += 1;
      if (count && !fallbackLogged) {
        fallbackLogged = true;
        try {
          log?.warn?.("operator_token_source", JSON.stringify({ category: "legacy_fallback", name: LEGACY_OPERATOR_TOKEN_NAME, expected: OPERATOR_TOKEN_NAME }));
        } catch {}
      }
      return Object.freeze({ token: legacy, source: "legacy_fallback" });
    }
  }
  return Object.freeze({ token: "", source: "absent" });
}

export function operatorToken(env) {
  return resolveOperatorToken(env).token;
}

// JANELA DE MIGRAÇÃO (Sol 233): o proprietário cria um valor NOVO para ZEVANORY_OPERATOR_TOKEN (não é cópia do antigo,
// que não pode ser lido em lugar nenhum). Com o nome novo presente o Worker usaria só ele e derrubaria todo cliente que
// ainda manda o valor antigo. Durante uma janela EXPLÍCITA e com data de fim, a verificação aceita os dois valores
// (comparação em tempo constante, sempre contra todos os candidatos). Fora da janela, ou sem a flag, vale exatamente o
// comportamento anterior: o nome novo, se presente, é o único aceito (queda para o antigo só na ausência do novo).
//   - flag não secreta OPERATOR_TOKEN_MIGRATION_UNTIL=AAAA-MM-DD (var do Worker ou chave de ZEVANORY_RUNTIME_CONFIG,
//     gravada pelo deploy a partir de vars.OPERATOR_TOKEN_MIGRATION_UNTIL); aberta até 23:59:59.999Z desse dia;
//   - teto em CÓDIGO (MIGRATION_CODE_CEILING): data acima do teto não abre a janela (o PR A2 apaga a janela inteira);
//   - flag ausente, malformada, vencida ou acima do teto = janela fechada (comportamento de hoje);
//   - só categorias são registradas (primary | legacy | legacy_fallback | certification | operator_token | none),
//     nunca valor, tamanho ou hash.
export const MIGRATION_FLAG_NAME = "OPERATOR_TOKEN_MIGRATION_UNTIL";
export const MIGRATION_CODE_CEILING = "2026-12-31";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function runtimeConfigValue(env, name) {
  let cfg = env?.ZEVANORY_RUNTIME_CONFIG;
  if (typeof cfg === "string") {
    try { cfg = JSON.parse(cfg); } catch { return undefined; }
  }
  return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg[name] : undefined;
}

export function migrationDayEnd(day) {
  if (!ISO_DAY.test(day)) return NaN;
  const t = Date.parse(day + "T23:59:59.999Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day ? t : NaN;
}

export function operatorTokenMigration(env, { now = Date.now() } = {}) {
  const direct = env?.[MIGRATION_FLAG_NAME];
  const value = text(direct !== undefined && direct !== null && String(direct) !== "" ? direct : runtimeConfigValue(env, MIGRATION_FLAG_NAME)).trim();
  if (!value) return Object.freeze({ open: false, state: "absent" });
  const until = migrationDayEnd(value);
  if (!Number.isFinite(until)) return Object.freeze({ open: false, state: "invalid" });
  if (value > MIGRATION_CODE_CEILING) return Object.freeze({ open: false, state: "beyond_code_ceiling" });
  if (now > until) return Object.freeze({ open: false, state: "expired" });
  return Object.freeze({ open: true, state: "open", until: value });
}

// Candidatos aceitos para VERIFICAR uma credencial recebida (nunca para enviar): o resolvido de sempre e, só dentro da
// janela e com o nome novo presente, o valor antigo como "legacy".
export function operatorCredentialCandidates(env, { now = Date.now(), count = true, log = console } = {}) {
  const resolved = resolveOperatorToken(env, { count, log });
  if (!resolved.token) return [];
  const list = [{ token: resolved.token, category: resolved.source }];
  if (resolved.source === "primary" && operatorTokenMigration(env, { now }).open) {
    const legacy = text(env[LEGACY_OPERATOR_TOKEN_NAME]);
    if (legacy && legacy !== resolved.token) list.push({ token: legacy, category: "legacy" });
  }
  return list;
}

export function constantTimeEqual(a, b) {
  const x = text(a), y = text(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) | 0) ^ (y.charCodeAt(i) | 0);
  return diff === 0 && x.length > 0;
}

const authCounts = { primary: 0, legacy: 0, legacy_fallback: 0, certification: 0, operator_token: 0, none: 0 };
const authLogged = new Set();
export function recordOperatorAuth(category, { log = console } = {}) {
  const key = Object.prototype.hasOwnProperty.call(authCounts, category) ? category : "none";
  authCounts[key] += 1;
  if (!authLogged.has(key)) {
    authLogged.add(key);
    try { (key === "legacy" ? log?.warn : log?.info)?.call(log, "operator_token_auth", JSON.stringify({ category: key })); } catch {}
  }
  return key;
}
export function operatorAuthCounts() {
  return { ...authCounts };
}

// Verifica a credencial recebida contra TODOS os candidatos (sem atalho) e devolve a categoria aceita ou "" (recusa).
// minLength: comprimento mínimo do valor esperado (cada consumidor mantém o seu de hoje). fallbackToken: credencial
// alternativa que alguns consumidores já aceitavam SÓ na ausência da de operador (OPERATOR_TOKEN).
export function verifyOperatorToken(env, provided, { minLength = 32, now = Date.now(), fallbackToken = "", log = console } = {}) {
  let list = operatorCredentialCandidates(env, { now, log });
  if (!list.length && text(fallbackToken)) list = [{ token: text(fallbackToken), category: "operator_token" }];
  let hit = "";
  for (const c of list) {
    const ok = c.token.length >= minLength && constantTimeEqual(c.token, provided);
    if (ok && !hit) hit = c.category;
  }
  recordOperatorAuth(hit || "none", { log });
  return hit;
}

// Categoria não secreta para o readback (nunca o valor nem o tamanho).
export function operatorTokenSource(env) {
  return resolveOperatorToken(env, { log: null, count: false }).source;
}

export function operatorTokenFallbackUses() {
  return fallbackUses;
}
