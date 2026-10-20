// Trava comercial: invalidação NO PROVEDOR dos links de pagamento pendentes no fechamento das vendas.
// Fechar o interruptor impede NOVAS cobranças, mas não mata links já emitidos: a preferência do
// Mercado Pago continua pagável até expirar. Esta rotina antecipa a expiração de cada preferência
// pendente para agora (PUT /checkout/preferences/{id}) e CONFIRMA por leitura posterior (GET).
// Percorre a fila inteira por cursor (keyset updated_at, order_id) até esgotar ou atingir o teto.
// Limite conhecido: Pix/boleto já GERADOS seguem o próprio date_of_expiration (ver payment-link-expiry.mjs);
// pagamento concluído é HONRADO (decisão do proprietário 20/10/2026).
// NÃO está ligada a nenhum cron/rota: executar em produção é escrita no PSP e exige autorização.
const MP_API = "https://api.mercadopago.com";
const PREF_ID = /^[A-Za-z0-9-]{4,160}$/;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");

export function closedExpiryPatch(now = Date.now()) {
  return {
    expires: true,
    expiration_date_from: iso(now - 2 * 3600 * 1000),
    expiration_date_to: iso(now - 60 * 1000),
    date_of_expiration: iso(now - 60 * 1000)
  };
}

export function preferenceIsClosed(pref, now = Date.now()) {
  const to = Date.parse(String(pref?.expiration_date_to || ""));
  return pref?.expires === true && Number.isFinite(to) && to <= now;
}

async function closeOne(id, { accessToken, fetchImpl, now }) {
  const url = `${MP_API}/checkout/preferences/${encodeURIComponent(id)}`;
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  let put;
  try { put = await fetchImpl(url, { method: "PUT", headers, body: JSON.stringify(closedExpiryPatch(now)) }); }
  catch { return "provider_put_error"; }
  if (!put?.ok) return `provider_http_${put?.status || "error"}`;
  // Confirmação: 2xx não basta; o estado efetivo precisa ser lido de volta do provedor.
  let get;
  try { get = await fetchImpl(url, { method: "GET", headers: { authorization: headers.authorization } }); }
  catch { return "provider_readback_error"; }
  if (!get?.ok) return `provider_readback_http_${get?.status || "error"}`;
  let body = null;
  try { body = await get.json(); } catch { return "provider_readback_invalid"; }
  return preferenceIsClosed(body, now) ? "closed" : "provider_not_closed";
}

export async function invalidatePendingMercadoPagoCheckouts(sql, { accessToken, fetchImpl = fetch, now = Date.now(), pageSize = 50, maxTotal = 1000, dryRun = true } = {}) {
  if (!sql?.query) return { ok: false, reason: "storage_unavailable", checked: 0, invalidated: 0, failed: [], exhausted: false };
  if (dryRun !== true && !String(accessToken || "").trim()) return { ok: false, reason: "provider_token_unavailable", checked: 0, invalidated: 0, failed: [], exhausted: false };
  const size = Math.max(1, Math.min(200, Number(pageSize) || 50));
  const cap = Math.max(1, Math.min(10000, Number(maxTotal) || 1000));
  const report = { ok: true, dry_run: dryRun === true, checked: 0, invalidated: 0, failed: [], pending: [], pages: 0, exhausted: false };
  let cursor = { at: "1970-01-01T00:00:00Z", id: "00000000-0000-0000-0000-000000000000" };
  while (report.checked < cap) {
    // Nunca ultrapassa o teto: a página é reduzida ao que resta de maxTotal.
    const want = Math.min(size, cap - report.checked);
    const rows = await sql.query(
      `select order_id, provider_checkout_id, updated_at::text as cursor_at from orders
        where provider='mercadopago' and status in ('checkout_ready','checkout_uncertain')
          and provider_checkout_id is not null
          and (updated_at, order_id::text) > ($1::timestamptz, $2::text)
        order by updated_at asc, order_id::text asc limit $3`, [cursor.at, cursor.id, want]);
    report.pages++;
    for (const row of rows) {
      report.checked++;
      const id = String(row.provider_checkout_id || "");
      if (!PREF_ID.test(id)) { report.failed.push({ order_id: String(row.order_id), reason: "preference_id_invalid" }); continue; }
      if (dryRun === true) { report.pending.push(String(row.order_id)); continue; }
      const result = await closeOne(id, { accessToken, fetchImpl, now });
      if (result === "closed") report.invalidated++; else report.failed.push({ order_id: String(row.order_id), reason: result });
    }
    // Página incompleta = fila esgotada. Página cheia exige nova consulta para provar o esgotamento.
    if (rows.length < want) { report.exhausted = true; break; }
    const last = rows[rows.length - 1];
    // Cursor com a precisão do banco (microssegundos, texto); Date do JS truncaria e repetiria linhas.
    cursor = { at: String(last.cursor_at), id: String(last.order_id) };
  }
  // Teto atingido com página cheia: uma consulta de 1 registro decide se ainda há pendentes.
  if (!report.exhausted && report.checked >= cap) {
    const more = await sql.query(
      `select order_id from orders
        where provider='mercadopago' and status in ('checkout_ready','checkout_uncertain')
          and provider_checkout_id is not null
          and (updated_at, order_id::text) > ($1::timestamptz, $2::text)
        order by updated_at asc, order_id::text asc limit $3`, [cursor.at, cursor.id, 1]);
    report.exhausted = more.length === 0;
  }
  if (report.failed.length || !report.exhausted) report.ok = false;
  return report;
}
