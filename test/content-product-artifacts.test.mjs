import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ZEVANORY_PRODUCTS } from '../src/offerCatalog.mjs';

const root=new URL('../products/releases/v1.1/',import.meta.url);
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('all five content products have real versioned ZIP artifacts with canonical hashes',()=>{
  assert.equal(ZEVANORY_PRODUCTS.length,5);
  for(const product of ZEVANORY_PRODUCTS){
    assert.equal(product.sellable,true);
    assert.equal(product.artifact_materialized,true);
    const file=new URL(product.artifact_name,root);
    const bytes=fs.readFileSync(file);
    assert.ok(bytes.length>1024,`${product.sku} artifact too small`);
    assert.equal(bytes.subarray(0,2).toString('ascii'),'PK');
    assert.equal(sha256(bytes),product.artifact_sha256);
    const sourceDir=new URL(`${product.sku}/`,root);
    assert.ok(fs.existsSync(new URL('README.md',sourceDir)));
    const manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',sourceDir),'utf8'));
    assert.equal(manifest.sku,product.sku);
    assert.equal(manifest.version,'1.1');
    assert.equal(manifest.placeholder,false);
  }
});
