import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const sitemap=await readFile(new URL('../public/sitemap.xml',import.meta.url),'utf8');
const vercel=await readFile(new URL('../vercel.json',import.meta.url),'utf8');
const netlify=await readFile(new URL('../netlify.toml',import.meta.url),'utf8');
const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');

test('legacy ARBM SIST surface is preserved only in archive',async()=>{
  for(const p of ['arbm-sist.html','arbm-sist.css','arbm-sist.js','arbm-sist-privacidade.html','arbm-sist-social.png'])
    await access(new URL(`../archive/legacy-arbm-sist-public/${p}`,import.meta.url));
});

test('ZEVANORY active discovery excludes ARBM SIST',()=>{
  assert.doesNotMatch(sitemap,/\/arbm-sist/i);
  assert.doesNotMatch(vercel,/"source"\s*:\s*"\/arbm-sist/i);
  assert.doesNotMatch(netlify,/from\s*=\s*"\/arbm-sist/i);
  assert.doesNotMatch(worker,/\['\/arbm-sist'/i);
});

test('ARBM SIST legacy assets are not in public root',async()=>{
  for(const p of ['arbm-sist.html','arbm-sist.css','arbm-sist.js','arbm-sist-privacidade.html'])
    await assert.rejects(access(new URL(`../public/${p}`,import.meta.url)));
  await assert.rejects(access(new URL('../public/brand/arbm-sist-social.png',import.meta.url)));
});