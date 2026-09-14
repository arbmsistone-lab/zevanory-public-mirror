import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hydrateRuntimeConfig } from '../src/runtimeConfigHydration.mjs';
import { commercialDistributionReadiness } from '../src/commercialDistribution.mjs';

test('current Cloudflare bindings overwrite stale isolate runtime values',()=>{
  const target={AFFILIATE_TRACKING_READY:'false'};
  hydrateRuntimeConfig({AFFILIATE_TRACKING_READY:'true'},target);
  assert.equal(target.AFFILIATE_TRACKING_READY,'true');
});

test('runtime config remains fallback behind direct current bindings',()=>{
  const target={};
  hydrateRuntimeConfig({AFFILIATE_PROVIDER:'zevanory-first-party',ZEVANORY_RUNTIME_CONFIG:JSON.stringify({AFFILIATE_PROVIDER:'stale-provider',EXTRA_FLAG:'true'})},target);
  assert.equal(target.AFFILIATE_PROVIDER,'zevanory-first-party');assert.equal(target.EXTRA_FLAG,'true');
});

test('canonical Cloudflare vars produce affiliate automation readiness after hydration',async()=>{
  const cfg=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8')),target={};
  hydrateRuntimeConfig(cfg.vars||{},target);const out=commercialDistributionReadiness(target);
  assert.equal(out.fronts.affiliate.operational_ready,true);assert.equal(out.fronts.affiliate.automation_ready,true);assert.deepEqual(out.fronts.affiliate.blockers,[]);
});


test('removed critical binding fails closed instead of inheriting stale truth',()=>{
  const target={CERTIFICATION_PILOT_ENABLED:'true',CHECKOUT_ENABLED:'true',FINANCIAL_EVENTS_ENABLED:'true'};
  hydrateRuntimeConfig({},target);
  assert.equal(target.CERTIFICATION_PILOT_ENABLED,'false');
  assert.equal(target.CHECKOUT_ENABLED,'false');
  assert.equal(target.FINANCIAL_EVENTS_ENABLED,'false');
});
