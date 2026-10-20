// Trava comercial: invalidação NO PROVEDOR dos links de pagamento pendentes no fechamento das vendas.
// Fechar o interruptor impede NOVAS cobranças, mas não mata links já emitidos: a preferência do
// Mercado Pago continua pagável até expirar. Esta rotina antecipa a expiração de cada preferência
// pendente para agora (PUT /checkout/preferences/{id}). NÃO está ligada a nenhum cron/rota: executar
// em produção é escrita no PSP e exige autorização específica do proprietário.
const MP_API = "https://api.mercadopago.com";
const PREF_ID = /^[A-Za-z0-9-]{4,160}$/;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");

export function closedExpiryPatch(now = Date.now()) {
  // from no passado e to = agora - 1 min: a preferência deixa de aceitar pagamento imediatamente.
  return { expires: true, expiration_date_from: iso(now - 2 * 3600 * 1000), expiration_date_to: iso(now - 60 * 1000) };
}

export async function invalidatePendingMercadoPagoCheckouts(sql, { accessToken, fetchImpl = fetch, now = Date.now(), limit = 50, dryRun = true } = {}) {
  if (!sql?.query) return { ok: false, reason: "storage_unavailable", checked: 0, invalidated: 0, failed: [] };
  const rows = await sql.query(
    `select order_id, provider_checkout_id from orders
      where provider='mercadopago' and status in ('checkout_ready','checkout_uncertain')
        and provider_checkout_id is not null
      order by updated_at asc limit $1`, [Math.max(1, Math.min(200, Number(limit) || 50))]);
  const report = { ok: true, dry_run: dryRun === true, checked: rows.length, invalidated: 0, failed: [], pending: [] };
  for (const row of rows) {
    const id = String(row.provider_checkout_id || "");
    if (!PREF_ID.test(id)) { report.failed.push({ order_id: String(row.order_id), reason: "preference_id_invalid" }); continue; }
    if (dryRun === true) { report.pending.push(String(row.order_id)); continue; }
    if (!String(accessToken || "").trim()) return { ...report, ok: false, reason: "provider_token_unavailable" };
    let ok = false, status = 0;
    try {
      const r = await fetchImpl(`${MP_API}/checkout/preferences/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(closedExpiryPatch(now))
      });
      status = r.status; ok = r.ok;
    } catch { ok = false; }
    if (ok) report.invalidated++; else report.failed.push({ order_id: String(row.order_id), reason: `provider_http_${status || "error"}` });
  }
  if (report.failed.length) report.ok = false;
  return report;
}
