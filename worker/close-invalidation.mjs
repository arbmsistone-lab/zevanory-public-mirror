// Trava comercial: invalidação NO PROVEDOR dos links de pagamento pendentes no fechamento das vendas.
// Fechar o interruptor impede NOVAS cobranças, mas não mata links já emitidos: a preferência do
// Mercado Pago continua pagável até expirar. Esta rotina antecipa a expiração de cada preferência
// pendente para agora (PUT /checkout/preferences/{id}) e CONFIRMA por leitura posterior (GET).
// Percorre a fila inteira por cursor (keyset updated_at, order_id) até esgotar ou atingir o teto.
// Limite conhecido: Pix/boleto já GERADOS seguem o próprio date_of_expiration (ver payment-link-expiry.mjs);
// pagamento concluído é HONRADO (decisão do proprietário 20/10/2026).
// Também: cancelPendingMercadoPagoPayments cancela Pix/boleto emitidos e pagamentos em processamento.
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

// Varredura comum dos pedidos Mercado Pago pendentes: cursor keyset (updated_at::text, order_id) até esgotar
// ou atingir o teto, sem nunca ultrapassá-lo; página cheia exige consulta extra para provar o esgotamento.
const PENDING_SQL = `select order_id, provider_checkout_id, updated_at::text as cursor_at from orders
        where provider='mercadopago' and status in ('checkout_ready','checkout_uncertain')
          and provider_checkout_id is not null
          and (updated_at, order_id::text) > ($1::timestamptz, $2::text)
        order by updated_at asc, order_id::text asc limit $3`;
async function scanPendingOrders(sql, { pageSize = 50, maxTotal = 1000 } = {}, perRow) {
  const size = Math.max(1, Math.min(200, Number(pageSize) || 50));
  const cap = Math.max(1, Math.min(10000, Number(maxTotal) || 1000));
  const scan = { checked: 0, pages: 0, exhausted: false };
  let cursor = { at: "1970-01-01T00:00:00Z", id: "00000000-0000-0000-0000-000000000000" };
  while (scan.checked < cap) {
    // Nunca ultrapassa o teto: a página é reduzida ao que resta de maxTotal.
    const want = Math.min(size, cap - scan.checked);
    const rows = await sql.query(PENDING_SQL, [cursor.at, cursor.id, want]);
    scan.pages++;
    for (const row of rows) { scan.checked++; await perRow(row); }
    // Página incompleta = fila esgotada. Página cheia exige nova consulta para provar o esgotamento.
    if (rows.length < want) { scan.exhausted = true; break; }
    const last = rows[rows.length - 1];
    // Cursor com a precisão do banco (microssegundos, texto); Date do JS truncaria e repetiria linhas.
    cursor = { at: String(last.cursor_at), id: String(last.order_id) };
  }
  if (!scan.exhausted && scan.checked >= cap) scan.exhausted = (await sql.query(PENDING_SQL, [cursor.at, cursor.id, 1])).length === 0;
  return scan;
}

export async function invalidatePendingMercadoPagoCheckouts(sql, { accessToken, fetchImpl = fetch, now = Date.now(), pageSize = 50, maxTotal = 1000, dryRun = true } = {}) {
  if (!sql?.query) return { ok: false, reason: "storage_unavailable", checked: 0, invalidated: 0, failed: [], exhausted: false };
  if (dryRun !== true && !String(accessToken || "").trim()) return { ok: false, reason: "provider_token_unavailable", checked: 0, invalidated: 0, failed: [], exhausted: false };
  const report = { ok: true, dry_run: dryRun === true, checked: 0, invalidated: 0, failed: [], pending: [], pages: 0, exhausted: false };
  const scan = await scanPendingOrders(sql, { pageSize, maxTotal }, async (row) => {
    const id = String(row.provider_checkout_id || "");
    if (!PREF_ID.test(id)) { report.failed.push({ order_id: String(row.order_id), reason: "preference_id_invalid" }); return; }
    if (dryRun === true) { report.pending.push(String(row.order_id)); return; }
    const result = await closeOne(id, { accessToken, fetchImpl, now });
    if (result === "closed") report.invalidated++; else report.failed.push({ order_id: String(row.order_id), reason: result });
  });
  Object.assign(report, scan);
  if (report.failed.length || !report.exhausted) report.ok = false;
  return report;
}

// ---- Caso (ii)/(iii) da Ordem 017-A: Pix/boleto JÁ EMITIDO e pagamento em processamento ----
// A expiração da preferência NÃO cancela um pagamento já criado a partir dela. Documentação Mercado Pago:
// PUT /v1/payments/{id} {"status":"cancelled"} só vale para pending, in_process ou authorized (erro 400/2018
// se o status não permitir). Pagamento APROVADO nunca é cancelado aqui: a política do proprietário é honrar.
// Corrida: se aprovar entre a busca e o cancelamento, a releitura mostra approved => "honrado", não falha.
const CANCELLABLE = new Set(["pending", "in_process", "authorized"]);
const PAYMENT_ID = /^[0-9]{1,20}$/;
async function readJson(fetchImpl, url, init) {
  let r; try { r = await fetchImpl(url, init); } catch { return { ok: false, status: 0 }; }
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { ok: Boolean(r?.ok), status: r?.status || 0, body };
}
export async function cancelPendingMercadoPagoPayments(sql, { accessToken, fetchImpl = fetch, pageSize = 50, maxTotal = 1000, dryRun = true } = {}) {
  if (!sql?.query) return { ok: false, reason: "storage_unavailable", checked: 0, cancelled: 0, honored: [], failed: [], exhausted: false };
  if (dryRun !== true && !String(accessToken || "").trim()) return { ok: false, reason: "provider_token_unavailable", checked: 0, cancelled: 0, honored: [], failed: [], exhausted: false };
  const auth = { authorization: `Bearer ${accessToken}` };
  const report = { ok: true, dry_run: dryRun === true, checked: 0, cancelled: 0, honored: [], failed: [], to_cancel: [], pages: 0, exhausted: false };
  const scan = await scanPendingOrders(sql, { pageSize, maxTotal }, async (row) => {
    const orderId = String(row.order_id);
    if (dryRun === true) { report.to_cancel.push({ order_id: orderId }); return; }
    const q = new URL(`${MP_API}/v1/payments/search`);
    q.searchParams.set("external_reference", orderId.toLowerCase()); q.searchParams.set("sort", "date_created"); q.searchParams.set("criteria", "desc");
    const found = await readJson(fetchImpl, q.toString(), { method: "GET", headers: auth });
    if (!found.ok || !Array.isArray(found.body?.results)) { report.failed.push({ order_id: orderId, reason: `search_http_${found.status || "error"}` }); return; }
    for (const p of found.body.results) {
      const pid = String(p?.id ?? ""), st = String(p?.status || "");
      if (String(p?.external_reference || "").toLowerCase() !== orderId.toLowerCase()) continue;   // nunca agir em pagamento de outro pedido
      if (st === "approved") { report.honored.push({ order_id: orderId, payment_id: pid }); continue; }
      if (!CANCELLABLE.has(st)) continue;                                                            // cancelled/rejected/refunded: nada a fazer
      if (!PAYMENT_ID.test(pid)) { report.failed.push({ order_id: orderId, reason: "payment_id_invalid" }); continue; }
      const url = `${MP_API}/v1/payments/${pid}`;
      await readJson(fetchImpl, url, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) });
      // Releitura decide (o código HTTP do PUT sozinho não prova o estado).
      const after = await readJson(fetchImpl, url, { method: "GET", headers: auth });
      const now = String(after.body?.status || "");
      if (after.ok && now === "cancelled") report.cancelled++;
      else if (after.ok && now === "approved") report.honored.push({ order_id: orderId, payment_id: pid, race: true });
      else report.failed.push({ order_id: orderId, payment_id: pid, reason: after.ok ? `provider_status_${now || "unknown"}` : `readback_http_${after.status || "error"}` });
    }
  });
  Object.assign(report, scan);
  if (report.failed.length || !report.exhausted) report.ok = false;
  return report;
}
