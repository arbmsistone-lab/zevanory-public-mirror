// Shorts v3.4 — alinhamento POR FRASE com eixo de tempo único (proposta v3.4, NC-V34-02/03).
// Prévias reais 43601408721 e 43608351238: alinhando os ~32 s de voz de uma vez, o stable-ts deixou 7–8 palavras
// instantâneas e as últimas ("…link da descrição") em 0 s no fim do áudio. Aqui:
//  1. as pausas são MEDIDAS no próprio WAV (silencedetect); escolhem-se N−1 delas como fronteiras (atribuição ordenada);
//  2. cada fronteira escolhida precisa cair perto do ponto esperado pelo roteiro (proporção de sílabas) — senão não
//     há prova de que a pausa separa as falas certas, e o render volta ao alinhamento inteiro (falha fechada lá);
//  3. o corte é feito em ÍNDICES DE AMOSTRA do mesmo PCM: os trechos são uma partição exata (sem perda, sem
//     sobreposição) e o tempo global = início do trecho (amostra/sr) + tempo do alinhador no trecho;
//  4. cada trecho é alinhado só com o texto da sua fala e precisa COBRIR a fala medida no áudio (1ª palavra perto do
//     início da voz no trecho, última perto do fim); na fala final nenhuma palavra pode ser instantânea.
// Nenhum tempo é inventado: só deslocamento pelo início do trecho.
import {alignedWords} from '../shorts-v2/core.mjs';

export const SILENCIO_DB = -35, SILENCIO_MIN_S = 0.12, TRECHO_MIN_S = 0.6, COBERTURA_MAX_S = 0.6;
// Ensaios reais 43625938908 (0,60 s) e 43635724926 (0,61 s): na fala 1, que termina em pergunta ("…desaparece?"), o
// TTS alonga e deixa DECAIR o fim; o silencedetect (−35 dB) conta o decaimento como voz e a cobertura reprovava por
// 0,01 s. Uma palavra perdida é fala com volume de fala; um decaimento é bem mais baixo. Por isso, quando a sobra
// passa de COBERTURA_MAX_S, mede-se a ENERGIA da sobra (RMS) contra a da fala alinhada do mesmo trecho: só é aceita
// como cauda se ficar ≥ CAUDA_DB abaixo e não passar de CAUDA_MAX_S. Os números vão para o log.
export const CAUDA_DB = 10, CAUDA_MAX_S = 1.2;
export function energiaDb(amostras, sr, ini, fim) {
  const a = Math.max(0, Math.round(ini * sr)), b = Math.min(amostras.length, Math.round(fim * sr));
  if (!(b > a)) return -Infinity;
  let q = 0; for (let i = a; i < b; i++) q += amostras[i] * amostras[i];
  return 10 * Math.log10(q / (b - a) / (32768 * 32768) + 1e-12);
}

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

// Escolhe as N−1 fronteiras e prova que batem com o roteiro. Retorna {ok, cortes:[seg], esperados, motivo, pausas}.
// Ensaio real 43624128303: o TTS pausa em dois-pontos/vírgulas DENTRO das falas ("venda:", "máximo:", "Caixa:") às
// vezes mais do que entre falas; escolher "as N−1 pausas mais longas" trocou uma fronteira real por uma pausa interna
// e deslocou todas as seguintes (fronteira_incompativel:5:17.94~14.68). Agora a escolha é uma ATRIBUIÇÃO ORDENADA
// ótima (programação dinâmica): a fronteira k só pode usar uma pausa perto do ponto esperado, e o ponto esperado é
// recalculado a partir da fronteira anterior escolhida (ritmo local, sem deriva acumulada). Custo = desvio
// normalizado − bônus pela duração da pausa (fim de frase tende a ser a pausa mais longa da vizinhança).
export const BONUS_PAUSA = 0.3, PAUSA_REF_S = 0.6, TOL_FRAC = 0.3, TOL_MIN_S = 0.8;
export function escolherFronteiras({ silencios, duracao, falas }) {
  const n = falas.length;
  const internos = silencios.filter(s => s.ini > 0.05 && s.fim < duracao - 0.05 && s.fim - s.ini >= SILENCIO_MIN_S);
  const pausas = internos.map(s => `${s.ini.toFixed(2)}-${s.fim.toFixed(2)}`).join(',');
  if (internos.length < n - 1) return { ok: false, motivo: `pausas_insuficientes:${internos.length}<${n - 1}`, pausas };
  const ini0 = silencios.find(s => s.ini <= 0.05)?.fim ?? 0, fimU = silencios.find(s => s.fim >= duracao - 0.05)?.ini ?? duracao;
  const sil = falas.map(silabas), resto = sil.map((_, k) => sil.slice(k).reduce((a, b) => a + b, 0));
  const meio = internos.map(s => (s.ini + s.fim) / 2), m = internos.length;
  // esperado da fronteira k (fim da fala k) partindo de "de": a fala k ocupa a sua fração de sílabas do que resta.
  const passo = (de, k) => { const d = (fimU - de) * sil[k] / resto[k]; return { esp: de + d, tol: Math.max(TOL_MIN_S, TOL_FRAC * d) }; };
  const custo = (j, e) => Math.abs(meio[j] - e.esp) / e.tol - BONUS_PAUSA * Math.min(1, (internos[j].fim - internos[j].ini) / PAUSA_REF_S);
  let dp = new Map([[-1, { c: 0, cad: [] }]]); const esperados = [];
  for (let k = 0; k < n - 1; k++) {
    const prox = new Map(); let melhorFalha = null;
    for (const [i, st] of dp) {
      const e = passo(i < 0 ? ini0 : meio[i], k); if (i < 0) esperados[k] = e.esp;
      for (let j = i + 1; j <= m - (n - 1 - k); j++) {
        const dev = Math.abs(meio[j] - e.esp);
        if (dev > e.tol) { if (!melhorFalha || dev < melhorFalha.dev) melhorFalha = { dev, j, esp: e.esp }; continue; }
        const c = st.c + custo(j, e);
        if (!prox.has(j) || c < prox.get(j).c) prox.set(j, { c, cad: [...st.cad, j] });
      }
    }
    if (!prox.size) {
      const f = melhorFalha, onde = f ? `${meio[f.j].toFixed(2)}~${f.esp.toFixed(2)}` : 'sem_pausa';
      return { ok: false, motivo: `fronteira_incompativel:${k + 1}:${onde}`, esperados, pausas };
    }
    dp = prox;
  }
  // A última fala (do último corte ao fim da voz) também precisa caber no ritmo: mesmo critério da transição.
  let melhor = null;
  for (const [i, st] of dp) {
    const de = i < 0 ? ini0 : meio[i], dEsp = (fimU - ini0) * sil[n - 1] / resto[0], dReal = fimU - de;
    if (Math.abs(dReal - dEsp) > Math.max(TOL_MIN_S, 0.5 * dEsp)) continue;
    if (!melhor || st.c < melhor.c) melhor = st;
  }
  if (!melhor) return { ok: false, motivo: `fronteira_incompativel:${n}:fala_final_fora_do_ritmo`, esperados, pausas };
  const escolhidas = melhor.cad.map(j => internos[j]), cortes = melhor.cad.map(j => meio[j]), limites = [0, ...cortes, duracao];
  for (let k = 0; k < n; k++) if (limites[k + 1] - limites[k] < TRECHO_MIN_S) return { ok: false, motivo: `trecho_curto:${k + 1}`, pausas };
  return { ok: true, cortes, esperados, escolhidas, pausas };
}

// Ensaio real 43637492214: nesta geração o TTS EMENDOU frases sem pausa (12 pausas medidas, só 3 depois de 15 s para 4
// fronteiras) — pausa não é garantia de fronteira. Segunda via: o alinhamento do áudio INTEIRO (mesmo que tenha palavras
// instantâneas no meio das frases) localiza onde cada fala termina e a seguinte começa; o corte cai na pausa medida
// dentro dessa janela ou, sem pausa, no ponto de MENOR energia da janela. Nenhum tempo de palavra vem daqui: cada trecho
// é realinhado só com o texto da sua fala e passa pelas mesmas validações (cobertura, contagem, ordem).
export const JANELA_S = 0.3, PASSO_ENERGIA_S = 0.02;
export function fronteirasPorAlinhamento({ palavras, falas, silencios, duracao, energia }) {
  const tam = falas.map(f => f.split(/\s+/).filter(Boolean).length), total = tam.reduce((a, b) => a + b, 0);
  if (!Array.isArray(palavras) || palavras.length !== total) return { ok: false, motivo: `inteiro_contagem:${palavras?.length ?? 0}/${total}` };
  if (palavras.some(w => !Number.isFinite(w?.start) || !Number.isFinite(w?.end))) return { ok: false, motivo: 'inteiro_tempo_invalido' };
  const cortes = []; let fimK = -1;
  for (let k = 0; k < falas.length - 1; k++) {
    fimK += tam[k]; const a = palavras[fimK].end, b = palavras[fimK + 1].start, ant = cortes.at(-1) ?? 0;
    const lo = Math.max(Math.min(a, b) - JANELA_S, ant + TRECHO_MIN_S), hi = Math.min(Math.max(a, b) + JANELA_S, duracao - TRECHO_MIN_S);
    if (!(hi > lo)) return { ok: false, motivo: `janela_vazia:${k + 1}` };
    const pausas = silencios.filter(p => p.fim - p.ini >= SILENCIO_MIN_S && (p.ini + p.fim) / 2 >= lo && (p.ini + p.fim) / 2 <= hi);
    let corte;
    if (pausas.length) { const p = pausas.sort((x, y) => (y.fim - y.ini) - (x.fim - x.ini))[0]; corte = (p.ini + p.fim) / 2; }
    else {
      if (!energia) return { ok: false, motivo: `sem_pausa_nem_energia:${k + 1}` };
      let melhor = Infinity;
      for (let t = lo; t + PASSO_ENERGIA_S <= hi + 1e-9; t += PASSO_ENERGIA_S) { const e = energia(t, t + PASSO_ENERGIA_S); if (e < melhor) { melhor = e; corte = t + PASSO_ENERGIA_S / 2; } }
    }
    if (!(corte > ant)) return { ok: false, motivo: `corte_fora_de_ordem:${k + 1}` };
    cortes.push(corte);
  }
  if (duracao - cortes.at(-1) < TRECHO_MIN_S) return { ok: false, motivo: `trecho_curto:${falas.length}` };
  return { ok: true, cortes };
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
export function validarTrecho({ palavras, trecho, voz, final = false, energia = null, info = [] }) {
  const m = [];
  if (!palavras.length) return ['trecho_sem_palavras'];
  if (palavras.some(w => w.start < trecho.inicio - 1e-6 || w.end > trecho.fim + 1e-6)) m.push('palavra_fora_do_trecho');
  const fala = energia ? energia(palavras[0].start, palavras.at(-1).end) : null;
  // sobra além do limite: só passa se for cauda (energia ≥ CAUDA_DB abaixo da fala alinhada) e curta
  const cauda = (ini, fim) => {
    if (!energia || fim - ini > CAUDA_MAX_S) return false;
    const e = energia(ini, fim), ok = Number.isFinite(fala) && e <= fala - CAUDA_DB;
    info.push(`sobra=${(fim - ini).toFixed(2)}s ${Number.isFinite(e) ? e.toFixed(1) : '-inf'}dB fala=${Number.isFinite(fala) ? fala.toFixed(1) : '-inf'}dB ${ok ? 'cauda' : 'voz'}`);
    return ok;
  };
  const gIni = palavras[0].start - voz.on, gFim = voz.off - palavras.at(-1).end;
  if (gIni > COBERTURA_MAX_S && !cauda(voz.on, palavras[0].start)) m.push(`inicio_da_fala_sem_palavra:${gIni.toFixed(2)}`);
  if (gFim > COBERTURA_MAX_S && !cauda(palavras.at(-1).end, voz.off)) m.push(`${final ? 'voz_final_ausente' : 'fim_da_fala_sem_palavra'}:${gFim.toFixed(2)}`);
  if (final && palavras.some(w => !(w.end > w.start))) m.push('fala_final_com_palavra_instantanea');
  return m;
}

// Orquestra: pausas -> fronteiras -> partição -> alinhamento por trecho -> eixo único -> validações.
// deps: {silenciosDe(wav,dur), pcmDe(wav)->{amostras:Int16Array|Buffer, sr}, gravarTrecho(pcm, a, b, sr, arquivo),
//        alinharTrecho(arquivo, texto) -> alignment JSON}
export async function alinharPorFrases({ wav, falas, duracao, base, deps, note = () => {}, inteiro = null }) {
  const silencios = deps.silenciosDe(wav, duracao), { amostras, sr } = deps.pcmDe(wav);
  const energia = (a, b) => energiaDb(amostras, sr, a, b);
  let cortes, alInteiro = null, via = 'pausas';
  const f = escolherFronteiras({ silencios, duracao, falas });
  if (f.ok) cortes = f.cortes;
  else {
    note(`ALIGN_FRASES pausas_insuficientes ${f.motivo} pausas=${f.pausas || ''}`);
    if (!inteiro) { note('ALIGN_FRASES fallback ' + f.motivo); return { ok: false, motivo: f.motivo }; }
    alInteiro = await inteiro(); via = 'alinhamento_inteiro';
    const g = fronteirasPorAlinhamento({ palavras: alInteiro?.segments?.flatMap(x => x.words || []), falas, silencios, duracao, energia });
    if (!g.ok) { note('ALIGN_FRASES fallback ' + g.motivo); return { ok: false, motivo: g.motivo, inteiro: alInteiro }; }
    cortes = g.cortes;
  }
  const falha = motivo => { note('ALIGN_FRASES fallback ' + motivo); return { ok: false, motivo, inteiro: alInteiro }; };
  const trechos = particionar(amostras.length, sr, cortes);
  const palavras = [];
  for (let k = 0; k < falas.length; k++) {
    const t = trechos[k], arq = `${base}-frase-${k + 1}.wav`; deps.gravarTrecho(amostras, t.a, t.b, sr, arq);
    let local;
    try {
      const al = await deps.alinharTrecho(arq, falas[k]), n = falas[k].split(/\s+/).filter(Boolean).length;
      local = alignedWords(al, falas[k], t.fim - t.inicio, { toleraDuracaoZero: k === falas.length - 1 ? 0 : Math.floor(n * 0.1) });
    } catch (e) { return falha(`frase_${k + 1}:${String(e.message || e).slice(0, 80)}`); }
    const globais = local.map(w => ({ ...w, start: w.start + t.inicio, end: w.end + t.inicio }));
    const info = [], m = validarTrecho({ palavras: globais, trecho: t, voz: vozNoTrecho(silencios, t), final: k === falas.length - 1, energia, info });
    if (info.length) note(`ALIGN_FRASES frase_${k + 1} ${info.join(' | ')}`);
    if (m.length) return falha(`frase_${k + 1}:${m.join('+')}`);
    palavras.push(...globais);
  }
  const esperado = falas.join(' ').split(/\s+/).filter(Boolean).length;
  if (palavras.length !== esperado) return falha('contagem');
  for (let i = 1; i < palavras.length; i++) if (palavras[i].start < palavras[i - 1].end - 0.02) return falha('ordem');
  note(`ALIGN_FRASES ok via=${via} trechos=${falas.length} cortes=${cortes.map(c => c.toFixed(2)).join(',')} pausas=${f.pausas}`);
  return { ok: true, alignment: { segments: [{ words: palavras.map(w => ({ word: w.word, start: w.start, end: w.end })) }] }, cortes, via, inteiro: alInteiro };
}
