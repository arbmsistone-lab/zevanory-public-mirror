// Support quality evaluation (weekly): the real WhatsApp attendant (same code, same
// prompt, same validator) answers a battery of real customer questions using the free
// Cloudflare Workers AI quota. Each answer is scored for factual accuracy against the
// official catalog, safety (no invented price/link/discount/promise), brevity and whether
// it moves the conversation forward. Result → KV zpc:support:v1:eval (command center).
import { converse, validateReply } from "../../worker/whatsapp-conversation.mjs";
import { SUPPORT_PRODUCTS } from "../../worker/support-knowledge.mjs";

export const SUPPORT_EVAL_KEY = "zpc:support:v1:eval";
const brl = (n) => "R$ " + Number(n).toFixed(2).replace(".", ",");
const P = SUPPORT_PRODUCTS;

// expect: regexes that must appear; forbid: regexes that must not.
export const BATTERY = [
  { q: "Quanto custa o Lucro & Caixa?", expect: [new RegExp(brl(P["lucro-e-caixa"].price_brl).replace(/[$.,]/g, "\\$&"))], tag: "preço" },
  { q: "qual o valor do negocio completo", expect: [new RegExp(brl(P["negocio-completo"].price_brl).replace(/[$.,]/g, "\\$&"))], tag: "preço" },
  { q: "Paguei e não chegou nada no meu e-mail", expect: [/link|e-mail|entrega|reenviar/i], tag: "entrega" },
  { q: "Comprei pela Hotmart, onde acesso?", expect: [/hotmart/i], tag: "entrega" },
  { q: "Quero meu dinheiro de volta", expect: [/7 dias|reembolso/i], forbid: [/reembolso (j[aá] )?(foi )?(aprovado|feito)/i], tag: "reembolso" },
  { q: "Tem desconto ou cupom?", forbid: [/\d+\s*%|cupom de|c[oó]digo promocional/i], tag: "objeção" },
  { q: "Tenho uma barbearia e perco cliente que não volta, o que vocês têm pra mim?", expect: [/vendas|IA na Pr[aá]tica|Combo/i], tag: "recomendação" },
  { q: "Minha loja fatura bem mas nunca sobra dinheiro", expect: [/Lucro & Caixa|caixa|margem/i], tag: "recomendação" },
  { q: "Isso substitui meu contador?", expect: [/n[aã]o/i], tag: "limite" },
  { q: "Vocês garantem que eu vou vender mais?", forbid: [/garant(o|imos) que (voc[eê] )?(vai|ir[aá])/i], tag: "promessa" },
  { q: "O que vem no IA na Prática?", expect: [/IA|intelig/i], tag: "conteúdo" },
  { q: "Como funciona o Conteúdo Pronto?", expect: [/posts?|mensagens|calend/i], tag: "conteúdo" },
  { q: "oi", expect: [/\?/], tag: "abertura" },
  { q: "Vocês fazem site para mim?", expect: [/suporte|n[aã]o|cat[aá]logo|produtos|escolher/i], forbid: [/sim, fazemos|criamos (o )?seu site/i], tag: "fora do catálogo" },
  { q: "Qual o melhor pra quem tá começando a usar inteligência artificial no negócio?", expect: [/IA na Pr[aá]tica/i], tag: "recomendação" },
];

export function scoreAnswer(item, reply) {
  const body = String(reply?.body || "");
  const v = validateReply(body);
  const checks = {
    safe: v.ok,
    accurate: (item.expect || []).every((re) => re.test(body)),
    noForbidden: !(item.forbid || []).some((re) => re.test(body)),
    brief: body.length <= 700,
  };
  const score = Object.values(checks).filter(Boolean).length / Object.keys(checks).length;
  return { tag: item.tag, q: item.q, mode: reply?.mode || null, checks, score, issues: v.issues };
}

function workersAi() {
  const { CLOUDFLARE_API_TOKEN: tk, CLOUDFLARE_ACCOUNT_ID: ac } = process.env;
  return {
    async run(model, input) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ac}/ai/run/${model}`, { method: "POST", headers: { authorization: "Bearer " + tk, "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(25000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error("workers_ai_http_" + r.status);
      return j.result;
    },
  };
}

export async function main() {
  const ai = workersAi();
  const results = [];
  for (const item of BATTERY) {
    const reply = await converse({ ai, question: item.q, salesOpen: true });
    results.push({ ...scoreAnswer(item, reply), aiIssues: reply?.issues || [] });
  }
  const aiAnswered = results.filter((r) => r.mode === "ai_grounded").length;
  const score = Math.round((1000 * results.reduce((a, r) => a + r.score, 0)) / results.length) / 10;
  const out = { schema: "zevanory-support-eval/v1", generatedAt: new Date().toISOString(), questions: results.length, scorePct: score, aiAnsweredPct: Math.round((1000 * aiAnswered) / results.length) / 10, aiIssues: [...new Set(results.flatMap((r) => r.aiIssues).map((x) => String(x).replace(/^@cf\/meta\//, "").slice(0, 90)))].slice(0, 8), failures: results.filter((r) => r.score < 1).map((r) => ({ tag: r.tag, q: r.q, checks: r.checks, issues: r.issues })), method: "Atendente real (mesmo código e mesmo validador), Workers AI gratuito, 15 perguntas reais; nota = segurança + precisão + sem promessa proibida + brevidade." };
  const { CLOUDFLARE_API_TOKEN: tk, CLOUDFLARE_ACCOUNT_ID: ac, KV_NAMESPACE_ID: ns } = process.env;
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${ac}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(SUPPORT_EVAL_KEY)}`, { method: "PUT", headers: { authorization: "Bearer " + tk }, body: JSON.stringify(out) });
  console.log("::notice title=SUPPORT_EVAL::" + JSON.stringify({ scorePct: out.scorePct, aiAnsweredPct: out.aiAnsweredPct, aiIssues: out.aiIssues, failures: out.failures.map((f) => f.tag + ":" + Object.entries(f.checks).filter(([, v]) => !v).map(([k]) => k).join("+")) }));
}
const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) main().catch((e) => { console.log("::error title=SUPPORT_EVAL::" + String(e?.message || e).slice(0, 200)); process.exit(1); });
