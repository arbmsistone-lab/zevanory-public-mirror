// align.py: tenta configurações REAIS do alinhador e fica com a primeira válida; nenhum tempo é inventado.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const SCRIPT = fileURLToPath(new URL("../scripts/shorts-v2/align.py", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-stable-whisper", import.meta.url));
function wav(dir, seconds) {
  const p = join(dir, "voz.wav"), rate = 8000, n = Math.round(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  writeFileSync(p, b); return p;
}
function run(scenario, seconds = 2) {
  const d = mkdtempSync(join(tmpdir(), "align-")), audio = wav(d, seconds), script = join(d, "r.txt"), out = join(d, "a.json");
  writeFileSync(script, "Kit completo agora");
  let stdout = "", failed = null;
  try { stdout = execFileSync("python3", [SCRIPT, audio, script, out], { env: { ...process.env, PYTHONPATH: FAKE, FAKE_ALIGN_SCENARIO: JSON.stringify(scenario) }, encoding: "utf8" }); } catch (e) { failed = String(e.stderr || e.message); }
  let json = null; try { json = JSON.parse(readFileSync(out, "utf8")); } catch {}
  return { stdout, json, failed };
}
const ok = [["Kit", 0, 0.4], ["completo", 0.4, 0.9], ["agora", 0.9, 1.3]];
const instant = [["Kit", 0.5, 0.5], ["completo", 0.5, 0.9], ["agora", 0.9, 1.3]];

test("primeira configuração válida é usada (caso normal)", () => {
  const r = run({ default: ok });
  assert.match(r.stdout, /ALIGN_ATTEMPT padrao_min_word_dur ok/); assert.equal(r.json.fake_options.min_word_dur, 0.1);
});
test("palavra instantânea na 1ª tentativa: usa a próxima configuração real que for válida", () => {
  const r = run({ default: instant, fast: ok });
  assert.match(r.stdout, /padrao_min_word_dur invalid[\s\S]*fast_mode ok/); assert.equal(r.json.fake_options.fast_mode, true);
  assert.deepEqual(r.json.segments[0].words.map((w) => [w.start, w.end]), ok.map(([, s, e]) => [s, e]), "tempos vêm do alinhador, sem ajuste nosso");
});
test("nenhuma válida: grava a última e NÃO corrige (o verificador reprova com o motivo)", () => {
  const r = run({ default: instant, fast: instant, nosup: instant });
  assert.match(r.stdout, /sem_supressao_de_silencio invalid/); assert.equal(r.json.segments[0].words[0].end, 0.5); assert.equal(r.json.segments[0].words[0].start, 0.5);
});
test("palavra além do fim do áudio ou sobreposta também é inválida", () => {
  assert.match(run({ default: [["Kit", 0, 0.4], ["completo", 0.4, 0.9], ["agora", 0.9, 2.5]], fast: ok }, 2).stdout, /padrao_min_word_dur invalid[\s\S]*fast_mode ok/);
  assert.match(run({ default: [["Kit", 0, 0.5], ["completo", 0.3, 0.9], ["agora", 0.9, 1.3]], nosup: ok }).stdout, /sem_supressao_de_silencio ok/);
});
test("alinhador sem resultado em todas: falha explícita", () => {
  const r = run({});
  assert.match(r.failed || "", /alignment_failed/);
});
