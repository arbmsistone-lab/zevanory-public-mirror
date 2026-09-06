import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicEvent } from '../src/publicEvent.mjs';

const valid = {
  event_id: '550e8400-e29b-41d4-a716-446655440001',
  session_id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'page_view',
  channel: 'landing'
};

test('accepts only canonical public events', () => {
  const e = normalizePublicEvent(valid);
  assert.equal(e.event_name, 'page_view');
  assert.equal(e.offer_id, 'ZEV-NGC-011');
  assert.equal(e.experiment_id, 'EXP-0001');
});

test('rejects forged financial event', () => {
  assert.equal(normalizePublicEvent({...valid, name:'payment_confirmed'}), null);
});

test('rejects invalid ids and empty channel', () => {
  assert.equal(normalizePublicEvent({...valid, event_id:'x'}), null);
  assert.equal(normalizePublicEvent({...valid, channel:''}), null);
});
