import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_EVENTS,
  OPERATOR_EVENTS,
  FINANCIAL_EVENTS,
  validateEventName,
  sanitizeText,
} from '../src/telemetry.mjs';

test('public surface exposes only non-financial events', () => {
  assert.deepEqual([...PUBLIC_EVENTS].sort(), ['cta_whatsapp', 'page_view']);
  assert.equal(PUBLIC_EVENTS.has('payment_confirmed'), false);
});

test('operator surface cannot forge financial events', () => {
  assert.equal(OPERATOR_EVENTS.has('lead_qualified'), true);
  assert.equal(OPERATOR_EVENTS.has('offer_sent'), true);
  assert.equal(OPERATOR_EVENTS.has('checkout_started'), true);
  assert.equal(OPERATOR_EVENTS.has('payment_confirmed'), false);
});

test('financial events are explicitly separated', () => {
  assert.equal(FINANCIAL_EVENTS.has('payment_confirmed'), true);
  assert.equal(FINANCIAL_EVENTS.has('refund_confirmed'), true);
});
test('unknown event is rejected by validation', () => {
  assert.equal(validateEventName('fake_sale'), false);
});

test('text sanitizer strips control characters and caps length', () => {
  assert.equal(sanitizeText('  abc\u0000def  ', 20), 'abc def');
  assert.equal(sanitizeText('abcdefgh', 4), 'abcd');
  assert.equal(sanitizeText(null), '');
});
