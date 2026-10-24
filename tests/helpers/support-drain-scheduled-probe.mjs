// Sonda (sem rede): executa o handler `scheduled` REAL do Worker (compat) com o cron horário e registra se o
// dreno do outbox foi despachado via SELF, com token aceito pelo próprio endpoint, antes de qualquer outra rede.
// Rodar com o carregador local: node --import ./tests/t4_sim/register.mjs tests/helpers/support-drain-scheduled-probe.mjs
const events = [];
globalThis.fetch = async (u) => { events.push("net"); return new Response("{}", { status: 503 }); };
const { default: worker } = await import("../../worker/cloudflare-worker.compat.mjs");
const fwd = await import("../../worker/support-email-forward.mjs");
const env = {
  LEAD_PRIVACY_SECRET: "privacidade-sintetica-de-teste-0123456789abcdef",
  SELF: {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      // O próprio endpoint valida o token (sem banco/destino configurado o dreno responde "unconfigured").
      const res = process.argv[3] === "overdue"
        ? (await fwd.handleSupportDrainRequest(request, env, {}), Response.json({ ok: true, checked: 0, done: 0, pending: 1, dead: 0, backlog: 1, oldest_min: 180, overdue: true }))
        : await fwd.handleSupportDrainRequest(request, env, {});
      events.push(`self:${path}:${res ? res.status : "null"}`);
      return res || new Response("{}", { status: 404 });
    }
  }
};
const timer = setTimeout(() => { console.log("PROBE_RESULT " + JSON.stringify({ events, timeout: true })); process.exit(0); }, 60000);
let rejected = null;
try { await worker.scheduled({ cron: process.argv[2] || "0 * * * *", scheduledTime: Date.now() }, env, { waitUntil() {} }); } catch (error) { rejected = String(error?.message || error).slice(0, 80); }
clearTimeout(timer);
console.log("PROBE_RESULT " + JSON.stringify({ events, rejected }));
process.exit(0);
