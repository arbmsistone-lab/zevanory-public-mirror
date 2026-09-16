import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const slugs=['solucoes','arbm-sist','ia-na-pratica','vendas-na-pratica','lucro-e-caixa','combo-ia-vendas','negocio-completo'];
const sitemap=await readFile(new URL('../public/sitemap.xml',import.meta.url),'utf8');
const robots=await readFile(new URL('../public/robots.txt',import.meta.url),'utf8');
const vercel=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
const netlify=await readFile(new URL('../netlify.toml',import.meta.url),'utf8');
const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');

test('public SEO routes are complete across primary and standby providers',()=>{
  for(const slug of slugs){
    assert.match(sitemap,new RegExp(`https://zevanory\\.api\\.br/${slug}`));
    assert.ok(vercel.rewrites.some(x=>x.source===`/${slug}`&&x.destination===`/public/${slug}.html`));
    assert.match(netlify,new RegExp(`from\\s*=\\s*"/${slug}"`));
    assert.match(worker,new RegExp(`\\['/${slug}', '/${slug}\\.html'\\]`));
  }
  assert.match(robots,/Allow:\s*\//);
  assert.match(robots,/Sitemap:\s*https:\/\/zevanory\.api\.br\/sitemap\.xml/);
});

test('every commercial page exposes canonical SEO metadata',async()=>{
  for(const slug of slugs){
    const html=await readFile(new URL(`../public/${slug}.html`,import.meta.url),'utf8');
    assert.match(html,/<title>[^<]+<\/title>/);
    assert.match(html,/<meta name="description" content="[^"]+">/);
    assert.match(html,new RegExp(`rel="canonical" href="https://zevanory\\.api\\.br/${slug}"`));
    assert.match(html,/property="og:title"/); assert.match(html,/name="twitter:card"/);
    assert.match(html,/application\/ld\+json/); assert.match(html,/<h1>[^<]+<\/h1>/);
  }
});