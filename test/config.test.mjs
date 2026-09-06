import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT, normalizeWhatsappNumber, isOfficialWhatsapp, isUuid } from '../src/config.mjs';

test('project definitions have one canonical identity', () => {
  assert.equal(PROJECT.name, 'ZEVANORY');
  assert.equal(PROJECT.offerId, 'ZEV-NGC-011');
  assert.equal(PROJECT.experimentId, 'EXP-0001');
  assert.equal(PROJECT.experimentalPriceBrl, 347);
  assert.equal(PROJECT.officialWhatsappE164, '558892340423');
  assert.equal(Object.isFrozen(PROJECT), true);
});

test('official WhatsApp normalizes valid Brazilian E.164', () => {
  assert.equal(normalizeWhatsappNumber('+55 88 9234-0423'), '558892340423');
  assert.equal(normalizeWhatsappNumber('558892340423'), '558892340423');
  assert.equal(normalizeWhatsappNumber('invalid'), '');
});

test('only the confirmed official WhatsApp is accepted', () => {
  assert.equal(isOfficialWhatsapp('+55 88 9234-0423'), true);
  assert.equal(isOfficialWhatsapp('558892340423'), true);
  assert.equal(isOfficialWhatsapp('5588999999999'), false);
});

test('session UUID validation accepts real UUID and rejects arbitrary text', () => {
  assert.equal(isUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isUuid('not-a-session'), false);
});
