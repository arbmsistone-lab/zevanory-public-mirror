import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROJECT } from '../src/config.mjs';

const root = new URL('../', import.meta.url);
const offer = await readFile(new URL('specs/OFFER-0001-ia-vendas-whatsapp.md', root), 'utf8');
const pricing = await readFile(new URL('specs/PRICING-0001-preco-experimental.md', root), 'utf8');
const experiment = await readFile(new URL('experiments/EXP-0001-oferta-piloto.md', root), 'utf8');
const landing = await readFile(new URL('public/index.html', root), 'utf8');

test('offer and experiment IDs match canonical runtime definitions', () => {
  assert.match(offer, new RegExp(PROJECT.offerId));
  assert.match(experiment, new RegExp(PROJECT.experimentId));
  assert.match(experiment, new RegExp(PROJECT.offerId));
});

test('experimental price matches canonical runtime and remains explicitly hypothetical', () => {
  assert.match(pricing, new RegExp(`R\\$ ${PROJECT.experimentalPriceBrl}`));
  assert.match(pricing, /HIPOTESE PARA TESTE, NAO PRECO DEFINITIVO/);
  assert.doesNotMatch(landing, /R\$\s*497/);
});

test('commercial definitions preserve no-unproven-results guardrail', () => {
  assert.match(offer, /Nao prometer aumento de vendas, faturamento, lucro ou conversao/);
  assert.match(experiment, /Clique nao conta como lead/);
  assert.match(experiment, /payment_confirmed so pode vir de provedor autenticado/);
});
