import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPilotRuntimeConfig, verifyPilotState } from '../scripts/deploy-cloudflare-certification-pilot.mjs';

const base=await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8');
const meta={sha:'a'.repeat(40),ref:'main'};

test('pilot config is read-only and preserves all commercial mutation switches closed',()=>{
  const cfg=JSON.parse(buildPilotRuntimeConfig(base,meta));
  assert.equal(cfg.vars.CERTIFICATION_PILOT_ENABLED,'true');
  assert.equal(cfg.vars.AFFILIATE_TERMS_VERSION,undefined);
  assert.equal(cfg.vars.CHECKOUT_ENABLED,'false');
  assert.equal(cfg.vars.FINANCIAL_EVENTS_ENABLED,'false');
  assert.equal(cfg.vars.SALE_GLOBALLY_ENABLED,'false');
  assert.equal(cfg.vars.PRE_SALE_GATES_APPROVED,'false');
  assert.equal(cfg.vars.WHATSAPP_SALES_ENABLED,'false');
  assert.equal(cfg.vars.ZEVANORY_RELEASE_SHA,meta.sha);
});
test('pilot verification requires exact provenance healthy runtime authenticated provider and blocked sales',()=>{
  assert.equal(verifyPilotState({
    release:{deployment:{commit_sha:meta.sha,branch:'main'},sales_mode:'globally-blocked',checkout_mode:'globally-blocked',financial_mode:'disabled'},
    health:{ready:true}, provider:{authenticated:true,pre_sale_ready:true},
  },meta),true);
  assert.throws(()=>verifyPilotState({
    release:{deployment:{commit_sha:'b'.repeat(40),branch:'main'},sales_mode:'globally-blocked',checkout_mode:'globally-blocked',financial_mode:'disabled'},
    health:{ready:true},provider:{authenticated:true,pre_sale_ready:true},
  },meta),/pilot_release_provenance_mismatch/);
});

test('canonical wrangler remains fully fail closed',()=>{
  const cfg=JSON.parse(base);
  assert.equal(cfg.vars.CERTIFICATION_PILOT_ENABLED,undefined);
  assert.equal(cfg.vars.AFFILIATE_TERMS_VERSION,'2026-09');
  assert.equal(cfg.vars.CHECKOUT_ENABLED,'false');
  assert.equal(cfg.vars.FINANCIAL_EVENTS_ENABLED,'false');
  assert.equal(cfg.vars.SALE_GLOBALLY_ENABLED,'false');
});


test('pilot refuses checkout or financial enablement',()=>{
  const baseState={deployment:{commit_sha:meta.sha,branch:'main'},sales_mode:'globally-blocked',checkout_mode:'globally-blocked',financial_mode:'disabled'};
  assert.throws(()=>verifyPilotState({release:{...baseState,checkout_mode:'enabled'},health:{ready:true},provider:{authenticated:true,pre_sale_ready:true},closure:{commercial_enabled:false,certification_pilot:{enabled:true}}},meta),/checkout_must_remain_blocked/);
  assert.throws(()=>verifyPilotState({release:{...baseState,financial_mode:'enabled'},health:{ready:true},provider:{authenticated:true,pre_sale_ready:true},closure:{commercial_enabled:false,certification_pilot:{enabled:true}}},meta),/financial_events_must_remain_disabled/);
});
