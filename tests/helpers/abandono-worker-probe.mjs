// Sonda (sem rede) do Worker central REAL (cloudflare-worker.compat.mjs) com o código do abandono no estágio do fonte
// ("desligado"): (1) o evento de abandono com hottok válido em /api/webhooks/hotmart; (2) o cron horário às 06 UTC com
// D1 espião, SELF espião e LEAD_PRIVACY_SECRET presentes. Registra rotas SELF chamadas e acessos ao D1/KV do abandono.
// Rodar: node --import ./tests/t4_sim/register.mjs tests/helpers/abandono-worker-probe.mjs
import net from "node:net";
// O bundle recuperado abre um servidor Node fixo na porta 8788 ao ser importado (handleAsNodeRequest encaminha a ele
// pelo fetch, aqui falso). Sem bind: processos de teste em paralelo não disputam a porta (EADDRINUSE) e esta sonda não
// a ocupa para a sonda do suporte (tests/helpers/support-drain-scheduled-probe.mjs).
net.Server.prototype.listen = function () { return this; };
const events = [];
globalThis.fetch = async () => { events.push("net"); return new Response("{}", { status: 503 }); };
const { default: worker } = await import("../../worker/cloudflare-worker.compat.mjs");
const d1Calls = [];
const DIARIO = { prepare(sql) { d1Calls.push(String(sql)); throw new Error("D1 indisponível na sonda"); }, withSession() { d1Calls.push("withSession"); throw new Error("x"); }, batch() { d1Calls.push("batch"); throw new Error("x"); } };
const kvKeys = [];
const m = new Map();
const KV = { async get(k) { kvKeys.push("get:" + k); return m.get(k) ?? null; }, async put(k, v) { kvKeys.push("put:" + k); m.set(k, v); }, async delete(k) { kvKeys.push("del:" + k); m.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
const selfPaths = [];
const HOTTOK = "test-hottok-" + "h".repeat(12); // sintético, gerado em runtime
const env = {
  HOTMART_HOTTOK: HOTTOK, LEAD_PRIVACY_SECRET: "test-privacy-" + "p".repeat(36), RESEND_API_KEY: "test-resend-" + "r".repeat(4),
  DIARIO, ZEVANORY_PRIVATE_ARTIFACTS: KV,
  SELF: { async fetch(req) { selfPaths.push(new URL(req.url).pathname); return new Response("{}", { status: 503 }); } },
};
const payload = { id: "evt-sonda", event: "PURCHASE_OUT_OF_SHOPPING_CART", version: "2.0.0", data: { product: { id: 8704733 }, buyer: { email: "comprador.teste@example.com" }, offer: { code: "g9knd34r" }, checkout_country: { iso: "BR" } } };
let webhook = null;
try {
  const r = await worker.fetch(new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "x-hotmart-hottok": HOTTOK, "content-type": "application/json" }, body: JSON.stringify(payload) }), env, { waitUntil() {} });
  webhook = { status: r.status, body: await r.json().catch(() => null) };
} catch (e) { webhook = { error: String(e?.message || e).slice(0, 80) }; }
const optout = await worker.fetch(new Request("https://zevanory.api.br/abandono/sair?r=" + "a".repeat(64) + "&t=" + "b".repeat(32)), env, { waitUntil() {} }).then((r) => r.status).catch(() => -1);
// Sai só depois de o stdout esvaziar (process.exit logo após console.log num pipe pode truncar a linha).
const finish = (obj) => process.stdout.write("PROBE_RESULT " + JSON.stringify(obj) + "\n", () => process.exit(0));
const timer = setTimeout(() => finish({ timeout: true }), 90000);
try { await worker.scheduled({ cron: "0 * * * *", scheduledTime: Date.UTC(2026, 10, 9, 6, 0, 0) }, env, { waitUntil() {} }); } catch {}
clearTimeout(timer);
const abandonoKv = kvKeys.filter((k) => k.includes("abandono"));
finish({ webhook, optout, selfPaths, abandonoD1: d1Calls.filter((q) => /abandono_|withSession/.test(q)), abandonoKv });
