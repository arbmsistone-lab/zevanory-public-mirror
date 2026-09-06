import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNuvemshopCsv, normalizeNuvemshopCsvRow, nuvemshopCsvFallbackReadiness } from '../src/nuvemshopCsvFallback.mjs';
import { commercialDistributionReadiness } from '../src/commercialDistribution.mjs';
import { publicChannelStatus } from '../src/publicChannelStatus.mjs';

test('create mode keeps Identificador URL empty and emits UTF-8 BOM CSV',()=>{
  const csv=buildNuvemshopCsv([{name:'Produto Ágil',price:197,stock:'-',sku:'ZEV-001',visible:true,description:'Descrição'}],{mode:'create'});
  assert.equal(csv.charCodeAt(0),0xFEFF);
  assert.match(csv,/Identificador URL,Nome,Preço/);
  assert.match(csv,/,Produto Ágil,197\.00,/);
});

test('update mode requires stable Identificador URL',()=>{
  assert.throws(()=>normalizeNuvemshopCsvRow({name:'X',price:10,sku:'SKU-1'},{mode:'update'}),/identifier_required/);
  const row=normalizeNuvemshopCsvRow({identifier_url:'produto-x',name:'X',price:10,sku:'SKU-1'},{mode:'update'});
  assert.equal(row['Identificador URL'],'produto-x');
});
test('CSV fallback rejects duplicate SKUs and oversized batches',()=>{
  assert.throws(()=>buildNuvemshopCsv([{name:'A',price:1,sku:'DUP'},{name:'B',price:2,sku:'DUP'}]),/sku_duplicate/);
  assert.throws(()=>buildNuvemshopCsv(Array.from({length:20001},(_,i)=>({name:`P${i}`,price:1,sku:`S${i}`}))),/row_limit_exceeded/);
});

test('contingency readiness is explicit and does not become API automation',()=>{
  assert.equal(nuvemshopCsvFallbackReadiness({}).ready,false);
  const env={NUVEMSHOP_CSV_FALLBACK_VERIFIED:'true',NUVEMSHOP_STOREFRONT_VERIFIED:'true',NUVEMSHOP_STOREFRONT_URL:'https://zevanory.lojavirtualnuvem.com.br/'};
  const distribution=commercialDistributionReadiness(env).fronts.nuvemshop;
  assert.equal(distribution.contingency_ready,true);
  assert.equal(distribution.contingency_mode,'admin_csv');
  assert.equal(distribution.alternate_api_ready,false);
  const status=publicChannelStatus(env).nuvemshop;
  assert.equal(status.contingency_ready,true);
  assert.equal(status.api_configured,false);
});

test('CSV keeps Portuguese headers and content without mojibake',()=>{
  const csv=buildNuvemshopCsv([{name:'ZEVANORY Negócio Completo',price:347,sku:'ZEV-NGC-011',description:'Descrição versão prática'}]);
  assert.equal(csv.includes('\uFFFD'),false);
  assert.equal(csv.includes('Ã'),false);
  assert.match(csv,/Preço promocional/);
  assert.match(csv,/Descrição/);
  assert.match(csv,/Negócio Completo/);
  assert.match(csv,/versão prática/);
});
