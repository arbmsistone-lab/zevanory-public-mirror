import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/piloto.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../public/piloto.js', import.meta.url), 'utf8');

test('pilot keeps CTA fail-closed by default', () => {
  assert.match(html, /<button id="cta" disabled>/);
  assert.match(js, /CTA bloqueado por valida/);
});

test('pilot redirects only after accepted telemetry', () => {
  const eventCall = js.indexOf("await event('cta_whatsapp')");
  const redirect = js.indexOf("location.href = 'https://wa.me/'");
  assert.ok(eventCall > 0);
  assert.ok(redirect > eventCall);
});

test('pilot receives offer and price from runtime config', () => {
  assert.match(js, /config\.offer_id/);
  assert.match(js, /config\.experimental_price_brl/);
  assert.doesNotMatch(html + js, /558892340423/);
});

test('pilot has no inline script or style under strict CSP', () => {
  assert.doesNotMatch(html, /<style[>\s]/i);
  assert.doesNotMatch(html, /<script>([\s\S]*?)<\/script>/i);
  assert.match(html, /href="\/piloto\.css"/);
  assert.match(html, /src="\/piloto\.js"/);
});
