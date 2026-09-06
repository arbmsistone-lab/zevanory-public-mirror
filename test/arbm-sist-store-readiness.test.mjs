import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
const archivedPrivacy=await readFile(new URL('../archive/legacy-arbm-sist-public/arbm-sist-privacidade.html',import.meta.url),'utf8');
const release=await readFile(new URL('../src/release.mjs',import.meta.url),'utf8');

test('legacy ARBM SIST privacy artifact remains preserved for historical traceability',()=>{
  assert.match(archivedPrivacy,/ARBM SIST V10/);
  assert.match(archivedPrivacy,/local-first/i);
});

test('ARBM SIST is excluded from current ZEVANORY required routes',async()=>{
  assert.doesNotMatch(release,/requiredRoutes:[\s\S]*['"]\/arbm-sist['"]/);
  await assert.rejects(access(new URL('../public/arbm-sist-privacidade.html',import.meta.url)));
});