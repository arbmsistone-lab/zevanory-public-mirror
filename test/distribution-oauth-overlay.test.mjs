import test from 'node:test';
import assert from 'node:assert/strict';
import {commercialDistributionReadiness} from '../src/commercialDistribution.mjs';

test('persisted OAuth can promote a channel to automation readiness without opening sales',()=>{
  const base=commercialDistributionReadiness({},{});
  const withOauth=commercialDistributionReadiness({}, {youtube:{ready:true}});
  assert.equal(base.fronts.youtube.automation_ready,false);
  assert.equal(withOauth.fronts.youtube.automation_ready,true);
  assert.equal(withOauth.fronts.youtube.operational_mode,'provider_api');
});
