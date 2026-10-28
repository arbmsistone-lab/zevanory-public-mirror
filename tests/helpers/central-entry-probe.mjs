// Probe (rodada 12, MED-1): importa o ponto de entrada REAL do Worker central e pede as URLs recebidas em argv.
// O único import "cloudflare:" do central (cloudflare:node) vira um stub inerte; nenhum binding é fornecido, então a
// resposta tem de sair antes de qualquer acesso ao ambiente. Imprime JSON e encerra o processo.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
const hooks = `export async function resolve(s, c, n) { if (s.startsWith("cloudflare:")) return { url: "data:text/javascript,export function handleAsNodeRequest(){throw new Error('stub')}", shortCircuit: true }; return n(s, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const central = (await import(pathToFileURL(process.argv[2]).href)).default;
const out = [];
for (const url of process.argv.slice(3)) {
  try {
    const r = await central.fetch(new Request(url), {}, { waitUntil() {}, passThroughOnException() {} });
    out.push({ url, status: r.status, location: r.headers.get("location"), body: (await r.text()).length });
  } catch (e) { out.push({ url, error: String(e && e.message || e) }); }
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
