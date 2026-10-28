// Conteúdo Pronto v3 (campanha mensal de promoção de vendas): campanha de exemplo para os testes e um adaptador que
// faz a IA falsa responder ANCORADA na campanha do prompt (cita a oferta, a condição e uma fase por post), como o
// contrato exige. Os textos são fictícios.
import { FASES } from "../../worker/content-service.mjs";

// Datas relativas a hoje (o formulário recusa início no passado ou a mais de CAMPANHA_INICIO_MAX_DIAS dias).
export const isoDay = (offsetDays, from = Date.now()) => new Date(Date.parse(new Date(from).toISOString().slice(0, 10) + "T00:00:00Z") + offsetDays * 86400000).toISOString().slice(0, 10);
export const plusDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export const CAMPAIGN = Object.freeze({
  objetivo_comercial: "Lotar a agenda das quartas-feiras",
  oferta: "Escova Quarta Feliz",
  condicao_comercial: "15% na segunda escova da mesma visita",
  periodo_inicio: isoDay(5),
  periodo_fim: isoDay(32),
});
export const CAMPAIGN_MONTH2 = Object.freeze({ ...CAMPAIGN, oferta: "Hidratação de Dezembro", condicao_comercial: "preço normal", periodo_inicio: isoDay(35), periodo_fim: isoDay(54) });

// Lê a campanha do prompt (linhas "Oferta promovida:" e "Condição comercial:") e ajusta a resposta da IA falsa.
export function campaignize(prompt, payload) {
  const oferta = /Oferta promovida: (.+)/.exec(prompt)?.[1]?.trim();
  const cond = /Condição comercial: (.+)/.exec(prompt)?.[1]?.trim();
  if (!oferta) return payload;
  const from = Number(/posts (\d+) a/.exec(prompt)?.[1] || 1);
  if (Array.isArray(payload.posts)) {
    payload = { ...payload, posts: payload.posts.map((p, i) => ({ ...p, fase: FASES[(from - 1 + i) % FASES.length].id, legenda: `${p.legenda} ${oferta}.`.slice(0, 1600) })) };
  }
  if (Array.isArray(payload.roteiros)) {
    payload = { ...payload, roteiros: payload.roteiros.map((r) => ({ ...r, curta: `${r.curta} ${oferta}.`, email: r.email ? { ...r.email, corpo: `${r.email.corpo} ${oferta}: ${cond}.` } : r.email })) };
  }
  return payload;
}
