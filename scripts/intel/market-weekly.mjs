// Weekly market intelligence (zero cost, public signals only).
// For each of the 40 business types we serve, collect what people actually type into Google
// and YouTube search (autocomplete), then score demand and fit with the Ordem Mestra weights
// 25/15/15/15/15/10/5. Every score keeps its evidence (the real queries). Product ideas are
// proposals with evidence, never launched automatically. Writes KV zpc:market:v1:weekly.
import { readFileSync } from "node:fs";

export const MARKET_KEY = "zpc:market:v1:weekly";
const RE = {
  problem: /\b(como|organizar|controle|controlar|aumentar|vender|vendas|lucro|precifica|pre[cç]o|gest[aã]o|marketing|clientes|whatsapp|instagram|divulgar|atrair)\b/i,
  pay: /\b(curso|planilha|modelo|sistema|programa|app|aplicativo|consultoria|template|kit|apostila|ebook)\b/i,
  money: /\b(financeiro|caixa|lucro|custo|precifica|pre[cç]o|margem|faturamento|planilha)\b/i,
  sales: /\b(vender|vendas|clientes|divulgar|marketing|instagram|whatsapp|atrair|promo[cç][aã]o)\b/i,
  ai: /\b(ia|intelig[eê]ncia artificial|chatgpt|gpt|automa[cç][aã]o)\b/i,
};
const REGULATED = /advoca|psic|clinic|odonto|farm|nutri|contab|fisio/;

export function scoreRamo(g, data, maxDemand = 1, maxAi = 1) {
  const all = [...new Set(Object.values(data).flat())];
  const ai = [...new Set([...(data.ia || []), ...(data.yt || [])])];
  const n = (re) => all.filter((q) => re.test(q)).length;
  const demand = all.length / Math.max(1, maxDemand);
  const problem = all.length ? n(RE.problem) / all.length : 0;
  const pay = all.length ? Math.min(1, n(RE.pay) / Math.max(1, all.length * 0.25)) : 0;
  const aiInterest = ai.length / Math.max(1, maxAi);
  const fit = [RE.money, RE.sales, RE.ai].filter((re) => all.some((q) => re.test(q))).length / 3;
  const gap = demand * (1 - Math.min(1, aiInterest));
  const risk = REGULATED.test(g.slug) ? 0.4 : 1;
  const parts = { demanda: 25 * demand, intencao: 15 * problem, pagamento: 15 * pay, interesseIA: 15 * aiInterest, aderencia: 15 * fit, lacuna: 10 * gap, risco: 5 * risk };
  const score = Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 10) / 10;
  const product = n(RE.money) >= n(RE.sales) && n(RE.money) >= n(RE.ai) ? "lucro-e-caixa" : n(RE.sales) >= n(RE.ai) ? "vendas-na-pratica" : "ia-na-pratica";
  return { slug: g.slug, name: g.name, score, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])), signals: all.length, product, topQueries: all.filter((q) => RE.problem.test(q) || RE.pay.test(q)).slice(0, 8) };
}

export function productIdeas(ranking) {
  const ideas = [];
  for (const r of ranking.slice(0, 15)) {
    const sheets = r.topQueries.filter((q) => /planilha|controle|modelo/i.test(q));
    if (sheets.length >= 2) ideas.push({ title: `Kit de planilhas para ${r.name.toLowerCase()}`, evidence: sheets.slice(0, 3), basis: `${sheets.length} buscas por planilha/controle/modelo`, status: "proposta (não lançada)" });
  }
  return ideas.slice(0, 5);
}

async function suggest(q, yt = false) {
  const u = `https://suggestqueries.google.com/complete/search?client=firefox${yt ? "&ds=yt" : ""}&hl=pt-BR&gl=br&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/124 Safari/537.36" } });
    if (!r.ok) return [];
    const buf = Buffer.from(await r.arrayBuffer());
    let text = buf.toString("utf8");
    if (text.includes("�")) text = buf.toString("latin1");
    const j = JSON.parse(text);
    return (j[1] || []).map((s) => String(s).toLowerCase()).filter((s) => s !== q.toLowerCase());
  } catch { return []; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main() {
  const bank = JSON.parse(readFileSync(new URL("../../data/short-bank.json", import.meta.url), "utf8"));
  const raw = [];
  for (const g of bank.guides) {
    const n = g.name.toLowerCase();
    const data = {
      base: await suggest(n), ia: await suggest(`ia para ${n}`), planilha: await suggest(`planilha ${n}`),
      vendas: await suggest(`como vender mais ${n}`), financeiro: await suggest(`como organizar financeiro ${n}`), yt: await suggest(`ia para ${n}`, true),
    };
    raw.push({ g, data });
    await sleep(400);
  }
  const maxDemand = Math.max(1, ...raw.map((x) => new Set(Object.values(x.data).flat()).size));
  const maxAi = Math.max(1, ...raw.map((x) => new Set([...x.data.ia, ...x.data.yt]).size));
  const ranking = raw.map((x) => scoreRamo(x.g, x.data, maxDemand, maxAi)).sort((a, b) => b.score - a.score);
  const totalSignals = ranking.reduce((a, r) => a + r.signals, 0);
  const out = {
    schema: "zevanory-market/v1", generatedAt: new Date().toISOString(),
    method: "Sugestões reais de busca do Google e do YouTube (autocompletar, Brasil) para 6 consultas por ramo. Pesos 25/15/15/15/15/10/5: demanda, intenção de resolver, disposição a pagar, interesse em IA, aderência aos produtos, lacuna, risco.",
    integrity: totalSignals ? "real" : "missing", totalSignals, ranking, ideas: productIdeas(ranking),
  };
  const { CLOUDFLARE_API_TOKEN: tk, CLOUDFLARE_ACCOUNT_ID: ac, KV_NAMESPACE_ID: ns } = process.env;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ac}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(MARKET_KEY)}`, { method: "PUT", headers: { authorization: "Bearer " + tk }, body: JSON.stringify(out) });
  if (!r.ok) throw new Error("kv_put_" + r.status);
  console.log("::notice title=MARKET_WEEKLY::" + JSON.stringify({ totalSignals, top: ranking.slice(0, 8).map((x) => `${x.name}:${x.score}:${x.product}`), ideas: out.ideas.map((i) => i.title) }));
  if (!totalSignals) process.exit(1);
}
const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) main().catch((e) => { console.log("::error title=MARKET_WEEKLY::" + String(e?.message || e).slice(0, 200)); process.exit(1); });
