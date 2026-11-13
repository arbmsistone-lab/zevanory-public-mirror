// Loudnorm em duas passagens e mensagem de QC com números (prévia real 13/11: audio_qc_failed:mix_loudness).
import test from "node:test";
import assert from "node:assert/strict";
import { loudnormMeasured, loudnormSecondPass, normalizeTwoPass, qcFailureMessage } from "../scripts/shorts-v2/render.mjs";
const measure = '[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-17.32",\n\t"input_tp" : "-3.10",\n\t"input_lra" : "5.40",\n\t"input_thresh" : "-27.70",\n\t"output_i" : "-14.9",\n\t"target_offset" : "0.41"\n}\n';
test("1ª passagem: lê as medidas do bloco JSON do loudnorm (último bloco)", () => {
  assert.deepEqual(loudnormMeasured("lixo\n" + measure.replace("-17.32", "-30") + measure), { input_i: -17.32, input_tp: -3.1, input_lra: 5.4, input_thresh: -27.7, target_offset: 0.41 });
});
test("medida ausente ou inválida: falha explícita (nunca normaliza às cegas)", () => {
  assert.throws(() => loudnormMeasured("sem json"), /loudnorm_measure_missing/);
  assert.throws(() => loudnormMeasured(measure.replace('"-3.10"', '"-inf"')), /loudnorm_measure_invalid:input_tp/);
});
test("2ª passagem: modo linear com as medidas e o MESMO alvo (-14 LUFS, TP -1.5, LRA 7)", () => {
  const f = loudnormSecondPass(loudnormMeasured(measure));
  assert.equal(f, "loudnorm=I=-14:TP=-1.5:LRA=7:measured_I=-17.32:measured_TP=-3.1:measured_LRA=5.4:measured_thresh=-27.7:offset=0.41:linear=true:print_format=summary");
});
test("normalizeTwoPass: mede o arquivo e aplica a 2ª passagem nele, nessa ordem", () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args.join(" ")); return calls.length === 1 ? measure : ""; };
  normalizeTwoPass("in.wav", "out.wav", { run });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /-i in\.wav -af loudnorm=I=-14:TP=-1\.5:LRA=7:print_format=json -f null -$/);
  assert.match(calls[1], /-i in\.wav -af loudnorm=.*measured_I=-17\.32.*linear=true.* out\.wav$/);
});
test("mensagem de QC mantém o prefixo e traz os números medidos", () => {
  const m = qcFailureMessage({ reasons: ["mix_loudness", "true_peak"], metrics: { mixLufs: -15.31, truePeak: -0.8 } });
  assert.equal(m, "audio_qc_failed:mix_loudness+true_peak (mixLufs=-15.31 truePeak=-0.80; truePeak=-0.80)");
  assert.match(m, /^audio_qc_failed/);
});

// NC-1039-01: tipo validado ANTES da coerção; inválido interrompe antes da 2ª passagem.
test("medidas com tipo inválido (null, '', [], true, ['-17.32'], {}, 'abc', 'inf') falham antes da 2ª passagem", () => {
  const block = (v) => '{"input_i" : ' + JSON.stringify(v) + ', "input_tp" : "-3.10", "input_lra" : "5.40", "input_thresh" : "-27.70", "target_offset" : "0.41"}';
  for (const bad of [null, "", "  ", [], true, false, ["-17.32"], {}, "abc", "inf", "-inf", "nan", "1e999"]) {
    let calls = 0;
    const run = () => { calls++; return block(bad); };
    assert.throws(() => normalizeTwoPass("in.wav", "out.wav", { run }), /loudnorm_measure_invalid:input_i|loudnorm_measure_missing/, JSON.stringify(bad));
    assert.equal(calls, 1, "2ª passagem não executada para " + JSON.stringify(bad));
  }
});
test("número JSON finito e string numérica são aceitos", () => {
  const ok = (v) => loudnormMeasured('{"input_i" : ' + JSON.stringify(v) + ', "input_tp" : -3.1, "input_lra" : "5.4", "input_thresh" : "-27.7", "target_offset" : "+0.41"}');
  assert.equal(ok(-17.32).input_i, -17.32); assert.equal(ok("-17.32").input_i, -17.32); assert.equal(ok(" -17 ").input_i, -17); assert.equal(ok("-17.32").target_offset, 0.41);
});
