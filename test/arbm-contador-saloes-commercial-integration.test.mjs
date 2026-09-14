import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ARBM_CONTADOR_SALOES_OFFER, arbmContadorSaloesReleaseReady } from '../src/arbmContadorSaloesOffer.mjs';
import { publicProductCatalog, resolveCheckoutOffer } from '../src/offerCatalog.mjs';

const load=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');

test('ARBM Contador para Salões is integrated into the official portfolio',()=>{
  const offer=ARBM_CONTADOR_SALOES_OFFER;
  assert.equal(offer.id,'ARBM-CONTADOR-SALOES');
  assert.equal(offer.brand,'ZEVANORY');
  assert.equal(offer.endorsed_by,'ARBM');
  assert.equal(offer.portfolio_role,'vertical_business_software');
  const publicItem=publicProductCatalog().find(x=>x.id===offer.id);
  assert.ok(publicItem);
  assert.match(publicItem.status,/not_published/);
});

test('ARBM Contador checkout is impossible before product and global gates',()=>{
  const offer=ARBM_CONTADOR_SALOES_OFFER;
  assert.equal(offer.sellable,false);
  assert.equal(offer.checkout_enabled,false);
  assert.equal(offer.artifact_materialized,false);
  assert.equal(arbmContadorSaloesReleaseReady(),false);
  assert.equal(resolveCheckoutOffer(offer.id),null);
});

test('public surface, SEO and support contract are present without premature price claims',async()=>{
  const [page,solutions,sitemap]=await Promise.all([
    load('arbm-contador-saloes.html'),load('solucoes.html'),load('sitemap.xml'),
  ]);
  assert.match(page,/<title>ARBM Contador para Salões \| ZEVANORY<\/title>/);
  assert.match(page,/ARBM-CONTADOR-SALOES/);
  assert.match(page,/Preço específico ainda não publicado/i);
  assert.match(page,/suporte@zevanory\.api\.br/i);
  assert.match(page,/privacidade/i);
  assert.match(page,/Cancelamento e reembolso/i);
  assert.match(solutions,/href="\/arbm-contador-saloes">ARBM Contador para Salões/);
  assert.match(sitemap,/https:\/\/zevanory\.api\.br\/arbm-contador-saloes/);
});

test('all static runtimes route the product landing',async()=>{
  const [worker,netlify,vercelText]=await Promise.all([
    readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8'),
    readFile(new URL('../netlify.toml',import.meta.url),'utf8'),
    readFile(new URL('../vercel.json',import.meta.url),'utf8'),
  ]);
  assert.match(worker,/\['\/arbm-contador-saloes', '\/arbm-contador-saloes\.html'\]/);
  assert.match(netlify,/from = "\/arbm-contador-saloes"[\s\S]*to = "\/arbm-contador-saloes\.html"/);
  assert.ok(JSON.parse(vercelText).rewrites.some(x=>x.source==='/arbm-contador-saloes'&&x.destination==='/public/arbm-contador-saloes.html'));
});
