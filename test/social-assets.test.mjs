import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function pngSize(file){
  const b=fs.readFileSync(new URL(file,import.meta.url));
  assert.equal(b.subarray(1,4).toString('ascii'),'PNG');
  return [b.readUInt32BE(16),b.readUInt32BE(20)];
}

test('official social profile asset is production-sized',()=>{
  assert.deepEqual(pngSize('../public/brand/social/zevanory-social-profile-1080.png'),[1080,1080]);
});

test('canonical avatar is exactly the approved social profile asset',()=>{
  const profile=fs.readFileSync(new URL('../public/brand/social/zevanory-social-profile-1080.png',import.meta.url));
  const avatar=fs.readFileSync(new URL('../public/brand/zevanory-avatar.png',import.meta.url));
  assert.deepEqual(avatar,profile);
});

test('official Facebook cover asset is production-sized',()=>{
  assert.deepEqual(pngSize('../public/brand/social/zevanory-facebook-cover-1640x624.png'),[1640,624]);
});

test('social variants preserve official dark background source',()=>{
  const profile=fs.readFileSync(new URL('../brand/social/zevanory-social-profile-1080.svg',import.meta.url),'utf8');
  const cover=fs.readFileSync(new URL('../brand/social/zevanory-facebook-cover-1640x624.svg',import.meta.url),'utf8');
  assert.match(profile,/#05070A/); assert.match(cover,/#05070A/);
  assert.doesNotMatch(profile,/rotate\(|skew|scale\(/i);
  assert.doesNotMatch(cover,/rotate\(|skew|scale\(/i);
});
