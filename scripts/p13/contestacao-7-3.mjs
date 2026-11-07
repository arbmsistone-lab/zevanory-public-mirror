// P13 (roteiro v4.9.1, seção 7.3): procedimento operacional de contestação (chargeback) e disputa, em todos os
// canais, como máquina de estados PURA (sem rede, sem gravação). Etapas: receber o aviso → registrar com protocolo
// → reunir a evidência de entrega (registros de acesso e de envio) COM mascaramento → responder dentro do prazo da
// plataforma → registrar o resultado → alimentar P24 e P25. Acesso ao produto só é suspenso conforme a política
// publicada e o CDC, com registro. Disputa perdida por falha de entrega é falha crítica de P12.
// Documento: docs/p13/procedimento-contestacao-7-3.md.
const TIPOS_EVIDENCIA = new Set(["registro_acesso", "registro_envio", "termos_aceitos", "comunicacao", "politica_publicada"]);
const RESULTADOS = new Set(["favoravel", "desfavoravel"]);
const PROTOCOLO = /^[A-Z0-9][A-Z0-9-]{5,40}$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_PERMITIDO = "suporte@zevanory.api.br";
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
const TELEFONE = /(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/;
const ms = (v) => { const t = typeof v === "number" ? v : Date.parse(String(v ?? "")); return Number.isFinite(t) ? t : null; };

export class ContestacaoError extends Error { constructor(code) { super(code); this.code = code; } }

export function mascararEmail(email) {
  const [u, d] = String(email).split("@");
  const [host, ...rest] = String(d || "").split(".");
  return (u || "").slice(0, 1) + "***@" + (host || "").slice(0, 1) + "***." + rest.join(".");
}

// Texto de evidência sem dado pessoal em claro: e-mail (exceto o canal oficial) só mascarado, sem CPF nem telefone.
export function problemasDePrivacidade(texto) {
  const s = String(texto ?? "");
  const p = [];
  for (const m of s.match(EMAIL) || []) if (m.toLowerCase() !== EMAIL_PERMITIDO && !m.includes("***")) p.push("email_em_claro");
  if (CPF.test(s)) p.push("cpf");
  if (TELEFONE.test(s)) p.push("telefone");
  return [...new Set(p)];
}

export function novaContestacao() { return { estado: "inexistente", historico: [] }; }

export function avancar(c, evento, ctx = {}) {
  const at = ms(ctx.agora);
  if (at == null) throw new ContestacaoError("relogio_invalido");
  const next = { ...c, historico: [...(c.historico || [])] };
  const log = (tipo, extra = {}) => next.historico.push({ tipo, em: new Date(at).toISOString(), ...extra });
  switch (evento) {
    case "receber_aviso":
      if (c.estado !== "inexistente") throw new ContestacaoError("aviso_repetido");
      if (!["hotmart", "mercadopago"].includes(ctx.plataforma)) throw new ContestacaoError("plataforma_desconhecida");
      Object.assign(next, { estado: "recebida", plataforma: ctx.plataforma });
      log("aviso_recebido");
      return next;
    case "registrar":
      if (c.estado !== "recebida") throw new ContestacaoError("fora_de_ordem");
      if (!PROTOCOLO.test(String(ctx.protocolo || ""))) throw new ContestacaoError("protocolo_invalido");
      if (ms(ctx.prazo_plataforma_ate) == null) throw new ContestacaoError("prazo_da_plataforma_nao_registrado");
      Object.assign(next, { estado: "registrada", protocolo: ctx.protocolo, prazo_ate: ms(ctx.prazo_plataforma_ate) });
      log("registrada", { protocolo: ctx.protocolo });
      return next;
    case "reunir_evidencia": {
      if (c.estado !== "registrada") throw new ContestacaoError("fora_de_ordem");
      const itens = Array.isArray(ctx.itens) ? ctx.itens : [];
      if (!itens.some((i) => i?.tipo === "registro_acesso" || i?.tipo === "registro_envio")) throw new ContestacaoError("sem_evidencia_de_entrega");
      for (const i of itens) {
        if (!TIPOS_EVIDENCIA.has(i?.tipo)) throw new ContestacaoError("tipo_de_evidencia_desconhecido");
        if (problemasDePrivacidade(i?.texto).length) throw new ContestacaoError("dado_pessoal_em_claro");
      }
      Object.assign(next, { estado: "evidencia_reunida", evidencias: itens.map((i) => ({ tipo: i.tipo, texto: String(i.texto) })) });
      log("evidencia_reunida", { itens: itens.length });
      return next;
    }
    case "responder":
      if (c.estado !== "evidencia_reunida") throw new ContestacaoError("fora_de_ordem");
      if (ctx.revisado_por !== "proprietario") throw new ContestacaoError("revisao_humana_obrigatoria");
      if (at > c.prazo_ate) { Object.assign(next, { estado: "prazo_perdido" }); log("prazo_perdido", { alerta: "proprietario" }); return next; }
      Object.assign(next, { estado: "respondida" });
      log("respondida");
      return next;
    case "registrar_resultado": {
      if (!["respondida", "prazo_perdido"].includes(c.estado)) throw new ContestacaoError("fora_de_ordem");
      if (!RESULTADOS.has(ctx.resultado)) throw new ContestacaoError("resultado_invalido");
      const falhaCriticaP12 = ctx.resultado === "desfavoravel" && ctx.causa === "falha_entrega";
      Object.assign(next, { estado: "encerrada", resultado: ctx.resultado, causa: ctx.causa || null,
        falha_critica: falhaCriticaP12 ? "P12" : null, alimenta: ["P24", "P25"] });
      log("encerrada", { resultado: ctx.resultado });
      return next;
    }
    case "suspender_acesso":
      if (c.estado === "inexistente") throw new ContestacaoError("fora_de_ordem");
      if (typeof ctx.base_politica !== "string" || ctx.base_politica.trim().length < 8) throw new ContestacaoError("suspensao_sem_base_na_politica");
      if (ctx.revisado_por !== "proprietario") throw new ContestacaoError("revisao_humana_obrigatoria");
      next.acesso_suspenso = true;
      log("acesso_suspenso", { base_politica: ctx.base_politica });
      return next;
    default:
      throw new ContestacaoError("evento_desconhecido");
  }
}
