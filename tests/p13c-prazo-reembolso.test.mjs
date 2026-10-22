// P13c (FINANCEIRO, revisão do Sol): o prazo de arrependimento aplicado por worker/refund-flow.mjs segue
// a regra publicada em data/politica-unica.json — 7 dias corridos a partir da data MAIS RECENTE entre a
// confirmação do pagamento e o primeiro recebimento (e-mail de entrega enviado ou primeiro download);
// sem recebimento registrado o prazo não começou. Antes contava de paid_at (mais restritivo que a política).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const P = JSON.parse(readFileSync(join(ROOT, "data/politica-unica.json"), "utf8"));
const DAY = 86_400_000, HOUR = 3_600_000;
const OID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EMAIL = "cliente@example.com";
// 2026-10-05 10:00 em Brasília (UTC-3) = 13:00Z.
const T0 = Date.parse("2026-10-05T13:00:00Z");

function checkWindow(refundWindow) {
  const w = (o) => refundWindow(o);
  // Entrega atrasada: dia 8 depois do pagamento, dia 3 depois do recebimento => dentro do prazo.
  assert.equal(w({ paidAt: T0, deliveredAt: T0 + 5 * DAY, now: T0 + 8 * DAY }).eligible, true, "entrega tardia conta do recebimento");
  // Primeiro download também é recebimento (o mais cedo entre e-mail e download).
  assert.equal(w({ paidAt: T0, firstDownloadAt: T0 + 5 * DAY, now: T0 + 8 * DAY }).eligible, true, "download como recebimento");
  // Recebimento = o PRIMEIRO evento: download antes do e-mail registrado conta do download.
  assert.equal(w({ paidAt: T0, deliveredAt: T0 + 5 * DAY, firstDownloadAt: T0 + HOUR, now: T0 + 8 * DAY + 2 * HOUR }).eligible, false, "primeiro recebimento (download) define o início");
  // Dia 8 depois de pagamento e recebimento => fora do prazo.
  assert.equal(w({ paidAt: T0, deliveredAt: T0 + HOUR, now: T0 + 8 * DAY + 2 * HOUR }).eligible, false, "dia 8 depois dos dois");
  // Sem recebimento: o prazo não começou.
  const none = w({ paidAt: T0, now: T0 + 30 * DAY });
  assert.equal(none.eligible, true); assert.equal(none.started, false);
  // Limites (fim do 7º dia corrido, 23:59:59.999 em Brasília).
  const start = T0 + HOUR; // recebido às 11:00 de 05/10 (Brasília)
  const lastMs = Date.parse("2026-10-13T02:59:59.999Z"); // 12/10 23:59:59.999 em Brasília
  assert.equal(w({ paidAt: T0, deliveredAt: start, now: lastMs }).eligible, true, "último instante do 7º dia");
  assert.equal(w({ paidAt: T0, deliveredAt: start, now: lastMs + 1 }).eligible, false, "primeiro instante do 8º dia");
  assert.equal(w({ paidAt: T0, deliveredAt: start, now: start + 7 * DAY }).eligible, true, "nunca menos que 7 x 24 h");
  assert.equal(w({ paidAt: T0, deliveredAt: start, now: lastMs }).ends_at, "2026-10-13T02:59:59.999Z");
  // Recebimento antes da confirmação do pagamento: vale a confirmação (a mais recente).
  assert.equal(w({ paidAt: T0 + 2 * DAY, deliveredAt: T0, now: T0 + 9 * DAY + HOUR }).eligible, true, "a mais recente entre as duas");
}

function fixture({ paidAt, deliveredAt = null, firstDownloadAt = null }) {
  const state = new Map();
  const kv = { get: async (k) => state.get(k) ?? null, put: async (k, v) => { state.set(k, v); }, list: async () => ({ keys: [], list_complete: true }) };
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://mock.invalid/x" };
  const sqlFactory = () => ({ query: async (statement) => {
    if (/from orders o/.test(statement)) return [{ order_id: OID, status: "paid", amount: 197, offer_id: "ZEV-IA-011", certification_pilot: true, payment_id: "123", paid_at: new Date(paidAt).toISOString(),
      delivered_at: /delivered_at/.test(statement) && deliveredAt ? new Date(deliveredAt).toISOString() : null,
      first_download_at: /used_at/.test(statement) && firstDownloadAt ? new Date(firstDownloadAt).toISOString() : null }];
    if (/select evidence_ref from service_fulfillment/.test(statement)) return [{ evidence_ref: JSON.stringify({ email_recipient: EMAIL }) }];
    return [];
  } });
  return { state, env, sqlFactory };
}
async function request(handleRefundFlow, f) {
  const res = await handleRefundFlow(new Request("https://zevanory.api.br/api/support/refund-request", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113." + Math.floor(Math.random() * 200) }, body: JSON.stringify({ order_id: OID, email: EMAIL }) }), f.env, { sqlFactory: f.sqlFactory });
  return { status: res.status, body: await res.json(), stored: f.state.has("refund:req:" + OID) };
}
async function checkFlow(handleRefundFlow) {
  const now = Date.now();
  const late = await request(handleRefundFlow, fixture({ paidAt: now - 8 * DAY, deliveredAt: now - 3 * DAY }));
  assert.equal(late.status, 200, "pagamento há 8 dias, entrega há 3: aceito"); assert.equal(late.stored, true);
  const out = await request(handleRefundFlow, fixture({ paidAt: now - 9 * DAY, deliveredAt: now - 9 * DAY + HOUR }));
  assert.equal(out.status, 409, "dia 9 depois dos dois: fora do prazo");
  assert.equal(out.body.error, "fora_do_prazo"); assert.equal(out.body.route, "suporte", "encaminhado ao suporte");
  assert.equal(out.stored, false, "nunca registrado como reembolso (nem aprovado automaticamente)");
  assert.ok(out.body.message.includes(P.customer_wording.rule_7d));
  const none = await request(handleRefundFlow, fixture({ paidAt: now - 30 * DAY }));
  assert.equal(none.status, 200, "sem recebimento: o prazo não começou"); assert.equal(none.stored, true);
  const dl = await request(handleRefundFlow, fixture({ paidAt: now - 10 * DAY, firstDownloadAt: now - 2 * DAY }));
  assert.equal(dl.status, 200, "primeiro download há 2 dias: aceito");
}

test("P13c prazo: começa na data mais recente entre pagamento e recebimento, limites do 7º dia corrido", async () => {
  const { refundWindow, REFUND_WINDOW } = await import("../worker/politica-unica.mjs");
  assert.equal(REFUND_WINDOW.days, 7);
  assert.ok(P.sol_text.includes(P.refund_window.fragmento_sol), "regra da 'mais recente' vem do texto único");
  checkWindow(refundWindow);
});

test("P13c prazo: pedido real de reembolso segue a regra publicada (entrega tardia aceita, fora do prazo vai ao suporte)", async () => {
  const { handleRefundFlow } = await import("../worker/refund-flow.mjs");
  await checkFlow(handleRefundFlow);
  const src = readFileSync(join(ROOT, "worker/refund-flow.mjs"), "utf8");
  assert.doesNotMatch(src, /WINDOW_MS|paid_at\)\.getTime\(\) >/, "nenhuma janela contada só do pagamento");
});

test("P13c prazo mutantes: contar de paid_at, ignorar a entrega, ignorar o download e janela antiga são mortos", async () => {
  const mutants = {
    "R1 conta só de paid_at": ["worker/politica-unica.mjs", (s) => s.replace("const start = Math.max(paid, receipt);", "const start = paid;"), "window"],
    "R2 ignora a entrega por e-mail": ["worker/politica-unica.mjs", (s) => s.replace("[toMs(deliveredAt), toMs(firstDownloadAt)]", "[toMs(firstDownloadAt)]"), "window"],
    "R3 ignora o download": ["worker/politica-unica.mjs", (s) => s.replace("[toMs(deliveredAt), toMs(firstDownloadAt)]", "[toMs(deliveredAt)]"), "window"],
    "R4 sem recebimento = prazo do pagamento": ["worker/politica-unica.mjs", (s) => s.replace('if (!receipts.length) return { eligible: true,', 'if (!receipts.length) return { eligible: toMs(now) - paid <= 7 * DAY_MS,'), "window"],
    "R5 janela de 7 x 24 h exatas": ["worker/politica-unica.mjs", (s) => s.replace("const deadline = (localDay + Number(REFUND_WINDOW.days) + 1) * DAY_MS - 1 - off;", "const deadline = start + 7 * DAY_MS;"), "window"],
    "R6 fluxo volta a contar de paid_at": ["worker/refund-flow.mjs", (s) => s.replace("if (!window.eligible) {", "if (Date.now() - new Date(order.paid_at).getTime() > 7 * 86400000) {"), "flow"],
    "R7 fluxo não lê a entrega": ["worker/refund-flow.mjs", (s) => s.replace("deliveredAt: order.delivered_at, firstDownloadAt: order.first_download_at", "deliveredAt: null, firstDownloadAt: null"), "flow"],
    "R8 fora do prazo registrado como pedido": ["worker/refund-flow.mjs", (s) => s.replace("if (!window.eligible) {", "if (false) {"), "flow"],
  };
  const report = [];
  for (const [name, [file, fn, kind]] of Object.entries(mutants)) {
    const dir = mkdtempSync(join(tmpdir(), "p13c-prazo-"));
    try {
      for (const d of ["worker", "data"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
      const target = join(dir, file), before = readFileSync(target, "utf8"), after = fn(before);
      assert.notEqual(after, before, "mutação não aplicada: " + name);
      writeFileSync(target, after);
      const load = (f) => import(pathToFileURL(join(dir, f)).href + "?m=" + encodeURIComponent(name));
      let killed = false, why = "";
      try {
        if (kind === "window") checkWindow((await load("worker/politica-unica.mjs")).refundWindow);
        else await checkFlow((await load("worker/refund-flow.mjs")).handleRefundFlow);
      } catch (e) { killed = true; why = String(e.message).split("\n")[0].slice(0, 100); }
      report.push(`${name}: ${killed ? "KILLED" : "SURVIVED"} ${why}`);
      assert.ok(killed, name + " sobreviveu");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(report.join("\n"));
});
