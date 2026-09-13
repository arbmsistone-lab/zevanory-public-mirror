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
  assert.match(config,/\/brand\/creative-sample\.svg/);
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

test('creative center desktop layout is single-screen without microtype compression',async()=>{
  const css=await readFile(new URL('../public/criativos.css',import.meta.url),'utf8');
  assert.match(css,/html,body\{height:100%;overflow:hidden\}/);
  assert.match(css,/body\{height:100dvh/);
  assert.match(css,/main\{min-height:0;display:grid;.*overflow:hidden/);
  assert.match(css,/\.workspace\{min-height:0;display:grid;.*overflow:hidden/);
  assert.match(css,/\.kpis\{display:grid;grid-template-columns:repeat\(4,/);
  assert.doesNotMatch(css,/font-size:6px/);
  assert.doesNotMatch(css,/font-size:7px/);
  assert.match(css,/@media\(max-width:900px\)\{html,body\{height:auto;min-height:100%;overflow:auto\}/);
});

test('all operational fronts are selectable while commercial sales remain separately gated',()=>{
  assert.match(js,/item\.dataset\.front=name/);
  assert.match(js,/item\.addEventListener\('click',\(\)=>selectFront/);
  assert.doesNotMatch(js,/item\.disabled=true/);
  assert.match(js,/commercial_enabled\?'LIBERADA':'BLOQUEADA'/);
});

test('creative center exposes elite media investment advisor without automatic spend',()=>{
  assert.match(html,/Media Investment Advisor/);assert.match(html,/Gasto automático permanece bloqueado/);
  assert.match(js,/advisor-action/);assert.match(js,/recommended_daily_budget_brl/);assert.match(config,/adviseMediaInvestment/);
});

test('creative center separates operational readiness from commercial sales state',()=>{
  assert.match(js,/Operação/);
  assert.match(js,/Modo/);
  assert.match(js,/Atendimento/);
  assert.match(js,/Venda/);
  assert.match(js,/commercial_enabled\?'LIBERADA':'BLOQUEADA'/);
});

test('creative center fails closed when status source or contract is invalid',()=>{
  assert.match(js,/closure_status_http_/);
  assert.match(js,/creative_contract_invalid/);
  assert.match(js,/Nenhuma frente será apresentada como pronta sem prova real/);
  assert.match(js,/criação \${operational\?'ativa':'aguardando'\}/);
});

test('non visual fronts clear stale review and advisor state',()=>{ assert.match(js,/votes\.replaceChildren/); assert.match(js,/delete step\.dataset\.state/); assert.match(js,/advisor-action','N\/A'/); assert.match(js,/tiktok:'TikTok'/); assert.match(js,/linkedin:'LinkedIn'/); assert.match(js,/nuvemshop:'Nuvemshop'/); });

test('wide short desktop fits all twelve fronts without cut or overlap',async()=>{ const css=await readFile(new URL('../public/criativos.css',import.meta.url),'utf8'); assert.match(css,/grid-template-rows:repeat\(6,minmax\(0,1fr\)\)/); assert.match(css,/production-item\{min-height:0;height:100%/); });

test('cards make operation state primary and sales blocking secondary',()=>{ assert.match(js,/operation-state/); assert.match(js,/executionMode/); assert.match(js,/DIRETA/); assert.match(js,/ASSISTIDA/); });

test('advisor presents human-readable commercial evidence reasons',()=>{ assert.match(js,/Evidência comercial ainda insuficiente/); assert.match(js,/advisorReasonLabels/); });
test('senior board titles remain fully readable without ellipsis',async()=>{ const css=await readFile(new URL('../public/criativos.css',import.meta.url),'utf8'); assert.match(css,/\.board-vote b\{[^}]*white-space:normal;[^}]*text-overflow:clip/); });

test('wide short desktop keeps channel statuses readable instead of compressing four columns',async()=>{
  const css=await readFile(new URL('../public/criativos.css',import.meta.url),'utf8');
  assert.match(css,/regression guard: wide\/short desktop/);
  assert.match(css,/\.front-statuses\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/\.production-item \.channel\{font-size:11px/);
});
