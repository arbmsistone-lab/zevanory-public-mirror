// Diagnosticador v1 (Plano Mestre ZEVANORY v1.2, seções 2 e 4; F1 item 5). Regras versionadas em
// data/regras-diagnostico.json. Implementa SÓ a regra CANAL_PARADO: para cada canal ativo, publicações reais menores
// que as esperadas no dia (depois da hora limite do canal) geram um diagnóstico com o motivo lido das chaves de status
// do dia. O módulo só diagnostica e reporta (relatório diário das 20h): nenhuma ação automática, nenhuma gravação,
// nenhum segredo. Também calcula o índice REAL de autonomia (seção 6): concluídas sem comando ÷ devidas; sem fonte,
// "não medido", nunca 100.
import REGRAS from "../data/regras-diagnostico.json" with { type: "json" };

export const REGRAS_DIAGNOSTICO = REGRAS;
export const ACQUISITION_DAILY_PREFIX = "zpc:acquisition:daily:";
const AGUARDANDO = /^aguardando/;

export const weekdayOf = (day) => new Date(String(day) + "T12:00:00Z").getUTCDay();
const readJson = async (kv, key) => {
  if (!kv?.get) return { ok: false, v: null };
  try { return { ok: true, v: JSON.parse(String((await kv.get(key)) || "null")) }; } catch { return { ok: false, v: null }; }
};

// Publicações esperadas de um canal no dia local, já vencidas na hora local informada (24 = dia encerrado).
// Canal com ativacao "desligada" (ex.: Telegram, decisão F0 nº 7 do proprietário) nunca é devido, qualquer que seja a
// agenda: sem CANAL_PARADO e fora do denominador da autonomia.
export function esperadasNoDia(canal, day, hour, regras = REGRAS) {
  const c = regras?.canais?.[canal];
  if (!c || c.ativacao === "desligada") return 0;
  if (!(Array.isArray(c.dias_semana) && c.dias_semana.includes(weekdayOf(day)))) return 0;
  if (!(Number(hour) >= Number(c.hora_limite))) return 0;
  return Math.max(0, Math.floor(Number(c.esperadas_por_dia) || 0));
}

// Canal ativo: automático sempre; por credencial só com a credencial configurada (channelChecklist); desligado nunca.
export function canaisAtivos(checklist = [], regras = REGRAS) {
  const out = {};
  for (const [canal, c] of Object.entries(regras?.canais || {})) {
    if (c.ativacao === "automatica") out[canal] = { ativo: true, motivo: null };
    else if (c.ativacao === "desligada") out[canal] = { ativo: false, desligado: true, motivo: c.motivo_desligado || "desligado" };
    else {
      const row = (Array.isArray(checklist) ? checklist : []).find((x) => x?.id === canal);
      out[canal] = row?.configured === true ? { ativo: true, motivo: null } : { ativo: false, motivo: row?.external_verification_pending ? "aguardando aprovação" : "aguardando credencial" };
    }
  }
  return out;
}

// Concluída sem comando (auditoria do #1021): publicada E disparada pelo cron ("cron" gravado pelo motor). Disparo
// manual, workflow_dispatch, correção externa (agente de engenharia) ou registro sem trigger NÃO contam como autônomos.
export const TRIGGER_AUTONOMO = "cron";
export const semComando = (row) => row?.status === "publicado" && row?.trigger === TRIGGER_AUTONOMO && row?.manual !== true;

// Motivo, das chaves de status do dia: rejeição do gate do blog > código do provedor/gate > status > ausência de registro.
export function motivoDe(row, blogStatus, fonte) {
  if (blogStatus?.resultado === "rejeitado") return "gate do blog: " + (Array.isArray(blogStatus.motivos) ? blogStatus.motivos.join(",") : "sem motivo");
  if (row?.code) return String(row.code).slice(0, 120);
  if (row?.status && row.status !== "publicado") return String(row.status).slice(0, 60);
  if (fonte === "falha_leitura") return "falha ao ler as chaves de status do dia";
  return "sem_registro: o motor não registrou execução do canal no dia";
}

export function classeDoMotivo(motivo, regras = REGRAS) {
  const m = String(motivo || "");
  return Object.entries(regras?.classe_por_motivo || {}).some(([k]) => m === k || m.includes(k)) ? "D" : "B";
}

// Lê o estado do dia (zpc:acquisition:daily:<dia>), o detalhe por canal (zpc:acquisition:daily:<dia>:<canal>) e a chave de
// status própria do canal, quando a regra declara uma (blog: zpc:blog:status:v1:<dia>). Só leitura.
export async function lerStatusDoDia(kv, day, regras = REGRAS) {
  const estado = await readJson(kv, ACQUISITION_DAILY_PREFIX + day);
  const fonte = !estado.ok ? "falha_leitura" : estado.v ? "registro" : "sem_registro";
  const porCanal = {};
  for (const [canal, c] of Object.entries(regras?.canais || {})) {
    const detalhe = c.ativacao === "desligada" ? { ok: true, v: null } : await readJson(kv, ACQUISITION_DAILY_PREFIX + day + ":" + canal);
    const resumo = (Array.isArray(estado.v?.outcomes) ? estado.v.outcomes : []).find((o) => o?.channel === canal) || null;
    const blogStatus = c.chave_status ? (await readJson(kv, String(c.chave_status).replace("{dia}", day))).v : null;
    const row0 = detalhe.v || resumo;
    // O detalhe por canal não guarda o trigger: vem do outcome do estado do dia (ou do próprio estado).
    const row = row0 ? { ...row0, trigger: row0.trigger ?? resumo?.trigger ?? estado.v?.trigger ?? null } : null;
    const okBlog = blogStatus?.resultado === "ok";
    const publicada = row?.status === "publicado" || okBlog;
    porCanal[canal] = {
      publicadas: publicada ? 1 : 0,
      semComando: (semComando(row) || (okBlog && semComando({ status: "publicado", trigger: row?.trigger }))) ? 1 : 0,
      status: okBlog ? "publicado" : row?.status || null,
      url: row?.url || (okBlog ? blogStatus.url : null) || null,
      id: row?.provider_post_id ? String(row.provider_post_id).slice(0, 120) : null,
      motivo: publicada ? null : motivoDe(row, blogStatus, detalhe.ok ? fonte : "falha_leitura"),
    };
  }
  return { day, fonte, porCanal };
}

// Regra CANAL_PARADO (v1): só diagnostica. acao_automatica fica "nenhuma" até o Decisor existir (F2).
export function diagnosticarDia({ day, hour, ativos = {}, status = { porCanal: {} }, regras = REGRAS } = {}) {
  const regra = (regras?.regras || []).find((r) => r.id === "CANAL_PARADO" && r.ativa === true);
  if (!regra) return [];
  const out = [];
  for (const canal of Object.keys(regras?.canais || {})) {
    if (ativos[canal]?.ativo !== true) continue;
    const esperadas = esperadasNoDia(canal, day, hour, regras);
    const s = status.porCanal?.[canal] || {};
    const publicadas = Number(s.publicadas) || 0;
    if (publicadas >= esperadas) continue;
    const motivo = s.motivo || motivoDe(null, null, status.fonte);
    out.push({ regra: "CANAL_PARADO", versao_regra: regra.versao, versao_regras: regras.versao, dia: day, canal, esperadas, publicadas, motivo, classe: classeDoMotivo(motivo, regras), acao_automatica: "nenhuma" });
  }
  return out;
}

export function indiceAutonomia({ devidas = 0, concluidas = 0, fonteOk = false } = {}) {
  const d = Math.max(0, Number(devidas) || 0), c = Math.min(d, Math.max(0, Number(concluidas) || 0));
  if (!fonteOk || d === 0) return { valor: null, texto: "não medido", devidas: d, concluidas: c, formula: "concluídas sem comando ÷ devidas" };
  const valor = Math.round((1000 * c) / d) / 10;
  return { valor, texto: `${String(valor).replace(".", ",")}% (${c} de ${d} devidas concluídas sem comando)`, devidas: d, concluidas: c, formula: "concluídas sem comando ÷ devidas" };
}

// Autonomia do dia: soma, nos canais ativos, as publicações devidas até a hora e as concluídas sem comando.
export function autonomiaDoDia({ day, hour, ativos = {}, status = { porCanal: {} }, regras = REGRAS } = {}) {
  let devidas = 0, concluidas = 0;
  for (const canal of Object.keys(regras?.canais || {})) {
    if (ativos[canal]?.ativo !== true) continue;
    const e = esperadasNoDia(canal, day, hour, regras);
    devidas += e; concluidas += Math.min(e, Number(status.porCanal?.[canal]?.semComando) || 0);
  }
  return indiceAutonomia({ devidas, concluidas, fonteOk: status.fonte === "registro" });
}

// Autonomia de uma janela (painel/snapshot): byDay = {dia: {canal: {status, ...}}} vindo do registro de ações no KV.
// Dia sem registro não entra (sem fonte). Canal por credencial sem registro ou "aguardando ..." no dia não é devido.
export function autonomiaDaJanela(byDay = {}, { hoje = null, horaHoje = 24, regras = REGRAS } = {}) {
  let devidas = 0, concluidas = 0, diasComFonte = 0;
  for (const [day, entries] of Object.entries(byDay || {})) {
    if (!entries || !Object.keys(entries).length) continue;
    diasComFonte++;
    const hour = day === hoje ? horaHoje : 24;
    for (const [canal, c] of Object.entries(regras?.canais || {})) {
      if (c.ativacao === "desligada") continue;
      const e = entries[canal];
      if (c.ativacao === "credencial" && (!e || AGUARDANDO.test(String(e.status || "")))) continue;
      const esp = esperadasNoDia(canal, day, hour, regras);
      if (!esp) continue;
      devidas += esp; if (semComando(e)) concluidas += 1;
    }
  }
  return { ...indiceAutonomia({ devidas, concluidas, fonteOk: diasComFonte > 0 }), diasComFonte, fonte: "zpc:acquisition:daily:<dia>[:<canal>] (registro de ações)" };
}
