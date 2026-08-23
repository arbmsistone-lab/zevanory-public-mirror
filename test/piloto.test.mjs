import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/piloto.html', import.meta.url), 'utf8');

test('pilot keeps CTA fail-closed by default', () => {
  assert.match(html, /<button id="cta" disabled>/);
  assert.match(html, /CTA bloqueado por valida/);
});

test('pilot redirects only after accepted telemetry', () => {
  const eventCall = html.indexOf("await event('cta_whatsapp')");
  const redirect = html.indexOf("location.href = 'https://wa.me/'");
  assert.ok(eventCall > 0);
  assert.ok(redirect > eventCall);
});

test('pilot receives offer and price from runtime config', () => {
  assert.match(html, /config\.offer_id/);
  assert.match(html, /config\.experimental_price_brl/);
  assert.doesNotMatch(html, /5588992340423/);
});
