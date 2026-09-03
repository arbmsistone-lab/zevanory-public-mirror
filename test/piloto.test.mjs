import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/piloto.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../public/piloto.js', import.meta.url), 'utf8');

test('certification pilot keeps CTA fail-closed without invite', () => {
  assert.match(html, /<button id="cta" disabled>/);
  assert.match(js, /if \(!pilotToken\)/);
  assert.match(js, /Nenhuma venda publica esta liberada/);
});

test('pilot token stays in URL fragment and is removed before network use', () => {
  assert.match(js, /location\.hash\.match/);
  assert.match(js, /history\.replaceState/);
  assert.doesNotMatch(js, /searchParams\.get\(['"]pilot/);
});

test('pilot checkout requires token header and redirects only after provider acceptance', () => {
  const request = js.indexOf("'x-certification-pilot-token':pilotToken");
  const accepted = js.indexOf('if (!response.ok || !data.checkout_url)');
  const redirect = js.indexOf('location.href = data.checkout_url');
  assert.ok(request > 0); assert.ok(accepted > request); assert.ok(redirect > accepted);
});
test('pilot receives offer and price from runtime config without hardcoded participant data', () => {
  assert.match(js, /config\.offer\?\.name \|\| config\.offer_id/);
  assert.match(js, /config\.experimental_price_brl/);
  assert.doesNotMatch(html + js, /558892340423/);
  assert.doesNotMatch(html + js, /@zevanory_/);
});

test('pilot has no inline script or style under strict CSP', () => {
  assert.doesNotMatch(html, /<style[>\s]/i);
  assert.doesNotMatch(html, /<script>([\s\S]*?)<\/script>/i);
  assert.match(html, /href="\/piloto\.css"/);
  assert.match(html, /src="\/piloto\.js"/);
});
