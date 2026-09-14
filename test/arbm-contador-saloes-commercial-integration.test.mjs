import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ARBM_CONTADOR_SALOES_OFFER, arbmContadorSaloesReleaseReady } from '../src/arbmContadorSaloesOffer.mjs';
import { publicProductCatalog, resolveCheckoutOffer } from '../src/offerCatalog.mjs';

const load=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');

test('ARBM Contador para Salões is integrated with certified identity',()=>{
  const offer=ARBM_CONTADOR_SALOES_OFFER;
  assert.equal(offer.id,'ARBM-CONTADOR-SALOES');
  assert.equal(offer.source.repository,'arbmsistone-lab/arbm-mei');
  assert.equal(offer.source.release,'COMMERCIAL_RELEASE_1_0');
  assert.equal(offer.source.git_sha,'20705d1620f640cee1b2a0aac97986d312c3e808');
  assert.equal(offer.source.cloudflare_version_id,'6fa21b6b-d636-4726-a6fb-dd9d74605f6f');
  assert.ok(offer.certified_features.includes('ledger_financeiro_imutavel_com_estornos'));
  assert.ok(offer.excluded_from_v1.includes('comissoes'));
  assert.ok(offer.excluded_from_v1.includes('estoque'));
  const publicItem=publicProductCatalog().find(x=>x.id===offer.id);
  assert.ok(publicItem);
  assert.match(publicItem.status,/global_sales_locked/);
});

test('product-specific requirements are complete but checkout stays globally locked',()=>{
  const offer=ARBM_CONTADOR_SALOES_OFFER;
  assert.equal(offer.sellable,false);
  assert.equal(offer.checkout_enabled,false);
  assert.equal(offer.artifact_materialized,true);
  assert.deepEqual(Object.values(offer.release_requirements),[true,true,true,true,true,true]);
  assert.equal(arbmContadorSaloesReleaseReady(),false);
  assert.equal(resolveCheckoutOffer(offer.id),null);
});

test('public surface exposes truthful scope and approved price without checkout',async()=>{
  const [page,solutions,sitemap]=await Promise.all([
    load('arbm-contador-saloes.html'),load('solucoes.html'),load('sitemap.xml'),
  ]);
  assert.match(page,/<title>ARBM Contador para Salões \| ZEVANORY<\/title>/);
  assert.match(page,/R\$ 59,90\/mês/);
  assert.match(page,/R\$ 599,00\/ano/);
  assert.match(page,/Comissões, estoque/i);
  assert.match(page,/gate global de vendas/i);
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
