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
test('creative center keeps only sales blocked while preparation stays active',()=>{
  assert.match(html,/VENDAS BLOQUEADAS/);
  assert.match(html,/Pesquisa, cria/);
  assert.match(js,/commercial_enabled/);
  assert.match(js,/distribution\?\.fronts/);
  assert.match(js,/FRONT_LABELS/);
});

test('creative center exposes mandatory unanimous senior board',()=>{
  assert.match(html,/Banca 5\/5/);
  assert.match(html,/unanimidade obrigat/);
  assert.match(config,/review_policy/);
  assert.match(config,/unanimous_required:true/);
});

test('Cloudflare serves signed creative assets through config handler',()=>{
  assert.match(worker,/\/api\/creative-asset/);
  assert.match(worker,/view=creative_asset/);
});

test('creative center desktop layout is explicitly single-screen and scroll-free',async()=>{
  const css=await readFile(new URL('../public/criativos.css',import.meta.url),'utf8');
  assert.match(css,/html,body\{height:100%;min-height:0;overflow:hidden\}/);
  assert.match(css,/body\{height:100dvh/);
  assert.match(css,/main\{min-height:0;overflow:hidden/);
  assert.match(css,/\.workspace\{min-height:0;height:auto;overflow:hidden/);
  assert.match(css,/@media\(max-width:760px\)\{html,body\{height:auto;min-height:100%;overflow:auto\}/);
});

test('creative center exposes elite media investment advisor without automatic spend',()=>{
  assert.match(html,/Media Investment Advisor/);assert.match(html,/Gasto automÃ¡tico permanece bloqueado/);
  assert.match(js,/advisor-action/);assert.match(js,/recommended_daily_budget_brl/);assert.match(config,/adviseMediaInvestment/);
});
});
