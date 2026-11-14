// Shorts v3.4 — alinhamento POR FRASE com eixo de tempo único (proposta v3.4, NC-V34-02/03).
// Prévias reais 43601408721 e 43608351238: alinhando os ~32 s de voz de uma vez, o stable-ts deixou 7–8 palavras
// instantâneas e as últimas ("…link da descrição") em 0 s no fim do áudio. Aqui:
//  1. as pausas são MEDIDAS no próprio WAV (silencedetect); exigem-se exatamente N−1 fronteiras entre as N falas;
//  2. cada fronteira escolhida precisa cair perto do ponto esperado pelo roteiro (proporção de sílabas) — senão não
//     há prova de que a pausa separa as falas certas, e o render volta ao alinhamento inteiro (falha fechada lá);
//  3. o corte é feito em ÍNDICES DE AMOSTRA do mesmo PCM: os trechos são uma partição exata (sem perda, sem
//     sobreposição) e o tempo global = início do trecho (amostra/sr) + tempo do alinhador no trecho;
//  4. cada trecho é alinhado só com o texto da sua fala e precisa COBRIR a fala medida no áudio (1ª palavra perto do
//     início da voz no trecho, última perto do fim); na fala final nenhuma palavra pode ser instantânea.
// Nenhum tempo é inventado: só deslocamento pelo início do trecho.
import {alignedWords} from '../shorts-v2/core.mjs';

export const SILENCIO_DB = -35, SILENCIO_MIN_S = 0.12, TRECHO_MIN_S = 0.6, COBERTURA_MAX_S = 0.6;

// silencedetect -> [{ini, fim}] (segundos). Silêncio aberto no fim do áudio fecha na duração.
export function lerSilencios(stderr, duracao) {
  const out = []; let ini = null;
  for (const l of String(stderr || '').split(/\r?\n/)) {
    const a = l.match(/silence_start:\s*(-?[\d.]+)/), b = l.match(/silence_end:\s*([\d.]+)/);
    if (a) ini = Math.max(0, Number(a[1]));
    if (b && ini !== null) { out.push({ ini, fim: Number(b[1]) }); ini = null; }
  }
  if (ini !== null) out.push({ ini, fim: duracao });
  return out;
}

const silabas = t => (String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[aeiouy]+/g) || []).length || 1;

// Escolhe as N−1 fronteiras e prova que batem com o roteiro. Retorna {ok, cortes:[seg], esperados, motivo}.
export function escolherFronteiras({ silencios, duracao, falas }) {
  const n = falas.length;
  const internos = silencios.filter(s => s.ini > 0.05 && s.fim < duracao - 0.05 && s.fim - s.ini >= SILENCIO_MIN_S);
  if (internos.length < n - 1) return { ok: false, motivo: `pausas_insuficientes:${internos.length}<${n - 1}` };
  const escolhidas = [...internos].sort((a, b) => (b.fim - b.ini) - (a.fim - a.ini)).slice(0, n - 1).sort((a, b) => a.ini - b.ini);
  // Fala útil = do fim do silêncio inicial ao início do silêncio final; o ponto esperado de cada fronteira segue a
  // proporção de sílabas do roteiro. Tolerância: 30% da fala adjacente mais curta, no mínimo 0,8 s.
  const ini0 = silencios.find(s => s.ini <= 0.05)?.fim ?? 0, fimU = silencios.find(s => s.fim >= duracao - 0.05)?.ini ?? duracao;
  const sil = falas.map(silabas), total = sil.reduce((a, b) => a + b, 0), util = fimU - ini0;
  const durEsp = sil.map(s => util * s / total); let acc = ini0; const esperados = [];
  for (let k = 0; k < n - 1; k++) { acc += durEsp[k]; esperados.push(acc); }
  for (let k = 0; k < n - 1; k++) {
    const meio = (escolhidas[k].ini + escolhidas[k].fim) / 2, tol = Math.max(0.8, 0.3 * Math.min(durEsp[k], durEsp[k + 1]));
    if (Math.abs(meio - esperados[k]) > tol) return { ok: false, motivo: `fronteira_incompativel:${k + 1}:${meio.toFixed(2)}~${esperados[k].toFixed(2)}`, esperados };
  }
  const cortes = escolhidas.map(s => (s.ini + s.fim) / 2), limites = [0, ...cortes, duracao];
  for (let k = 0; k < n; k++) if (limites[k + 1] - limites[k] < TRECHO_MIN_S) return { ok: false, motivo: `trecho_curto:${k + 1}` };
  return { ok: true, cortes, esperados, escolhidas };
}

// Partição exata em amostras: [a0=0, a1, …, aN=total). Prova que soma = total e que não há lacuna nem sobreposição.
export function particionar(totalAmostras, sr, cortes) {
  const idx = [0, ...cortes.map(c => Math.round(c * sr)), totalAmostras];
  for (let k = 1; k < idx.length; k++) if (!(idx[k] > idx[k - 1])) throw Error('v3_frases_particao_invalida');
  const trechos = idx.slice(0, -1).map((a, k) => ({ a, b: idx[k + 1], inicio: a / sr, fim: idx[k + 1] / sr }));
  if (trechos.reduce((s, t) => s + (t.b - t.a), 0) !== totalAmostras || trechos[0].a !== 0 || trechos.at(-1).b !== totalAmostras) throw Error('v3_frases_particao_invalida');
  return trechos;
}

// Voz medida dentro do trecho: do fim do silêncio que cobre o início ao começo do silêncio que cobre o fim.
export function vozNoTrecho(silencios, t) {
  let on = t.inicio, off = t.fim;
  for (const s of silencios) { if (s.ini <= on + 1e-6 && s.fim > on) on = Math.min(s.fim, t.fim); if (s.fim >= off - 1e-6 && s.ini < off) off = Math.max(s.ini, t.inicio); }
  return { on, off };
}

// Valida um trecho já deslocado para o eixo global.
export function validarTrecho({ palavras, trecho, voz, final = false }) {
  const m = [];
  if (!palavras.length) return ['trecho_sem_palavras'];
  if (palavras.some(w => w.start < trecho.inicio - 1e-6 || w.end > trecho.fim + 1e-6)) m.push('palavra_fora_do_trecho');
  if (palavras[0].start - voz.on > COBERTURA_MAX_S) m.push(`inicio_da_fala_sem_palavra:${(palavras[0].start - voz.on).toFixed(2)}`);
  if (voz.off - palavras.at(-1).end > COBERTURA_MAX_S) m.push(`${final ? 'voz_final_ausente' : 'fim_da_fala_sem_palavra'}:${(voz.off - palavras.at(-1).end).toFixed(2)}`);
  if (final && palavras.some(w => !(w.end > w.start))) m.push('fala_final_com_palavra_instantanea');
  return m;
}

// Orquestra: pausas -> fronteiras -> partição -> alinhamento por trecho -> eixo único -> validações.
// deps: {silenciosDe(wav,dur), pcmDe(wav)->{amostras:Int16Array|Buffer, sr}, gravarTrecho(pcm, a, b, sr, arquivo),
//        alinharTrecho(arquivo, texto) -> alignment JSON}
export async function alinharPorFrases({ wav, falas, duracao, base, deps, note = () => {} }) {
  const silencios = deps.silenciosDe(wav, duracao);
  const f = escolherFronteiras({ silencios, duracao, falas });
  if (!f.ok) { note('ALIGN_FRASES fallback ' + f.motivo); return { ok: false, motivo: f.motivo }; }
  const { amostras, sr } = deps.pcmDe(wav), trechos = particionar(amostras.length, sr, f.cortes);
  const palavras = [];
  for (let k = 0; k < falas.length; k++) {
    const t = trechos[k], arq = `${base}-frase-${k + 1}.wav`; deps.gravarTrecho(amostras, t.a, t.b, sr, arq);
    let local;
    try {
      const al = await deps.alinharTrecho(arq, falas[k]), n = falas[k].split(/\s+/).filter(Boolean).length;
      local = alignedWords(al, falas[k], t.fim - t.inicio, { toleraDuracaoZero: k === falas.length - 1 ? 0 : Math.floor(n * 0.1) });
    } catch (e) { const motivo = `frase_${k + 1}:${String(e.message || e).slice(0, 80)}`; note('ALIGN_FRASES fallback ' + motivo); return { ok: false, motivo }; }
    const globais = local.map(w => ({ ...w, start: w.start + t.inicio, end: w.end + t.inicio }));
    const m = validarTrecho({ palavras: globais, trecho: t, voz: vozNoTrecho(silencios, t), final: k === falas.length - 1 });
    if (m.length) { const motivo = `frase_${k + 1}:${m.join('+')}`; note('ALIGN_FRASES fallback ' + motivo); return { ok: false, motivo }; }
    palavras.push(...globais);
  }
  const esperado = falas.join(' ').split(/\s+/).filter(Boolean).length;
  if (palavras.length !== esperado) { note('ALIGN_FRASES fallback contagem'); return { ok: false, motivo: 'contagem' }; }
  for (let i = 1; i < palavras.length; i++) if (palavras[i].start < palavras[i - 1].end - 0.02) { note('ALIGN_FRASES fallback ordem'); return { ok: false, motivo: 'ordem' }; }
  note(`ALIGN_FRASES ok trechos=${falas.length} cortes=${f.cortes.map(c => c.toFixed(2)).join(',')}`);
  return { ok: true, alignment: { segments: [{ words: palavras.map(w => ({ word: w.word, start: w.start, end: w.end })) }] }, cortes: f.cortes };
}
