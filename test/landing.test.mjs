import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('CTA starts fail-closed', () => {
  assert.match(html, /<button id="cta" disabled>/);
  assert.match(html, /CTA bloqueado por valida/);
});

test('WhatsApp redirect depends on accepted telemetry', () => {
  const eventCall = html.indexOf("await event('cta_whatsapp')");
  const redirect = html.indexOf("location.href = 'https://wa.me/'");
  assert.ok(eventCall > 0);
  assert.ok(redirect > eventCall);
  assert.match(html, /if \(!response\.ok\) throw new Error/);
});

test('landing receives commercial definitions from runtime config', () => {
  assert.match(html, /config\.offer_id/);
  assert.match(html, /config\.experimental_price_brl/);
  assert.doesNotMatch(html, /5588992340423/);
});
