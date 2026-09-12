import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../public/criativos.html',import.meta.url),'utf8');
const js=await readFile(new URL('../public/criativos.js',import.meta.url),'utf8');
const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');
const config=await readFile(new URL('../api/config.mjs',import.meta.url),'utf8');
const index=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const previewPng=await readFile(new URL('../public/brand/creative-sample.png',import.meta.url));
const previewWebm=await readFile(new URL('../public/brand/creative-sample.webm',import.meta.url));

test('creative center is reachable from command center and Cloudflare alias',()=>{
  assert.match(index,/href="\/criativos"/);
  assert.match(worker,/\['\/criativos', '\/criativos\.html'\]/);
});

test('creative center consumes real creative intelligence and asset previews',()=>{
  assert.match(js,/view=creative_sample/);
  assert.match(js,/image_variants/);
  assert.match(js,/video_variants/);
  assert.match(js,/png_url/);
  assert.match(js,/webm_url/);
  assert.match(config,/creative-intelligence-v2/);
  assert.match(config,/\/brand\/creative-sample\.png/);
  assert.match(config,/\/brand\/creative-sample\.webm/);
  assert.ok(previewPng.length>10000);
  assert.ok(previewWebm.length>10000);
});
test('creative center keeps commercial truth explicit and sales closed by runtime truth',()=>{
  assert.match(html,/Nenhum resultado comercial será inventado/);
  assert.match(html,/bloqueada até autorização/);
  assert.match(js,/commercial_enabled/);
});

test('Cloudflare serves signed creative assets through config handler',()=>{
  assert.match(worker,/\/api\/creative-asset/);
  assert.match(worker,/view=creative_asset/);
});
