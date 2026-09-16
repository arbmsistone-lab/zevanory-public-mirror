import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paymentProviderReadiness } from '../src/paymentProviders.mjs';

const localEnv={
  PAYMENT_PROVIDER:'mercadopago',
  PAYMENT_RUNTIME_MODE:'local',
  MERCADOPAGO_ENV:'production',
  MERCADOPAGO_ACCESS_TOKEN:'present',
  MERCADOPAGO_WEBHOOK_SECRET:'present',
};

test('edge payment readiness is local and does not delegate to Vercel',()=>{
  const state=paymentProviderReadiness(localEnv);
  assert.equal(state.ready,true);
  assert.equal(state.provider,'mercadopago');
  assert.equal(state.delegated,false);
});

test('cloudflare payment runtime uses its own public base',()=>{
  const cfg=readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');
  assert.match(cfg,/"PAYMENT_RUNTIME_MODE": "local"/);
  assert.match(cfg,/"PAYMENT_PUBLIC_BASE_URL": "https:\/\/edge\.zevanory\.api\.br"/);
});