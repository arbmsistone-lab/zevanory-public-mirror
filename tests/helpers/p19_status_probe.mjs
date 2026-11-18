// P19 fase 1: sonda da ROTA HTTP real /api/status do Worker de produção (worker/cloudflare-worker.compat.mjs), sem rede
// e sem segredo real. Modo por argumento:
//   ok   : o "Neon" (fetch interceptado) responde a cada consulta; a rota responde 200 com Server-Timing genérico e os
//          logs trazem início e fim de cada etapa;
//   hang : o "Neon" nunca responde; depois de HANG_MS a sonda imprime os logs: a ENTRADA da leitura do PostgreSQL
//          (operational_read e pg_read) aparece, a saída não. É o rastro que fica quando não há resposta nem Server-Timing.
// Rodar: node --import ./tests/t4_sim/register.mjs tests/helpers/p19_status_probe.mjs ok|hang   (saída: "PROBE_RESULT {...}")
import http from "node:http";

const MODE = process.argv[2] === "hang" ? "hang" : "ok";
const RID = /^[0-9a-f]{12}$/.test(process.argv[3] || "") ? process.argv[3] : null;  // rid trazido pelo cliente (smoke)
const HANG_MS = 1500;
const realFetch = globalThis.fetch;
let port = 0;
const ready = new Promise((resolve) => {
  const original = http.createServer;
  http.createServer = function probeCreateServer(...args) {
    const server = original.apply(this, args);
    const listen = server.listen.bind(server);
    server.listen = () => listen(0, "127.0.0.1", () => { port = server.address().port; resolve(); });
    return server;
  };
});
const network = [];
globalThis.fetch = async (input, init = {}) => {
  const isReq = typeof input === "object" && input !== null && "url" in input && typeof input.url === "string";
  const url = new URL(isReq ? input.url : String(input));
  if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === "8788") {
    await ready;
    url.port = String(port);
    const headers = new Headers(init.headers || (isReq ? input.headers : undefined) || {});
    headers.set("connection", "close");
    return realFetch(url, { ...init, headers });
  }
  network.push(url.hostname);
  if (url.hostname.endsWith(".neon.tech")) {
    if (MODE === "hang") return new Promise(() => {});
    return new Response(JSON.stringify({ command: "SELECT", fields: [], rows: [], rowCount: 0, rowAsArray: false }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 503 });
};

const logs = [];
const realLog = console.log;
console.log = (...a) => { const line = a.map(String).join(" "); if (line.includes('"evt":"diag_stage"')) logs.push(JSON.parse(line)); else realLog(...a); };

const kv = { async get() { return null; }, async put() {}, async delete() {}, async list() { return { keys: [], list_complete: true }; } };
const { default: production } = await import("../../worker/cloudflare-worker.compat.mjs");
for (const k of Object.keys(process.env)) if (/^(ZEVANORY_OPERATOR_TOKEN|CERTIFICATION_|OPERATOR_TOKEN$|DATABASE_URL$|DATABASE_READ_)/.test(k)) delete process.env[k];
const env = {
  ZEVANORY_DEPLOYMENT_ENV: "production", SALE_GLOBALLY_ENABLED: "false", ZEVANORY_PRIVATE_ARTIFACTS: kv,
  DATABASE_URL: "postgresql://sim:sim@ep-p19-status-probe.sim.neon.tech/sim?sslmode=require",
};
const req = new Request("https://zevanory.api.br/api/status", { method: "GET", headers: { host: "zevanory.api.br", "user-agent": "p19-probe", ...(RID ? { "x-zevanory-diag": RID } : {}) } });
const pending = production.fetch(req, env, { waitUntil() {} });
const out = { mode: MODE };
if (MODE === "hang") {
  const r = await Promise.race([pending.then(() => "responded"), new Promise((res) => setTimeout(() => res("no_response"), HANG_MS))]);
  out.outcome = r;
} else {
  const res = await pending;
  const body = await res.text();
  out.status = res.status;
  out.server_timing = res.headers.get("server-timing");
  out.diag_header = res.headers.get("x-zevanory-diag");
  out.body_has_project = (() => { try { return "project" in JSON.parse(body); } catch { return false; } })();
  // Corpo normalizado (sem request_id nem relógios) para comparar com a versão anterior à medição.
  const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !/^(request_id|at|generated_at|checked_at|updatedAt|updated_at|now|measured_at)$/.test(k)).map(([k, x]) => [k, strip(x)])) : v);
  out.body_keys = (() => { try { return Object.keys(JSON.parse(body)).sort(); } catch { return null; } })();
  out.body_norm = (() => { try { return JSON.stringify(strip(JSON.parse(body))); } catch { return null; } })();
}
out.logs = logs;
out.neon_calls = network.filter((h) => h.endsWith(".neon.tech")).length;
realLog("PROBE_RESULT " + JSON.stringify(out));
process.exit(0);
