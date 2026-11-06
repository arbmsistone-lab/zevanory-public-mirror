// ZEVANORY Conteúdo Pronto — contrato, gerador e validadores puros (DEC-14, fase 1: CP oculto, vendas fechadas).
// DEC-14(b): o pipeline legado em KV (webhook, boas-vindas, lembretes, fila de pendentes, fila de falhas, regeneração,
// leitura do pacote, reembolsos e rotas de operador) foi REMOVIDO deste módulo. Nenhuma linha aqui grava ou lê o KV
// (zpc:cp:*). O caminho efetivo do CP é o Durable Object SQLite por assinante (worker/cp-g03-g04-candidate.mjs,
// worker/cp-nc012-fulfillment.mjs, worker/cp-nc014-campaign.mjs) roteado por worker/cp-nc011-routing.mjs; pacote e
// operador respondem 503 até a homologação da fase 2 (docs/ops/dec14-cp-phase2-prereqs-and-reconciliation.md).
// Este módulo só exporta funções puras: o contrato da oferta (data/politica-unica.json, conteudo_pronto), a validação
// da campanha e do briefing, a geração do pacote com Workers AI (env.AI; sem KV, sem e-mail) e o pacote em texto,
// com o bloqueio de pacote contaminado (canal ou número banido nunca é exibido nem reenviado).
// Hotmart cuida de cobrança, recorrência, cancelamento e reembolso; nada de Mercado Pago, checkout ou preço aqui.
import { BANNED_NUMBERS, CONTEUDO_PRONTO } from "./politica-unica.mjs";

// Contrato versionado da oferta (data/politica-unica.json, conteudo_pronto): a página
// /conteudo-pronto, o resumo da oferta e este gerador leem as mesmas quantidades, objetivos e
// canais. A conta de mensagens da ZEVANORY na Meta foi banida: os roteiros são para canais
// autorizados pelo cliente, revisados por ele, sem disparo automático.
export const CONTENT_SCHEMA_VERSION = CONTEUDO_PRONTO.content_schema_version;
export const PACKAGE_SCHEMA = CONTEUDO_PRONTO.package_schema;
export const ROTEIRO_OBJETIVOS = Object.freeze(CONTEUDO_PRONTO.objetivos.map((o) => Object.freeze({ ...o })));
const N_POSTS = CONTEUDO_PRONTO.posts;
// v3 (Sol AVAL 304): cada ciclo é uma campanha mensal de promoção de vendas do assinante.
export const SERVICO = CONTEUDO_PRONTO.servico;
export const CAMPANHA = CONTEUDO_PRONTO.campanha;
export const CAMPANHA_CAMPOS = Object.freeze(CAMPANHA.campos.map((f) => Object.freeze({ ...f })));
export const FASES = Object.freeze(CAMPANHA.fases.map((f) => Object.freeze({ ...f })));
const N_ROTEIROS = CONTEUDO_PRONTO.roteiros;
const CANAIS = CONTEUDO_PRONTO.canais_autorizados_exemplo;
const CANAIS_TEXTO = CANAIS.slice(0, -1).join(", ") + " ou " + CANAIS[CANAIS.length - 1];
// Canal banido e disparo em massa nunca entram num roteiro (termos em conteudo_pronto.termos_proibidos_regex);
// \b evita falso positivo em palavras como "zapier".
const ROTEIRO_PROIBIDO = new RegExp("\\b(?:" + CONTEUDO_PRONTO.termos_proibidos_regex.join("|") + ")\\b", "i");
// Número banido de contato_publico.numeros_banidos em qualquer grafia: completo, formatado ("(88) 9 9254-5413")
// ou mascarado ("88 9****-5413"). Corridas com cara de telefone são comparadas só pelos dígitos.
const PHONE_RUN = /[+(]?\d[\d\s().*•#-]{6,}\d/g;
// Máscara: DDD do número banido, de 2 a 6 posições com ao menos um caractere de máscara, e os 4 últimos dígitos.
const MASKED_RES = BANNED_NUMBERS.map((n) => new RegExp(`(?<!\\d)(?:\\+?55[\\s().-]*)?\\(?${n.slice(2, 4)}\\)?[\\s.-]*(?=[\\d\\s.*•#-]*[*•#])[\\d*•#][\\d\\s*•#]{1,6}[\\s.-]*${n.slice(-4)}(?!\\d)`));
export function bannedNumberIn(text) {
  const str = String(text ?? "");
  if (MASKED_RES.some((re) => re.test(str))) return true;
  for (const run of str.match(PHONE_RUN) || []) {
    const d = run.replace(/\D/g, "");
    if (BANNED_NUMBERS.some((n) => d.includes(n.slice(-8)))) return true;
  }
  return false;
}
// Canal banido, disparo em massa ou número banido: nada disso é gerado, exibido ou reenviado.
export const contaminated = (text) => ROTEIRO_PROIBIDO.test(String(text ?? "")) || bannedNumberIn(text);

export const SERVICE_PRODUCT_NAME = "ZEVANORY Conteúdo Pronto";
// Validade do link de cada pacote (a página promete 120 dias: tests/conteudo-pronto-roteiros.test.mjs [p24-link]).
export const PACKAGE_LINK_DAYS = 120;
const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8-fast"];

export function isServiceProduct(data = {}, ids = "") {
  const name = String(data?.product?.name || "");
  const list = String(ids || "").split(",").map((x) => x.trim()).filter(Boolean);
  return name.trim() === SERVICE_PRODUCT_NAME || list.includes(String(data?.product?.id || ""));
}

// #960 rodada 9: regra de negócio por DATA CIVIL de America/Sao_Paulo (fuso IANA, sem offset fixo), não pela data
// UTC. Às 21h de Brasília já é o dia seguinte em UTC; "hoje" do assinante segue o calendário de Brasília.
// Fonte: ECMA-402 Intl.DateTimeFormat (option timeZone).
const SP_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
export function civilDaySP(ms = Date.now()) {
  const p = Object.fromEntries(SP_DAY_FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// ---------- Briefing form ----------
const FIELDS = [
  ["negocio", "Nome do negócio", 80, true],
  ["ramo", "Ramo / o que você faz (ex.: salão de beleza, loja de roupas, contabilidade)", 160, true],
  ["publico", "Quem é o seu cliente ideal", 240, true],
  ["produtos", "Principais produtos ou serviços que quer divulgar", 400, true],
  ["diferencial", "Por que escolher você (diferencial)", 300, true],
  ["cidade", "Cidade / região de atendimento", 80, false],
  ["tom", "Tom de voz (ex.: próximo e divertido, sério e técnico)", 120, true],
  ["contato", "Canais que seus clientes autorizaram para falar com você (ex.: e-mail, Instagram Direct, Telegram, chat do site)", 160, false],
]; export const CP_BRIEFING_FIELDS = FIELDS; // NC-011: same field contract for DO-backed form
// Campanha do mês: os cinco campos do contrato, todos obrigatórios. Datas AAAA-MM-DD; período de N a M dias.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Promessa de resultado em qualquer ordem ("venda garantida", "garantia de resultado", "lucro certo").
const CAMPANHA_PROMESSA = /\b(vendas?|resultados?|lucros?|retornos?|clientes?)\s+(garantid\w*|certos?|certas?)\b|\bgarant\w*\s+(de\s+)?(vendas?|resultados?|lucros?|retornos?|clientes?)\b/i;
// #960 rodadas 2 e 3 (MED-5, MED-B): promessa de RESULTADO sobre vendas, faturamento, lucro, renda, retorno ou
// desempenho, e devolução de dinheiro condicionada a resultado. Vale para os campos da campanha e para todo texto
// gerado; a condição comercial é copiada nos e-mails, por isso uma condição com promessa é recusada no formulário e
// nunca é exigida. Frases promocionais comuns passam: "vaga garantida", "horário garantido", "entrega garantida até
// sexta", "Quer vender mais?", "Com certeza você vai amar", "garantia de 90 dias no conserto".
const RES = "(vendas?|faturamento|faturar|lucros?|lucrar|renda|retorno|rentabilidade|resultados?|clientes?|desempenho)";
export const PROMESSA_RX = new RegExp([
  "garant\\w*\\s+(de\\s+|que\\s+(voce\\s+)?(vai|vao|ira|irao)\\s+)?" + RES,
  RES + "\\s+(garantid\\w*|certos?|certas?|assegurad\\w*)",
  "\\b(vai|vao|ira|irao)\\s+(vender|lucrar|faturar|ganhar dinheiro|enriquecer)",
  "\\b(dobr|triplic|multiplic|quadruplic)\\w*\\s+(\\w+\\s+){0,2}" + RES,
  RES + "\\s+(\\w+\\s+)?(em|no|ao)\\s+dobro",
  "(lucrar|faturar|ganhar|vender)\\s+(\\w+\\s+)?(o\\s+)?(dobro|triplo)",
  "retorno\\s+(de\\s+)?\\d+\\s*%",
  "\\d+\\s*%\\s*(de\\s+)?(lucro|retorno|rentabilidade|resultado|aumento\\s+(nas|de|das)\\s+vendas)",
  "resultados?\\s+em\\s+\\d+\\s+(dias?|semanas?|horas?)",
  "dinheiro\\s+(de\\s+volta|devolvido)",
  "aument\\w*\\s+(\\w+\\s+){0,2}(vendas|faturamento|lucros?|renda)\\s+(garantid|em\\s+\\d|com\\s+certeza)",
  "aumente\\s+(o\\s+|seu\\s+|sua\\s+|as\\s+|suas\\s+)?(vendas|faturamento|lucros?|renda)",
  "risco\\s+zero|fique\\s+rico|renda\\s+(extra\\s+)?garantida|milagr",
].join("|"), "i");
// Aviso ao modelo (MED-B): as mesmas promessas listadas, para a IA evitar em vez de só ser recusada depois.
export const PROMESSAS_PROIBIDAS = "Não prometa resultado de vendas, faturamento, lucro, renda, retorno ou desempenho: nada de \"você vai vender\", \"dobrar as vendas\", \"faturamento em dobro\", \"faturamento garantido\", \"retorno de X%\", \"resultado garantido\", \"resultados em X dias\", \"aumente suas vendas\" ou \"dinheiro de volta\". Frases como \"vaga garantida\", \"horário garantido\" ou \"entrega até sexta\" podem ser usadas.";
export const promessa = (t) => PROMESSA_RX.test(normTxt(t));
// #960 rodada 2 (MED-4): a âncora precisa de termos com conteúdo. Palavras vazias ("de", "da", "o") nunca bastam.
const STOPWORDS = new Set("a o as os de da do das dos e em no na nos nas um uma uns umas para por com sem que se ao aos ou mais nosso nossa nossos nossas seu sua seus suas meu minha este esta esse essa isto isso aqui todo toda todos todas".split(" "));
// Palavras genéricas de oferta também não ancoram sozinhas ("nosso produto" não prova que o post fala da oferta).
const GENERIC = new Set("produto produtos servico servicos oferta ofertas promocao promocoes desconto descontos item itens loja compra compras venda vendas cliente clientes negocio campanha preco precos normal especial novo nova novos novas".split(" "));
export const ANCHOR_MIN_CHARS = 4;
export function anchorTerms(t) { return normTxt(t).split(/[^a-z0-9%]+/).filter((w) => w.length >= ANCHOR_MIN_CHARS && !STOPWORDS.has(w) && !GENERIC.has(w)); }
// A condição comercial pode ser genérica ("preço normal"): basta um termo com conteúdo ou um número/percentual.
function conditionTerms(t) { return normTxt(t).split(/[^a-z0-9%]+/).filter((w) => (w.length >= ANCHOR_MIN_CHARS && !STOPWORDS.has(w)) || /\d/.test(w)); }
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A frase inteira, com fronteira de palavra (não substring), e só se ela tiver ao menos um termo com conteúdo.
export function anchored(text, phrase, { condition = false } = {}) {
  const ph = normTxt(phrase);
  if (!(condition ? conditionTerms(ph) : anchorTerms(ph)).length) return false;
  return new RegExp("(^|[^a-z0-9])" + reEsc(ph) + "($|[^a-z0-9])").test(normTxt(text));
}
// #960 rodada 2 (LOW): data real (sem 30/02 virando março) e, no formulário, período a partir de hoje e no máximo
// CAMPANHA_INICIO_MAX_DIAS dias à frente (o mês pago fica reservado até a próxima renovação; ver CAMPAIGN_REMINDER_DAYS).
export const CAMPANHA_INICIO_MAX_DIAS = 45;
// Rodada 9 (LOW): mês 13, dia 00 etc. dão Invalid Date; toISOString() lançaria RangeError. Data impossível = inválida.
const realDate = (v) => { if (!ISO_DATE.test(v)) return false; const t = Date.parse(v + "T00:00:00Z"); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v; };
const dayMs = 86400000;
export function validateCampaign(raw = {}, { now = null } = {}) {
  const c = {};
  for (const f of CAMPANHA_CAMPOS) {
    const v = String(raw?.[f.id] ?? "").replace(/\s+/g, " ").trim();
    if (f.tipo === "date") {
      if (!realDate(v)) return { ok: false, error: `Informe uma data válida: ${f.rotulo}` };
    } else {
      if (v.length < 2) return { ok: false, error: `Faltou preencher: ${f.rotulo}` };
      if (v.length > f.max) return { ok: false, error: `Texto longo demais em: ${f.rotulo} (máximo ${f.max} caracteres)` };
    }
    c[f.id] = v;
  }
  const dias = Math.round((Date.parse(c.periodo_fim + "T00:00:00Z") - Date.parse(c.periodo_inicio + "T00:00:00Z")) / dayMs) + 1;
  if (!(dias >= CAMPANHA.periodo_dias_min && dias <= CAMPANHA.periodo_dias_max)) return { ok: false, error: `O período da campanha precisa ter de ${CAMPANHA.periodo_dias_min} a ${CAMPANHA.periodo_dias_max} dias (informado: ${dias}).` };
  if (now !== null) { // só no formulário: a campanha começa hoje ou depois, dentro da janela do ciclo pago
    const today = Date.parse(civilDaySP(now) + "T00:00:00Z"); // "hoje" em Brasília (rodada 9), não em UTC
    const ini = Date.parse(c.periodo_inicio + "T00:00:00Z");
    if (ini < today) return { ok: false, error: "O início da campanha não pode ser uma data que já passou." };
    if (ini > today + CAMPANHA_INICIO_MAX_DIAS * dayMs) return { ok: false, error: `O início da campanha precisa estar nos próximos ${CAMPANHA_INICIO_MAX_DIAS} dias.` };
  }
  if (!anchorTerms(c.oferta).length) return { ok: false, error: `Descreva a oferta com pelo menos uma palavra de ${ANCHOR_MIN_CHARS} letras ou mais (ex.: o nome do produto ou serviço).` };
  if (!conditionTerms(c.condicao_comercial).length) return { ok: false, error: `Descreva a condição comercial com pelo menos uma palavra de ${ANCHOR_MIN_CHARS} letras ou mais (ex.: "preço normal", "15% na segunda unidade").` };
  const texto = [c.objetivo_comercial, c.oferta, c.condicao_comercial].join(" ");
  if (FORBIDDEN.test(texto) || CAMPANHA_PROMESSA.test(texto) || promessa(texto) || contaminated(texto)) return { ok: false, error: "A campanha não pode prometer resultado, venda ou dinheiro de volta, nem citar canal de contato não autorizado." };
  return { ok: true, campanha: { ...c, dias } };
}

// ---------- Generation ----------
function aiText(out) { return String(out?.response ?? out?.result?.response ?? out ?? ""); }
function extractJson(text) { const s = text.indexOf("{"), e = text.lastIndexOf("}"); if (s < 0 || e <= s) return null; try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; } }
const FORBIDDEN = /(garant\w* (de )?(resultado|venda|lucro)|100% garantido|fique rico|renda garantida|milagr)/i;
const HASHTAG = /^#[\p{L}\p{N}_]{2,40}$/u;
export const LEGENDA_MIN = 200;
export const IMAGEM_MIN = 8;
function briefingText(b) { return FIELDS.filter(([id]) => b[id]).map(([id, label]) => `${label}: ${b[id]}`).join("\n"); }
const normTxt = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const FASE_IDS = new Set(CAMPANHA.fases.map((f) => f.id));
// Ancoragem (v3): com a campanha, cada post cita a oferta pelo mesmo nome e traz uma fase válida da campanha.
export function validatePosts(list, n, campanha = null) {
  if (!Array.isArray(list) || list.length < n) return null;
  if (campanha && (!anchorTerms(campanha.oferta).length || promessa(campanha.oferta))) return null;
  const out = [];
  for (const p of list.slice(0, n)) {
    const tema = String(p?.tema || "").trim(), legenda = String(p?.legenda || "").trim(), cta = String(p?.cta || "").trim();
    const hashtags = (Array.isArray(p?.hashtags) ? p.hashtags : String(p?.hashtags || "").split(/[\s,]+/)).map((h) => String(h).trim()).filter(Boolean).map((h) => h.startsWith("#") ? h : "#" + h).filter((h) => HASHTAG.test(h)).slice(0, 8);
    const imagem = String(p?.imagem || "").trim();
    // G3: a página promete hashtags e sugestão de imagem para cada post; legenda curta demais não é "legenda completa".
    if (tema.length < 3 || legenda.length < LEGENDA_MIN || legenda.length > 1600 || cta.length < 3 || FORBIDDEN.test(legenda + " " + cta) || promessa(tema + " " + legenda + " " + cta)) return null;
    if (hashtags.length < 1 || imagem.length < IMAGEM_MIN) return null;
    if (out.some((q) => q.tema.toLowerCase() === tema.toLowerCase())) return null;
    if (contaminated([tema, legenda, cta, ...hashtags, imagem].join(" "))) return null;
    const fase = String(p?.fase || "").trim();
    if (campanha) {
      if (!anchored(legenda + " " + cta, campanha.oferta)) return null;
      if (!FASE_IDS.has(fase)) return null;
    }
    out.push(campanha ? { tema, legenda, cta, hashtags, imagem, fase } : { tema, legenda, cta, hashtags, imagem });
  }
  return out;
}
// Roteiros multicanal: exatamente os objetivos do contrato, na ordem; cada um com versão curta
// (Direct, Telegram, chat do site) e versão de e-mail (assunto + corpo). O objetivo exibido vem do
// contrato, nunca do modelo, para a saída não divergir da oferta.
export function validateRoteiros(list, campanha = null) {
  if (!Array.isArray(list) || list.length < N_ROTEIROS) return null;
  const out = [];
  for (const [i, obj] of ROTEIRO_OBJETIVOS.entries()) {
    const r = list[i];
    const id = String(r?.objetivo_id || r?.objetivo || "").trim();
    const curta = String(r?.curta || "").trim();
    const assunto = String(r?.email?.assunto ?? r?.email_assunto ?? "").trim();
    const corpo = String(r?.email?.corpo ?? r?.email_corpo ?? "").trim();
    if (id !== obj.id) return null;
    if (curta.length < 60 || curta.length > 600) return null;
    if (assunto.length < 5 || assunto.length > 120 || corpo.length < 200 || corpo.length > 1600) return null;
    const all = [curta, assunto, corpo].join(" ");
    if (FORBIDDEN.test(all) || promessa(all) || contaminated(all)) return null;
    if (campanha) {
      // Condição com promessa nunca é exigida no e-mail (MED-5): sem ela a campanha inteira é recusada (fail-closed).
      if (promessa(campanha.condicao_comercial) || promessa(campanha.oferta)) return null;
      if (!anchored(curta, campanha.oferta) || !anchored(corpo, campanha.oferta)) return null;
      if (!anchored(corpo, campanha.condicao_comercial, { condition: true })) return null;
    }
    out.push({ objetivo_id: obj.id, objetivo: obj.titulo, curta, email: { assunto, corpo } });
  }
  return out;
}
export function campaignText(c) {
  return `CAMPANHA DO MÊS (${SERVICO}):\nObjetivo comercial: ${c.objetivo_comercial}\nOferta promovida: ${c.oferta}\nCondição comercial: ${c.condicao_comercial}\nPeríodo: de ${c.periodo_inicio} a ${c.periodo_fim}`;
}
export function roteirosPrompt(brief, campanha = null) {
  const objetivos = ROTEIRO_OBJETIVOS.map((o, i) => `${i + 1}) "${o.id}": ${o.regra}`).join("; ");
  const camp = campanha ? `${campaignText(campanha)}\n\nTodos os roteiros promovem esta campanha: cite a oferta exatamente como "${campanha.oferta}" na versão curta e no corpo do e-mail, e escreva a condição comercial exatamente como "${campanha.condicao_comercial}" no corpo do e-mail. Não invente outra condição, prazo ou preço.\n\n` : "";
  return `Briefing do negócio:\n${brief}\n\n${camp}Crie ${N_ROTEIROS} roteiros multicanal de venda e acompanhamento para o negócio usar em canais que o cliente autorizou, como ${CANAIS_TEXTO}. O dono revisa antes de usar; nada é enviado automaticamente. Objetivos, nesta ordem: ${objetivos}. Cada roteiro tem uma versão curta (mensagem direta de 150 a 450 caracteres) e uma versão de e-mail (assunto curto e corpo de 400 a 1200 caracteres). Não cite aplicativos de mensagem que o cliente não autorizou, não proponha envio em massa e não invente nomes, preços ou prazos. JSON: {"roteiros":[{"objetivo_id":"${ROTEIRO_OBJETIVOS[0].id}","curta":"...","email":{"assunto":"...","corpo":"..."}}]}`;
}
async function ask(ai, system, user, validate) {
  let corrected = false; // MED-B: uma única nova chamada corretiva quando a recusa foi por promessa
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let timer, prompt = user, retryFix = false;
      try {
        const out = await Promise.race([
          ai.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: 3000, temperature: 0.6 }),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("ai_timeout")), 60000); }),
        ]);
        const parsed = extractJson(aiText(out));
        const ok = parsed && validate(parsed);
        if (ok) return ok;
        retryFix = Boolean(parsed) && !corrected && promessa(JSON.stringify(parsed));
      } catch {} finally { clearTimeout(timer); }
      if (retryFix) {
        corrected = true;
        let t2;
        try {
          const out = await Promise.race([
            ai.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user + "\n\n" + CORRECAO_PROMESSA }], max_tokens: 3000, temperature: 0.4 }),
            new Promise((_, rej) => { t2 = setTimeout(() => rej(new Error("ai_timeout")), 60000); }),
          ]);
          const parsed = extractJson(aiText(out));
          const ok = parsed && validate(parsed);
          if (ok) return ok;
        } catch {} finally { clearTimeout(t2); }
      }
    }
  }
  return null;
}
const SYSTEM = "Você é redator sênior de marketing para pequenos negócios brasileiros. Escreva em português do Brasil, no tom pedido, de forma concreta, sem promessas de resultado, sem preços inventados, sem emojis em excesso. " + PROMESSAS_PROIBIDAS + " Responda SOMENTE com JSON válido.";
export const CORRECAO_PROMESSA = "ATENÇÃO: a resposta anterior foi recusada porque trazia promessa de resultado de vendas, faturamento, lucro, renda ou desempenho. Reescreva o mesmo JSON sem nenhuma promessa desse tipo, mantendo a oferta e a condição comercial exatamente como informadas. " + PROMESSAS_PROIBIDAS;
const isoAdd = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * dayMs).toISOString().slice(0, 10);
// Calendário da campanha: 12 posts e 4 roteiros distribuídos nas datas do período informado (v3).
export function campaignCalendar(campanha, posts, roteiros) {
  const span = Math.round((Date.parse(campanha.periodo_fim + "T00:00:00Z") - Date.parse(campanha.periodo_inicio + "T00:00:00Z")) / dayMs);
  const at = (f) => Math.round(f * span);
  const cal = posts.map((p, i) => ({ dia: at(i / (posts.length - 1)) + 1, data: isoAdd(campanha.periodo_inicio, at(i / (posts.length - 1))), tipo: "post", tema: p.tema, fase: p.fase }));
  [0.15, 0.4, 0.65, 0.9].forEach((f, i) => cal.push({ dia: at(f) + 1, data: isoAdd(campanha.periodo_inicio, at(f)), tipo: "roteiro", tema: roteiros[i].objetivo }));
  return cal.sort((x, y) => x.dia - y.dia || (x.tipo === "post" ? -1 : 1));
}
// v3: o gerador RECUSA sem campanha válida (nenhuma chamada de IA). Posts e roteiros ancorados na campanha; as seis
// fases precisam aparecer nos 12 posts.
export async function generatePackage(env, briefing, cycle = 1, campanha = null) {
  const v = validateCampaign(campanha || {});
  if (!v.ok) return null;
  const camp = v.campanha;
  const ai = env.AI;
  if (!ai?.run) return null;
  const brief = briefingText(briefing);
  const fases = CAMPANHA.fases.map((f) => `"${f.id}" (${f.titulo})`).join(", ");
  const postSpec = (from) => `Briefing do negócio:\n${brief}\n\n${campaignText(camp)}\n\nCrie 6 posts para redes sociais da campanha (mês ${cycle}, posts ${from} a ${from + 5}). Todos promovem a oferta: cite-a exatamente como "${camp.oferta}" na legenda; use só a condição comercial informada; não invente nomes, preços nem prazos. Cada post tem uma fase da campanha, entre: ${fases}. JSON: {"posts":[{"fase":"anuncio","tema":"...","legenda":"legenda completa de 400 a 900 caracteres","cta":"chamada para ação curta","hashtags":["#...",5 a 8],"imagem":"sugestão objetiva de foto ou arte"}]}`;
  const a = await ask(ai, SYSTEM, postSpec(1), (j) => validatePosts(j.posts, 6, camp));
  if (!a) return null;
  const b = await ask(ai, SYSTEM, postSpec(7) + `\nNão repita estes temas: ${a.map((p) => p.tema).join("; ")}. Cubra as fases que faltarem entre: ${fases}.`, (j) => {
    const out = validatePosts(j.posts, 6, camp);
    return out && FASE_IDS.size === new Set([...a, ...out].map((p) => p.fase)).size ? out : null;
  });
  if (!b) return null;
  const m = await ask(ai, SYSTEM, roteirosPrompt(brief, camp), (j) => validateRoteiros(j.roteiros, camp));
  if (!m) return null;
  const posts = [...a, ...b];
  if (posts.length !== N_POSTS) return null;
  const { dias: _d, ...campanhaGravada } = camp;
  return { schema: PACKAGE_SCHEMA, content_schema_version: CONTENT_SCHEMA_VERSION, servico: SERVICO, cycle, generatedAt: new Date().toISOString(),
    campanha: campanhaGravada, posts, roteiros: m, calendario: campaignCalendar(camp, posts, m) };
}
// Pacotes antigos (zpc.cp.package.v1, campo "mensagens") continuam legíveis no link privado, com
// rótulo neutro: nenhum canal é prometido na reexibição.
function roteirosOf(pkg) {
  if (Array.isArray(pkg?.roteiros)) return pkg.roteiros;
  return (Array.isArray(pkg?.mensagens) ? pkg.mensagens : []).map((m) => ({ objetivo: String(m?.objetivo || ""), curta: String(m?.texto || ""), email: null }));
}
// Tudo o que a leitura exibe ou reenvia (o "tipo" do calendário nunca é exibido: vira Post/Roteiro).
export function displayedText(pkg) {
  const posts = (Array.isArray(pkg?.posts) ? pkg.posts : []).flatMap((p) => [p?.tema, p?.legenda, p?.cta, ...(Array.isArray(p?.hashtags) ? p.hashtags : [p?.hashtags]), p?.imagem]);
  const rots = roteirosOf(pkg).flatMap((r) => [r?.objetivo, r?.curta, r?.email?.assunto, r?.email?.corpo]);
  const cal = (Array.isArray(pkg?.calendario) ? pkg.calendario : []).map((c) => c?.tema);
  const camp = pkg?.campanha ? [pkg.campanha.objetivo_comercial, pkg.campanha.oferta, pkg.campanha.condicao_comercial] : [];
  return [...camp, ...posts, ...rots, ...cal].filter((x) => x != null).map(String).join("\n");
}
// Decisão (AVAL Sol #898): pacote gravado que cita canal banido ou o número banido NÃO é saneado nem exibido —
// é bloqueado na leitura; os bytes gravados ficam intactos e o assinante ativo pode gerar, sem custo, uma versão
// nova no formato atual (chave nova). Sanear texto de IA trocaria o sentido das mensagens sem revisão humana.
export const packageBlocked = (pkg) => contaminated(displayedText(pkg));
export const BLOQUEIO_TEXTO = "Este pacote foi gerado no formato anterior e cita um canal de contato que a ZEVANORY não usa mais. Por segurança ele não é exibido nem reenviado; a versão gravada fica guardada sem alteração. Você pode gerar, sem custo, uma versão nova no formato atual (roteiros multicanal, cada um com versão curta e versão de e-mail).";
const CAL_LABEL = { post: "Post", roteiro: "Roteiro" };
const calLabel = (tipo) => CAL_LABEL[tipo] || "Roteiro";
export const ROTEIROS_TITULO = `${N_ROTEIROS} ROTEIROS MULTICANAL DE VENDA E ACOMPANHAMENTO`;
export const ROTEIROS_AVISO = `Os roteiros são para canais que seus clientes autorizaram, como ${CANAIS_TEXTO}. Use a reativação só com relacionamento ativo ou consentimento registrado. Você revisa antes de usar; não há disparo automático.`;
export function packageText(pkg, name = "") {
  if (packageBlocked(pkg)) return `Seu pacote Conteúdo Pronto — mês ${pkg?.cycle ?? ""}\n\n${BLOQUEIO_TEXTO}\nPeça a versão nova pelo link privado do pacote ou em suporte@zevanory.api.br.`;
  const camp = pkg.campanha;
  const br = (iso) => iso ? iso.split("-").reverse().join("/") : "";
  const lines = [`Seu pacote Conteúdo Pronto — mês ${pkg.cycle}${name ? ` (${name})` : ""}`, ""];
  if (camp) lines.push(`CAMPANHA DO MÊS (${SERVICO})`, `Objetivo comercial: ${camp.objetivo_comercial}`, `Oferta promovida: ${camp.oferta}`, `Condição comercial: ${camp.condicao_comercial}`, `Período: ${br(camp.periodo_inicio)} a ${br(camp.periodo_fim)}`, "");
  lines.push(camp ? "CALENDÁRIO DA CAMPANHA" : "CALENDÁRIO DE 30 DIAS");
  const faseTitulo = Object.fromEntries(CAMPANHA.fases.map((f) => [f.id, f.titulo]));
  for (const c of pkg.calendario) lines.push(c.data ? `${br(c.data)} · ${calLabel(c.tipo)}${c.fase ? " · " + (faseTitulo[c.fase] || c.fase) : ""} · ${c.tema}` : `Dia ${String(c.dia).padStart(2, "0")} · ${calLabel(c.tipo)} · ${c.tema}`);
  lines.push("", `${pkg.posts.length} POSTS`);
  pkg.posts.forEach((p, i) => lines.push("", `POST ${i + 1} — ${p.tema}`, p.legenda, `Chamada: ${p.cta}`, p.hashtags.join(" "), `Imagem sugerida: ${p.imagem || "foto real do seu negócio"}`));
  lines.push("", ROTEIROS_TITULO, ROTEIROS_AVISO);
  roteirosOf(pkg).forEach((r, i) => {
    lines.push("", `ROTEIRO ${i + 1} — ${r.objetivo}`, "Versão curta:", r.curta);
    if (r.email) lines.push("Versão de e-mail:", `Assunto: ${r.email.assunto}`, r.email.corpo);
  });
  lines.push("", "Revise e ajuste o que quiser antes de publicar ou enviar. Fale só com quem autorizou o contato com você.");
  return lines.join("\n");
}

// Pior caso de uma geração (ask: 2 modelos x 2 tentativas + 1 corretiva, por chamada; 3 chamadas por pacote).
export const AI_CALL_TIMEOUT_MS = 60000;
export const AI_ATTEMPTS_PER_MODEL = 2;
export const AI_CALLS_PER_PACKAGE = 3;
export const AI_CORRECTIVE_CALLS = 1;
export const GEN_WORST_CASE_MS = AI_CALLS_PER_PACKAGE * (MODELS.length * AI_ATTEMPTS_PER_MODEL + AI_CORRECTIVE_CALLS) * AI_CALL_TIMEOUT_MS;
export const GEN_LEASE_MS = GEN_WORST_CASE_MS + 3 * 60000;
