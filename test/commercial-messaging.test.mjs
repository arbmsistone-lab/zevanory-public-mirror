import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMERCIAL_MESSAGES, COMMERCIAL_POSITIONING, commercialMessageFor, commercialMessagingAudit } from '../src/commercialMessaging.mjs';
import { CHANNEL_PROFILES } from '../src/channelProfiles.mjs';

const fronts=['zevanory','whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','google','affiliate','nuvemshop','mercado_livre'];

test('all 12 commercial fronts have complete senior messaging',()=>{
  const audit=commercialMessagingAudit();
  assert.equal(audit.approved,true);
  assert.equal(audit.total,12);
  assert.equal(audit.failures.length,0);
  for(const key of fronts){
    const x=COMMERCIAL_MESSAGES[key];
    for(const field of ['headline','bio','body','cta_pre_sale','cta_live','proof','cta_policy']) assert.ok(String(x[field]||'').trim(),`${key}:${field}`);
  }
});

test('pre-sale messaging never exposes live purchase CTA',()=>{
  for(const key of fronts){
    const pre=commercialMessageFor(key,{salesEnabled:false});
    assert.equal(pre.cta,pre.cta_pre_sale);
    assert.notEqual(pre.cta,pre.cta_live);
  }
});

test('channel profiles consume canonical commercial messaging',()=>{
  for(const key of fronts){
    assert.equal(CHANNEL_PROFILES[key].headline,COMMERCIAL_MESSAGES[key].headline);
    assert.equal(CHANNEL_PROFILES[key].proof,COMMERCIAL_MESSAGES[key].proof);
  }
  assert.match(COMMERCIAL_POSITIONING.proof_standard,/evidencia/i);
});
