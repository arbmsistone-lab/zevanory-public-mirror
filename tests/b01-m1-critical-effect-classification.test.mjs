// B01 M1 — teste de regressão proposto pelo Sol (Ordem 014), ampliado por Claude com o apex-engineering.
// Lê o YAML de verdade (job a job), não a primeira linha "environment:" do arquivo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL('../.github/workflows/' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function jobEnvironment(yaml, job) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:` || l.startsWith(`  ${job}: `) || l.startsWith(`  ${job}:  #`));
  assert.ok(start >= 0, `job ${job} não encontrado`);
  for (let i = start + 1; i < lines.length && !/^  \S/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s{4}environment:\s*([\w-]+)/);
    if (m) return m[1];
  }
  return null;
}

for (const [name, job] of [
  ['sandbox-mail-routing.yml', 'routing'],
  ['voice-workers-ai-binding-probe.yml', 'cleanup'],
  ['security-headers-candidate-preview.yml', 'preview-security'],
  ['zevanory-apex-engineering.yml', 'apex'],
  ['zevanory-open-sales.yml', 'owner-open'],
  ['central-production-deploy.yml', 'deploy'],
  ['sandbox-worker-secret-audit.yml', 'audit'],
]) {
  test(`${name}/${job} exige aprovação de produção`, () => {
    assert.equal(jobEnvironment(read(name), job), 'producao-critica');
  });
}

for (const [name, job] of [
  ['zevanory-close-sales.yml', 'emergency-close'],
  ['zees16-control-reconciler.yml', 'reconcile'],
  ['order12a-financial-proof-renewal.yml', 'signed-renewal'],
]) {
  test(`${name}/${job} não espera aprovação humana (emergência e rotina)`, () => {
    assert.equal(jobEnvironment(read(name), job), 'gh-pages-automacao');
  });
}
