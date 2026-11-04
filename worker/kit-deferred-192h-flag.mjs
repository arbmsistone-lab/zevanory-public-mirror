// DEC-06 (consenso Claude + GPT-6): na fase 1, após a aprovação do pagamento pela Hotmart, o comprador recebe o
// produto INTEGRAL imediatamente, para download na área de compras da Hotmart (Minhas compras). Não há retenção de
// 192 h, link externo da ZEVANORY nem limite de cinco downloads.
// A liberação diferida (worker/kit-release-192h.mjs, worker/kit-nc015-*.mjs e worker/kit-hotmart-identity.mjs) fica
// PRESERVADA, mas INATIVA atrás desta flag. Fail-closed: só liga com o valor EXATO "true" (ou o booleano true) em
// env.KIT_DEFERRED_192H_ENABLED; ausente, vazio, "1", "TRUE", "yes" ou qualquer outro valor = desligada. Mesmo ligada,
// as travas de código KIT_DOWNLOAD_ENABLED / KIT_ORDER_INGEST_ENABLED / KIT_RESEND_CONSUMER_ENABLED (false) continuam
// exigidas nas rotas públicas: reativar exige mudança de código e nova decisão do proprietário.
export const KIT_DEFERRED_192H_FLAG = "KIT_DEFERRED_192H_ENABLED";
export const KIT_DEFERRED_192H_DEFAULT = false;
export function kitDeferred192hEnabled(env) {
  const value = env?.[KIT_DEFERRED_192H_FLAG];
  if (value === true || value === "true") return true;
  return KIT_DEFERRED_192H_DEFAULT;
}
export function kitDeferred192hDisabledResponse() {
  return Response.json({ ok: false, error: "kit_deferred_192h_disabled" },
    { status: 503, headers: { "cache-control": "no-store, private, max-age=0", "x-content-type-options": "nosniff" } });
}
