import { createHash } from "node:crypto";
// Retomada controlada dos Shorts (Plano Mestre v1.2, F1). Sem I/O; hash usa node:crypto. Os testes de
// mutantes possam copiar este arquivo para um diretório temporário e importá-lo mutado.
// - rampa: 1 Short por dia; sobe para 2 e 3 por dia só com dias limpos seguidos (QC ok, volume cumprido, sem aviso);
// - texto: roteiro, tela, título, descrição e tags nunca citam WhatsApp (canal banido) nem lista de espera;
// - CTA: só /hotmart/<slug> (modo Hotmart) ou uma calculadora gratuita, sempre com UTM do YouTube;
// - preflight do canal: público somente sem restrição; restrição congela, indisponibilidade só pula o dia.

export const CANAL_ESPERADO = "UCMl8-SxMVv77S2tz2H63P3A";
export const SITE_VENDAS = "vendas.zevanory.api.br";

// WhatsApp em qualquer grafia (inclusive "zap" e links wa.me) e lista de espera: proibidos em todo texto do Short.
export const TEXTO_PROIBIDO = Object.freeze([
  ["whatsapp", /whats\s*-?\s*app|uótsap|\bzap(?:zap)?\b|wa\.me\b|api\.whatsapp\.com/i],
  ["lista_de_espera", /lista\s+de\s+espera|waitlist/i],
]);

export function textoProibido(texto) {
  const s = String(texto ?? "");
  return TEXTO_PROIBIDO.filter(([, re]) => re.test(s)).map(([id]) => id);
}

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const HOTMART_PATH = new RegExp("^/hotmart/" + SLUG + "$");
const CALC_PATH = new RegExp("^/calculadora-" + SLUG + "$");

// CTA permitido: https://vendas.zevanory.api.br/hotmart/<slug> (só com o modo Hotmart aberto) ou
// https://vendas.zevanory.api.br/calculadora-<x>, com utm_source=youtube, utm_medium e utm_campaign.
export function ctaPermitido(link, { hotmartOpen = false } = {}) {
  let u;
  try { u = new URL(String(link)); } catch { return { ok: false, motivo: "cta_invalido" }; }
  if (u.protocol !== "https:" || u.hostname !== SITE_VENDAS || u.username || u.password || u.hash) return { ok: false, motivo: "cta_fora_do_site_de_vendas" };
  const hotmart = HOTMART_PATH.test(u.pathname), calc = CALC_PATH.test(u.pathname);
  if (!hotmart && !calc) return { ok: false, motivo: "cta_fora_da_politica" };
  if (hotmart && hotmartOpen !== true) return { ok: false, motivo: "cta_hotmart_com_modo_hotmart_fechado" };
  const q = u.searchParams;
  if (q.get("utm_source") !== "youtube" || !q.get("utm_medium") || !q.get("utm_campaign")) return { ok: false, motivo: "cta_sem_utm" };
  return { ok: true, tipo: hotmart ? "hotmart" : "calculadora" };
}

// Todas as violações de um plano de Short (vazio = pode seguir para o gate F1 normal).
export function violacoesShort(plan, { hotmartOpen = false } = {}) {
  const p = plan || {};
  const campos = [p.title, p.description, p.speech, ...(p.said || []).flat(), ...Object.values(p.screen || {}), ...(p.tags || []), ...(p.lines || []), p.link];
  const out = textoProibido(campos.map((x) => (x == null ? "" : String(x))).join("\n"));
  const cta = ctaPermitido(p.link, { hotmartOpen });
  if (!cta.ok) out.push(cta.motivo);
  else if (!String(p.description || "").includes(String(p.link))) out.push("cta_ausente_da_descricao");
  return out;
}

const DIA_MS = 86400000;
const diaValido = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)) && !Number.isNaN(Date.parse(d + "T12:00:00Z"));
export function somarDias(dia, n) { return new Date(Date.parse(dia + "T12:00:00Z") + n * DIA_MS).toISOString().slice(0, 10); }

// Dias anteriores a `dia` que contam para a rampa (do mais antigo ao de ontem), limitados pela janela e pelo início.
export function diasDaJanela(config, dia) {
  if (!diaValido(dia)) return [];
  const janela = Math.max(0, Math.min(90, Number(config?.janela_maxima_dias) || 0));
  const inicio = diaValido(config?.contar_a_partir_de) ? config.contar_a_partir_de : dia;
  const out = [];
  for (let i = janela; i >= 1; i--) { const d = somarDias(dia, -i); if (d >= inicio) out.push(d); }
  return out;
}

// Nível da rampa no dia `dia`, recalculado a partir do histórico (sem estado gravado):
// historico[d] = { publicados: <Shorts públicos no dia>, qc_falha: <bool>, aviso: <bool> }.
export function nivelRampa({ config, dia, historico = {}, avisoHoje = false } = {}) {
  const niveis = Array.isArray(config?.niveis) ? config.niveis : [];
  if (!niveis.length) return { nivel: 0, por_dia: 0, slots: [], dias_limpos: 0, motivo: "rampa_sem_niveis" };
  let nivel = 1, limpos = 0;
  for (const d of diasDaJanela(config, dia)) {
    const h = historico[d] || {};
    if (h.qc_falha === true && config.qc_falha_desce_um_nivel !== false) { nivel = Math.max(1, nivel - 1); limpos = 0; continue; }
    const atual = niveis[nivel - 1];
    if (h.aviso === true || !(Number(h.publicados) >= atual.por_dia)) { limpos = 0; continue; }
    limpos += 1;
    if (atual.dias_limpos_para_subir && limpos >= atual.dias_limpos_para_subir && nivel < niveis.length) { nivel += 1; limpos = 0; }
  }
  const n = niveis[nivel - 1];
  if (avisoHoje === true) return { nivel, por_dia: 0, slots: [], dias_limpos: limpos, motivo: "canal_com_aviso" };
  return { nivel, por_dia: n.por_dia, slots: [...n.slots], dias_limpos: limpos, motivo: "nivel_" + nivel };
}

// Decide se um slot pode ser publicado agora, dado o nível do dia e quantos Shorts já saíram hoje (outros slots).
export function decisaoSlot({ rampa, slot, publicadosHoje = 0, congelado = false } = {}) {
  if (congelado === true) return { publicar: false, motivo: "canal_congelado" };
  if (!rampa || !Array.isArray(rampa.slots) || !rampa.slots.includes(slot)) return { publicar: false, motivo: "slot_fora_da_rampa" };
  if (!(Number(publicadosHoje) < rampa.por_dia)) return { publicar: false, motivo: "limite_diario_da_rampa" };
  return { publicar: true, motivo: "rampa_ok" };
}

// Preflight do canal (channels?part=id,status&mine=true). "ok" publica; "restricao" congela; "indisponivel" só pula
// o dia (falha de rede ou da API não congela o canal). Sinal ausente = indisponivel (fail-closed, sem congelar).
export function avaliarPreflight(resp, { canalEsperado = CANAL_ESPERADO, avisoManual = false } = {}) {
  if (avisoManual === true) return { estado: "restricao", motivos: ["aviso_manual_do_proprietario"] };
  if (!resp || resp.ok !== true) return { estado: "indisponivel", motivos: ["preflight_http_" + String(resp?.status ?? "erro").replace(/[^a-z0-9_]/gi, "")] };
  const items = Array.isArray(resp.json?.items) ? resp.json.items : [];
  if (items.length !== 1 || items[0]?.id !== canalEsperado) return { estado: "restricao", motivos: ["canal_divergente"] };
  const st = items[0].status;
  if (!st || typeof st !== "object") return { estado: "indisponivel", motivos: ["preflight_sem_status"] };
  const motivos = [];
  if (st.privacyStatus !== "public") motivos.push("canal_nao_publico_" + String(st.privacyStatus || "desconhecido").replace(/[^a-z]/gi, ""));
  // Strikes e restrições revogam os recursos intermediários (vídeos longos): "disallowed" é sinal de restrição.
  if (st.longUploadsStatus === "disallowed") motivos.push("recursos_intermediarios_revogados");
  else if (!["allowed", "eligible"].includes(st.longUploadsStatus)) return { estado: "indisponivel", motivos: ["preflight_sem_sinal_de_recursos"] };
  if (st.madeForKids === true) motivos.push("canal_marcado_para_criancas");
  return motivos.length ? { estado: "restricao", motivos } : { estado: "ok", motivos: [] };
}

// Depois do upload: o YouTube devolveu outra visibilidade que não a pedida = restrição do provedor (congela).
export function avaliarPosUpload(result, pedido = "public") {
  if (!result) return { estado: "indisponivel", motivos: ["sem_resultado"] };
  if (result.privacy_status !== pedido) return { estado: "restricao", motivos: ["provedor_mudou_visibilidade_" + String(result.privacy_status || "desconhecida").replace(/[^a-z]/gi, "")] };
  return { estado: "ok", motivos: [] };
}

// Congelamento por EPISÓDIO (NC-F1-A5-01). Cada restrição grava um episódio com id próprio (instante + motivos).
// O proprietário libera um episódio pelo id exato em data/shorts-rampa.json (canal.congelamento_liberado_id); a
// liberação nunca vale para um episódio posterior, nem do mesmo dia. Registro presente mas ilegível ou sem id conta
// como episódio ATIVO, id ilegivel:<sha256(raw)[0:16]>. A liberação não cobre conteúdo corrompido diferente.
export const ID_ILEGIVEL = "ilegivel";
export const idCorrupcao=raw=>ID_ILEGIVEL+":"+createHash("sha256").update(String(raw)).digest("hex").slice(0,16);
export function idEpisodio(registro) {
  if (registro == null) return null;
  const id = typeof registro === "object" ? registro.episodio_id : null;
  return typeof id === "string" && id.length > 0 ? id : idCorrupcao(typeof registro==="string"?registro:JSON.stringify(registro));
}
export function congelamentoAtivo({ config, registro } = {}) {
  const id = idEpisodio(registro);
  if (id == null) return false;
  return id !== config?.canal?.congelamento_liberado_id;
}
export function novoEpisodio({ dia, motivos = [], now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const m = (Array.isArray(motivos) ? motivos : []).map((x) => String(x).replace(/[^a-z0-9_]/gi, "")).filter(Boolean);
  return { episodio_id: at + "|" + (m.join("+") || "sem_motivo"), desde: dia, at, motivos: m, liberar: "data/shorts-rampa.json canal.congelamento_liberado_id = este episodio_id, depois da checagem no YouTube Studio" };
}
// Leitura do congelamento: {erro:true} quando o KV falha (quem chama trata como NÃO publicar, nunca como ok);
// valor ilegível vira registro sem id (episódio ativo).
export async function lerCongelamento(kv) {
  if (!kv?.get) return { erro: true, registro: null };
  let raw;
  try { raw = await kv.get(CHAVE_CONGELADO); } catch { return { erro: true, registro: null }; }
  if (raw == null) return { erro: false, registro: null };
  let v;try{v=JSON.parse(String(raw));}catch{}
  const valid=v&&typeof v==="object"&&typeof v.episodio_id==="string"&&v.episodio_id.length>0;
  return {erro:false,registro:valid?v:{episodio_id:idCorrupcao(raw),ilegivel:true}};
}
// Registra um novo episódio. Só não grava se já houver episódio ATIVO (não liberado): esse continua valendo.
// Episódio liberado é substituído pelo novo. Falha de leitura grava mesmo assim (congelar é o lado seguro).
export async function congelarEpisodio(kv, { config, dia, motivos, now = Date.now() } = {}) {
  if (!kv?.put) return { gravado: false, motivo: "sem_kv" };
  const atual = await lerCongelamento(kv);
  if (!atual.erro && congelamentoAtivo({ config, registro: atual.registro })) return { gravado: false, motivo: "episodio_ativo", episodio_id: idEpisodio(atual.registro) };
  const ep = novoEpisodio({ dia, motivos, now });
  await kv.put(CHAVE_CONGELADO, JSON.stringify(ep));
  return { gravado: true, episodio_id: ep.episodio_id };
}

// Falhas que contam como "QC de áudio e vídeo reprovado" (descem um nível). Voz indisponível não é QC: só perde o dia.
export const QC_FALHA_RE = /^(audio_qc_failed|youtube_mp4_technical_gate_failed|youtube_black_frames_detected)/;
export const eQcFalha = (mensagem) => QC_FALHA_RE.test(String(mensagem || ""));

// Gravação no KV no máximo uma vez por chave: lê antes e só grava se ausente.
export async function gravarUmaVez(kv, chave, valor, opts = {}) {
  if (!kv?.get || !kv?.put) return { gravado: false, motivo: "sem_kv" };
  if ((await kv.get(chave)) != null) return { gravado: false, motivo: "ja_registrado" };
  await kv.put(chave, JSON.stringify(valor), opts);
  return { gravado: true };
}

export const CHAVE_STATUS_DIA = (dia) => "zpc:shorts:rampa:" + dia;
export const CHAVE_QC_FALHA = (dia) => "zpc:shorts:qc:" + dia;
export const CHAVE_CONGELADO = "zpc:shorts:congelado:v1";
export const CHAVES_PUBLICADO = Object.freeze({ dica: "youtube_dica", calc: "youtube_calc", oferta: "youtube" });
