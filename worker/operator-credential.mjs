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

// Categoria não secreta para o readback (nunca o valor nem o tamanho).
export function operatorTokenSource(env) {
  return resolveOperatorToken(env, { log: null, count: false }).source;
}

export function operatorTokenFallbackUses() {
  return fallbackUses;
}
