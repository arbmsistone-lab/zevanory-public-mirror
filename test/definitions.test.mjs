import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROJECT } from '../src/config.mjs';

const root = new URL('../', import.meta.url);
const offer = await readFile(new URL('launch/ZEVANORY-PRODUCTS-V11-HANDOFF.md', root), 'utf8');
const pricing = offer;
const experiment = await readFile(new URL('experiments/EXP-0001-oferta-piloto.md', root), 'utf8');
const landing = await readFile(new URL('public/index.html', root), 'utf8');

test('offer and experiment IDs match canonical runtime definitions', () => {
  assert.match(offer, /ZEV-NGC-011/);
  assert.match(experiment, new RegExp(PROJECT.experimentId));
  assert.match(experiment, new RegExp(PROJECT.offerId));
});

test('commercial model matches canonical runtime and old pilot price is retired', () => {
  assert.match(pricing, /piloto R\$ 347/);
  assert.equal(PROJECT.experimentalPriceBrl, 1197);
  assert.doesNotMatch(landing, /R\$\s*497/);
});

test('commercial definitions preserve no-unproven-results guardrail', () => {
  assert.match(offer, /Pre.os piloto continuam hip.tese comercial/u);
  assert.match(experiment, /Clique nao conta como lead/);
  assert.match(experiment, /payment_confirmed so pode vir de provedor autenticado/);
});
