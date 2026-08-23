import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const master = await readFile(new URL('ZEVANORY_MASTER.md', root), 'utf8');
const gate = await readFile(new URL('evidence/EG-0009-governanca-trajeto-zevanory.md', root), 'utf8');
const scope = await readFile(new URL('specs/SCOPE_BOUNDARY.md', root), 'utf8');
const agents = await readFile(new URL('AGENTS.md', root), 'utf8');

test('master fixes the approved commercial trajectory', () => {
  assert.match(master, /Mercado real -> Oferta -> Aquisicao/);
  assert.match(master, /Pagamento confirmado/);
  assert.match(master, /Margem de contribuicao -> Experimento -> Aprendizado/);
});

test('master declares done current and next states', () => {
  assert.match(master, /## JA APROVADO/);
  assert.match(master, /## ESTADO ATUAL/);
  assert.match(master, /## PROXIMOS PASSOS AUTORIZADOS/);
});

test('governance scope and agent entrypoint fail closed', () => {
  assert.match(gate, /Veredito: APROVADO/);
  assert.match(scope, /C:\\Sistemas\\ZEVANORY/);
  assert.match(agents, /Leia ZEVANORY_MASTER\.md inteiro/);
  assert.match(agents, /Nao pule gates/);
  assert.match(agents, /Qualquer divergencia bloqueia a acao/);
});

test('infrastructure assembly requires three independent audits', () => {
  assert.match(master, /Toda montagem ou alteracao de infraestrutura exige/);
  assert.match(master, /Auditoria 1 estrutural\/configuracao/);
  assert.match(master, /Auditoria 2 funcional\/seguranca\/integridade/);
  assert.match(master, /Auditoria 3 integracao\/regressao\/prova operacional/);
  assert.match(master, /qualquer falha, divergencia ou erro conhecido bloqueia a infraestrutura/);
  assert.match(agents, /Toda montagem ou alteracao de infraestrutura deve registrar 3 auditorias independentes/);
  assert.match(agents, /As 3 auditorias devem estar APROVADAS/);
});