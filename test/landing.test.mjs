import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('landing identifies ZEVANORY as the only public brand', () => {
  assert.match(html, /<title>ZEVANORY<\/title>/);
  assert.match(html, /class="brand">ZEVANORY</);
  assert.doesNotMatch(html, /GIRO LOCAL/i);
});

test('landing is structurally independent from the previous commercial pilot', () => {
  assert.match(html, /NOVO\.<br>SEM HERANÇA\./);
  assert.match(html, /estrutura independente/i);
  assert.doesNotMatch(html, /Preço experimental/i);
  assert.doesNotMatch(html, /Falar sobre o piloto no WhatsApp/i);
});

test('landing exposes the approved public domain identity', () => {
  assert.match(html, /zevanory\.api\.br/);
  assert.match(html, /Nenhum resultado comercial é simulado/);
  assert.doesNotMatch(html, /girolocal\.api\.br/i);
});