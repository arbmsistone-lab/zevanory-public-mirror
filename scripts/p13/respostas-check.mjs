// P13: verificador do pacote de respostas prontas (docs/p13/respostas-prontas.md). Puro, sem rede.
// Recusa: dado pessoal (e-mail fora do canal oficial, CPF, telefone), preço, campo fora da lista, chamada de
// compra, frase proibida da política, decisão desconhecida, falta da marcação de revisão humana, decisão sensível
// sem revisão OBRIGATÓRIA, resposta pública sem revisão OBRIGATÓRIA e texto de prazo diferente da política única.
import { bannedPolicyHits, hasCheckoutCta, CUSTOMER_RULE_7D, SUPPORT_EMAIL } from "../../worker/politica-unica.mjs";

export const CAMPOS_PERMITIDOS = Object.freeze(new Set(["PROTOCOLO", "DATA_SOLICITACAO", "PRAZO", "PRODUTO"]));
export const DECISOES = Object.freeze(new Set(["n/a", "aprovar_arrependimento", "fora_do_prazo", "fora_do_prazo_vicio",
  "contestacao_em_andamento", "excecao_autorizada", "ja_reembolsado", "em_andamento"]));
export const CATEGORIAS_SENSIVEIS = Object.freeze(new Set(["excecao", "juridico", "dado_pessoal", "contestacao", "vicio"]));
const PUBLICAS = /^(RA|CG)-/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
const TELEFONE = /(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/;

export function parsePack(md) {
  const out = [];
  const re = /^### ([A-Z]{2}-\d{2}) · (.+)\n- Categoria: (.+)\n- Decisão de origem: (.+)\n- Revisão humana: (.+)\n```text\n([\s\S]*?)\n```/gm;
  for (const m of String(md).replace(/\r\n/g, "\n").matchAll(re))
    out.push({ id: m[1], titulo: m[2].trim(), categoria: m[3].trim(), decisao: m[4].trim(), revisao: m[5].trim(), texto: m[6] });
  return out;
}

export function checkTemplate(t) {
  const p = [];
  for (const e of t.texto.match(EMAIL) || []) if (e.toLowerCase() !== SUPPORT_EMAIL) p.push("email_nao_oficial");
  if (CPF.test(t.texto)) p.push("cpf");
  if (TELEFONE.test(t.texto)) p.push("telefone");
  if (/R\$\s?\d/.test(t.texto)) p.push("preco");
  for (const m of t.texto.matchAll(/\{([A-Z_]+)\}/g)) if (!CAMPOS_PERMITIDOS.has(m[1])) p.push("campo_nao_permitido:" + m[1]);
  if (/\{[^}]*[a-z][^}]*\}/.test(t.texto)) p.push("campo_malformado");
  if (hasCheckoutCta(t.texto)) p.push("chamada_de_compra");
  for (const h of bannedPolicyHits(t.texto)) p.push("frase_proibida:" + h);
  if (!DECISOES.has(t.decisao)) p.push("decisao_desconhecida");
  const obrigatoria = /^OBRIGATÓRIA\b/.test(t.revisao);
  if (!obrigatoria && !/^dispensada \(/.test(t.revisao)) p.push("revisao_sem_marcacao");
  if (CATEGORIAS_SENSIVEIS.has(t.categoria) && !obrigatoria) p.push("sensivel_sem_revisao_obrigatoria");
  if (PUBLICAS.test(t.id) && !obrigatoria) p.push("publica_sem_revisao_obrigatoria");
  if (t.categoria === "reembolso_fora_do_prazo" && !t.texto.includes(CUSTOMER_RULE_7D)) p.push("prazo_diferente_da_politica");
  if (!t.texto.includes("{PROTOCOLO}")) p.push("sem_protocolo");
  return p;
}

export function checkPack(md, { exigidos = ["RA", "CG", "HM"] } = {}) {
  const ts = parsePack(md);
  const problemas = [];
  const ids = new Set();
  for (const t of ts) {
    if (ids.has(t.id)) problemas.push(t.id + ":id_repetido");
    ids.add(t.id);
    for (const x of checkTemplate(t)) problemas.push(t.id + ":" + x);
  }
  for (const pre of exigidos) if (!ts.some((t) => t.id.startsWith(pre + "-"))) problemas.push("faltando_plataforma:" + pre);
  return { ok: problemas.length === 0, total: ts.length, problemas };
}
