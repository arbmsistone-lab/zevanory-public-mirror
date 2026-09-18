import test from 'node:test';
import assert from 'node:assert/strict';
import { assistedFallbackReadiness, buildAssistedPublicationTask } from '../src/assistedChannelFallbacks.mjs';
import { commercialDistributionReadiness } from '../src/commercialDistribution.mjs';

const fallbackEnv={
  TIKTOK_PROFILE_VERIFIED:'true',TIKTOK_OPERATOR_ASSISTED_PUBLISHING:'true',TIKTOK_PROFILE_URL:'https://www.tiktok.com/@zevanory3',
  LINKEDIN_FOUNDER_PROFILE_VERIFIED:'true',LINKEDIN_OPERATOR_ASSISTED_PUBLISHING:'true',LINKEDIN_FOUNDER_PROFILE_URL:'https://www.linkedin.com/in/example/',
  NUVEMSHOP_STOREFRONT_VERIFIED:'true',NUVEMSHOP_STOREFRONT_URL:'https://zevanory.lojavirtualnuvem.com.br/',
};

test('assisted fallbacks remain available only as standby backlog helpers',()=>{
  for(const c of ['tiktok','linkedin','nuvemshop'])assert.equal(assistedFallbackReadiness(c,fallbackEnv).ready,true);
  const task=buildAssistedPublicationTask('tiktok',{text:'conteudo aprovado'},fallbackEnv);
  assert.equal(task.requires_operator_action,true);assert.equal(task.provider_api_claimed,false);
});

test('fallbacks fail closed when evidence is missing',()=>{
  assert.equal(assistedFallbackReadiness('tiktok',{}).ready,false);
  assert.throws(()=>buildAssistedPublicationTask('linkedin',{text:'x'},{}),/assisted_channel_not_ready/);
});

test('commercial distribution counts only 9 active fronts',()=>{
  const env={...fallbackEnv,AFFILIATE_PROVIDER:'first_party'};
  const out=commercialDistributionReadiness(env);
  assert.equal(out.total_fronts,9);assert.equal(out.implemented_fronts,9);
  for(const c of ['tiktok','linkedin','nuvemshop'])assert.equal(out.fronts[c],undefined);
});
