import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
const sitemap=await readFile(new URL('../public/sitemap.xml',import.meta.url),'utf8');
const vercel=await readFile(new URL('../vercel.json',import.meta.url),'utf8');
const netlify=await readFile(new URL('../netlify.toml',import.meta.url),'utf8');
const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');
const html=await readFile(new URL('../public/arbm-sist.html',import.meta.url),'utf8');

test('ARBM SIST has an active first-party discovery surface',async()=>{
  await access(new URL('../public/arbm-sist.html',import.meta.url));
  assert.match(sitemap,/https:\/\/zevanory\.api\.br\/arbm-sist/);
  assert.match(vercel,/"source"\s*:\s*"\/arbm-sist"/);
  assert.match(netlify,/from\s*=\s*"\/arbm-sist"/);
  assert.match(worker,/\['\/arbm-sist', '\/arbm-sist\.html'\]/);
});

test('ARBM SIST SEO surface is metadata-complete, price-transparent and sales-safe',()=>{
  assert.match(html,/<title>ARBM SIST \| ZEVANORY<\/title>/);
  assert.match(html,/rel="canonical" href="https:\/\/zevanory\.api\.br\/arbm-sist"/);
  assert.match(html,/application\/ld\+json/); assert.match(html,/SoftwareApplication/);
  assert.match(html,/Disponibilidade comercial sujeita aos gates oficiais/);
  assert.match(html,/ARBM PRO[\s\S]*R\$\s*1\.197/i);
  assert.doesNotMatch(html,/Comprar|href="[^\"]*checkout/i);
});
