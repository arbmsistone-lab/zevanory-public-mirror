import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_PROFILES } from '../src/channelProfiles.mjs';

test('TikTok canonical profile matches the verified ZEVANORY account',()=>{
  assert.equal(CHANNEL_PROFILES.tiktok.handle,'@zevanory3');
  assert.equal(CHANNEL_PROFILES.tiktok.profileUrl,'https://www.tiktok.com/@zevanory3');
});
