import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAND_PROFILE, CHANNEL_PROFILES } from '../src/channelProfiles.mjs';

test('canonical identity covers all 12 commercial fronts',()=>{
  const expected=['zevanory','whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','google','affiliate','nuvemshop','mercado_livre'];
  assert.deepEqual(Object.keys(CHANNEL_PROFILES).sort(),expected.sort());
});

test('all fronts use ZEVANORY official profile image and site campaign link',()=>{
  for(const [key,p] of Object.entries(CHANNEL_PROFILES)){
    assert.equal(p.name,'ZEVANORY',key);
    assert.equal(p.profileImage,BRAND_PROFILE.profileImage,key);
    assert.match(p.url,/^https:\/\/zevanory\.api\.br\//,key);
  }
});

test('confirmed handles are preserved instead of aspirational aliases',()=>{
  assert.equal(CHANNEL_PROFILES.instagram.handle,'@zevanory_');
  assert.equal(CHANNEL_PROFILES.tiktok.handle,'@zevanory3');
  assert.equal(CHANNEL_PROFILES.youtube.handle,'@zevanory');
});
