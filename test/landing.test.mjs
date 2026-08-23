import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('landing identifies ZEVANORY as the only public brand', () => {
  assert.match(html, /<title>ZEVANORY<\/title>/);
  assert.match(html, /class="brand">ZEVANORY/);
  assert.doesNotMatch(html, /GIRO LOCAL/i);
  assert.doesNotMatch(html, /girolocal\.api\.br/i);
});

test('landing exposes operational infrastructure instead of a static G0 card', () => {
  assert.match(html, /NOVO\.<br>SEM HERANÇA\./);
  assert.match(html, /infraestrutura em construção/i);
  assert.match(html, /fetch\('\/api\/status'/);
  assert.match(html, /Motor &amp; gate atual/);
  assert.doesNotMatch(html, /<strong>G0<\/strong>/);
  assert.doesNotMatch(html, /Preço experimental/i);
  assert.doesNotMatch(html, /Falar sobre o piloto no WhatsApp/i);
});

test('landing makes commercial truth and domain status explicit', () => {
  assert.match(html, /Infraestrutura aprovada não significa motor comercial aprovado/);
  assert.match(html, /Venda só existe após pagamento reconciliado/);
  assert.match(html, /zevanory\.api\.br · associação pendente/);
});

test('landing includes all approved aggregate operational metrics', () => {
  for (const key of ['page_views','leads_qualified','offers_sent','checkouts_started','orders','payments_confirmed','refunds_confirmed']) {
    assert.match(html, new RegExp(`data-kpi="${key}"`));
  }
});
