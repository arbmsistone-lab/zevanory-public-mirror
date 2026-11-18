// P20 v2: sonda da ROTA HTTP real /api/internal/backup/run do Worker de produção (worker/cloudflare-worker.compat.mjs),
// sem rede e sem segredo real. Prova que uma requisição com índice inválido (ex.: part=4&parts=4) é recusada com o valor
// ORIGINAL, sem ser ajustada para uma parte válida, e que ela não toca no banco nem no KV.
//   - KV: binding em memória que registra toda leitura e gravação;
//   - banco: o Worker fala com o Neon por HTTP (fetch); toda chamada de rede sai por um fetch interceptado que registra
//     o destino e responde 503 (nenhuma rede real). Uma requisição que chegasse ao banco deixaria rastro aqui;
//   - controle: a MESMA sonda com índices válidos chega ao banco (rastro > 0), provando que a sonda enxerga o acesso.
// Rodar: node --import ./tests/t4_sim/register.mjs tests/helpers/p20_route_probe.mjs   (saída: linha "PROBE_RESULT {...}")
import http from "node:http";

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
  return new Response("{}", { status: 503 });
};

const kvOps = [];
const store = new Map([["zpc:backup:v1:report", "{\"canonico\":true}"]]);
const kv = {
  async get(k) { kvOps.push("get " + k); return store.get(k) ?? null; },
  async put(k, v) { kvOps.push("put " + k); store.set(k, String(v)); },
  async delete(k) { kvOps.push("delete " + k); store.delete(k); },
  async list({ prefix = "" } = {}) { kvOps.push("list " + prefix); return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};

const { default: production } = await import("../../worker/cloudflare-worker.compat.mjs");
for (const k of Object.keys(process.env)) if (/^(ZEVANORY_OPERATOR_TOKEN|CERTIFICATION_|OPERATOR_TOKEN$|DATABASE_URL$|P20_)/.test(k)) delete process.env[k];

const TOKEN = "synthetic-p20-route-probe-token-0123456789abcdef";
const env = {
  ZEVANORY_DEPLOYMENT_ENV: "production", SALE_GLOBALLY_ENABLED: "false", ZEVANORY_PRIVATE_ARTIFACTS: kv, ZEVANORY_OPERATOR_TOKEN: TOKEN,
  DATABASE_URL: "postgresql://sim:sim@ep-p20-route-probe.sim.neon.tech/sim?sslmode=require",
  P20_BACKUP_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const PLAN = "a".repeat(64), RUN = "b".repeat(32);
async function call(qs) {
  const n0 = network.length, k0 = kvOps.length;
  const res = await production.fetch(new Request("https://zevanory.api.br/api/internal/backup/run?" + qs, { method: "POST", headers: { "x-backup-token": TOKEN } }), env, { waitUntil() {} });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { qs, status: res.status, failures: body && Array.isArray(body.failures) ? body.failures : null, rede: network.length - n0, kv: kvOps.slice(k0) };
}
const v = `&plan_id=${PLAN}&run_id=${RUN}`;
const invalid = [
  "part=4&parts=4" + v, "part=6&parts=6" + v, "part=-1&parts=4" + v, "part=1.5&parts=4" + v, "part=01&parts=4" + v, "part=&parts=4" + v,
  "parts=4" + v, "part=0&parts=7" + v, "part=0&parts=0" + v, "part=0&parts=" + v, "finalize=1&part=0&parts=4" + v, "finalize=1&parts=9" + v,
];
const out = { rejeitadas: [], controle: null };
for (const qs of invalid) out.rejeitadas.push(await call(qs));
// Controle: índices válidos chegam ao banco (plano não existe no banco simulado: falha, mas DEPOIS de tentar a rede).
out.controle = await call("part=3&parts=4" + v);
out.kv_final_canonico = store.get("zpc:backup:v1:report");
out.kv_chaves = [...store.keys()].sort();
console.log("PROBE_RESULT " + JSON.stringify(out));
process.exit(0);
