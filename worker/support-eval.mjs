// Support quality evaluation core, shared by the Worker (real AI binding) and CI tests.
import { converse, validateReply } from "./whatsapp-conversation.mjs";
import { SUPPORT_PRODUCTS } from "./support-knowledge.mjs";

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


// Runs the battery against the real attendant (Workers AI binding) at most once a week.
export async function runSupportEvalIfDue(env = {}, { now = Date.now(), force = false } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get || !kv?.put || !env.AI?.run) return { ran: false, reason: "unconfigured" };
  let prev = null;
  try { prev = JSON.parse(String(await kv.get(SUPPORT_EVAL_KEY) || "null")); } catch {}
  if (!force && prev?.runtime === "worker-ai-binding" && now - Date.parse(prev.generatedAt || 0) < 7 * 864e5) return { ran: false, reason: "fresh" };
  const results = [];
  for (const item of BATTERY) {
    const reply = await converse({ ai: env.AI, question: item.q, salesOpen: true });
    results.push({ ...scoreAnswer(item, reply), aiIssues: reply?.issues || [] });
  }
  const aiAnswered = results.filter((r) => r.mode === "ai_grounded").length;
  const out = {
    schema: "zevanory-support-eval/v1", runtime: "worker-ai-binding", generatedAt: new Date(now).toISOString(), questions: results.length,
    scorePct: Math.round((1000 * results.reduce((a, r) => a + r.score, 0)) / results.length) / 10,
    aiAnsweredPct: Math.round((1000 * aiAnswered) / results.length) / 10,
    aiIssues: [...new Set(results.flatMap((r) => r.aiIssues).map((x) => String(x).replace(/^@cf\/meta\//, "").slice(0, 90)))].slice(0, 8),
    failures: results.filter((r) => r.score < 1).map((r) => ({ tag: r.tag, q: r.q, mode: r.mode, checks: r.checks, issues: r.issues })),
    method: "Atendente real em produção (binding Workers AI gratuito, mesmo código e validador), 15 perguntas reais; nota = segurança + precisão + sem promessa proibida + brevidade.",
  };
  await kv.put(SUPPORT_EVAL_KEY, JSON.stringify(out));
  return { ran: true, scorePct: out.scorePct, aiAnsweredPct: out.aiAnsweredPct };
}
