import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPilotRuntimeConfig, verifyPilotState } from '../scripts/deploy-cloudflare-certification-pilot.mjs';

const base=await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8');
const meta={sha:'a'.repeat(40),ref:'main'};

test('pilot config enables only bounded pilot switches and preserves global sales closed',()=>{
  const cfg=JSON.parse(buildPilotRuntimeConfig(base,meta));
  assert.equal(cfg.vars.CERTIFICATION_PILOT_ENABLED,'true');
  assert.equal(cfg.vars.CHECKOUT_ENABLED,'true');
  assert.equal(cfg.vars.FINANCIAL_EVENTS_ENABLED,'true');
  assert.equal(cfg.vars.SALE_GLOBALLY_ENABLED,'false');
  assert.equal(cfg.vars.PRE_SALE_GATES_APPROVED,'false');
  assert.equal(cfg.vars.WHATSAPP_SALES_ENABLED,'false');
  assert.equal(cfg.vars.ZEVANORY_RELEASE_SHA,meta.sha);
});
test('pilot verification requires exact provenance healthy runtime authenticated provider and blocked sales',()=>{
  assert.equal(verifyPilotState({
    release:{deployment:{commit_sha:meta.sha,branch:'main'},sales_mode:'globally-blocked'},
    health:{ready:true}, provider:{authenticated:true,pre_sale_ready:true},
  },meta),true);
  assert.throws(()=>verifyPilotState({
    release:{deployment:{commit_sha:'b'.repeat(40),branch:'main'},sales_mode:'globally-blocked'},
    health:{ready:true},provider:{authenticated:true,pre_sale_ready:true},
  },meta),/pilot_release_provenance_mismatch/);
});

test('canonical wrangler remains fully fail closed',()=>{
  const cfg=JSON.parse(base);
  assert.equal(cfg.vars.CERTIFICATION_PILOT_ENABLED,'false');
  assert.equal(cfg.vars.CHECKOUT_ENABLED,'false');
  assert.equal(cfg.vars.FINANCIAL_EVENTS_ENABLED,'false');
  assert.equal(cfg.vars.SALE_GLOBALLY_ENABLED,'false');
});
