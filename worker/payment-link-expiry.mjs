// Trava comercial: link de pagamento do Mercado Pago expira no próprio provedor.
// Sem isso, uma preferência criada enquanto as vendas estavam abertas continua pagável
// indefinidamente (e-mail antigo, histórico, captura de tela), mesmo depois de fechar as vendas.
// date_of_expiration limita também Pix/boleto gerados a partir da preferência (vencimento próprio
// do meio de pagamento, distinto da vigência da preferência — documentação Mercado Pago).
export const MERCADOPAGO_PREFERENCE_TTL_MS = 24 * 3600 * 1000;
export function mercadoPagoExpiryWindow(now = Date.now()) {
  const start = Number.isFinite(Number(now)) && now !== null ? Number(now) : Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");
  const to = iso(start + MERCADOPAGO_PREFERENCE_TTL_MS);
  return { expires: true, expiration_date_from: iso(start - 60000), expiration_date_to: to, date_of_expiration: to };
}
