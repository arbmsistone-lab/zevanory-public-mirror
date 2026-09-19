import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('pilot interest endpoint is fail-closed, origin/content-type validated and rate limited',()=>{
  const src=fs.readFileSync('api/pilot-interest.mjs','utf8');
  assert.match(src,/validatePublicApiRequest/);
  assert.match(src,/consumeAdaptiveWebhookRate/);
  assert.match(src,/rate_limited/);
  assert.match(src,/commercial_unlock:false/);
  assert.match(src,/consent_required/);
  assert.match(src,/privacy_accepted/);
  assert.match(src,/company_website/);
  assert.match(src,/normalize\('NFKC'\)/);
  assert.doesNotMatch(src,/SALE_GLOBALLY_ENABLED\s*=\s*['"]true/);
});

test('pilot interest storage is waitlist-only with explicit consent fields and case-insensitive identity',()=>{
  const migration=fs.readFileSync('db/migrations/029_certification_pilot_interest.sql','utf8');
  assert.match(migration,/status IN \('waitlisted','invited','declined','completed'\)/);
  assert.match(migration,/consent_version/);
  assert.match(migration,/consent_at/);
  assert.match(migration,/lower\(email\)/);
});

test('opt-in page is explicit, accessible and has no checkout path',()=>{
  const html=fs.readFileSync('public/piloto-interesse.html','utf8');
  assert.match(html,/Não abre vendas/);
  assert.match(html,/id="consent"/);
  assert.match(html,/id="privacy"/);
  assert.match(html,/aria-live="polite"/);
  assert.match(html,/convite individual/);
  assert.doesNotMatch(html,/checkout_url/);
});