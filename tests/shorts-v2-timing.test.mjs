// Tempo do Short a partir da fala real: o cartão de CTA (duration-3.5) coincide com o CTA falado.
import test from "node:test";
import assert from "node:assert/strict";
import { CTA, shortTiming, quality } from "../scripts/shorts-v2/core.mjs";
const n = CTA.split(/\s+/).length;
const words = (firstCta, voice, total = 73) => Array.from({ length: total }, (_, i) => {
  const ctaIdx = total - n;
  if (i < ctaIdx) { const t = (firstCta - 0.05) * i / ctaIdx; return { word: "w", start: t, end: t + 0.2 }; }
  const step = (voice - firstCta) / n, s = firstCta + (i - ctaIdx) * step; return { word: "c", start: s, end: s + step * 0.9 };
});
test("prévia real 13/11 (CTA 25,04 s; voz 26,96 s): antes falhava por 0,08 s, agora o cartão coincide com o CTA falado", () => {
  const voice = 26.96, firstCta = 25.04;
  assert.ok(!(firstCta >= voice + 1 - 4 && firstCta <= voice + 1 - 3), "regra antiga (cauda fixa 1,0 s) reprovava este caso");
  const t = shortTiming(voice, words(firstCta, voice));
  assert.equal(t.firstCta, firstCta); assert.equal(t.ctaStart, firstCta);
  assert.ok(Math.abs(t.duration - 28.54) < 1e-9); assert.ok(Math.abs(t.tail - 1.58) < 1e-9);
  assert.ok(t.duration - t.firstCta >= 3 && t.duration - t.firstCta <= 4, "ctaSeconds dentro do critério de quality()");
});
test("cauda fora de 0,5–2,0 s falha com os tempos (sem palavras)", () => {
  assert.throws(() => shortTiming(27, words(23.0, 27)), /^Error: cta_alignment_failed cta=23\.00 voz=27\.00 cauda=-0\.50$/);
  assert.throws(() => shortTiming(27, words(25.9, 27)), /^Error: cta_alignment_failed cta=25\.90 voz=27\.00 cauda=2\.40$/);
  assert.equal(shortTiming(27, words(24.0, 27)).tail, 0.5);
  assert.equal(shortTiming(27, words(25.5, 27)).tail, 2.0);
});
test("duração final fora de 25–35 s falha", () => {
  assert.throws(() => shortTiming(21, words(18.5, 21)), /v2_duration_failed/);
  assert.throws(() => shortTiming(33.5, words(31.6, 33.5)), /v2_duration_failed/);
});
test("sem CTA alinhado ou tempos inválidos: falha explícita", () => {
  assert.throws(() => shortTiming(27, []), /cta_alignment_failed sem_cta/);
  assert.throws(() => shortTiming(NaN, words(25, 27)), /cta_alignment_failed sem_cta/);
  const w = words(25, 27); w[w.length - n].start = 27.5;
  assert.throws(() => shortTiming(27, w), /cta_alignment_failed sem_cta/);
});
test("quality() continua exigindo ctaSeconds entre 3 e 4 s", () => {
  const src = quality.toString();
  assert.match(src, /ctaSeconds>=3&&q\.ctaSeconds<=4/);
});
