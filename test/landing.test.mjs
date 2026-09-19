import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const js=await readFile(new URL('../public/index.js',import.meta.url),'utf8');
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');

test('central identifies ZEVANORY and connects authenticated operational APIs',()=>{
  assert.match(html,/<title>ZEVANORY \| IA, automação, software e produtos digitais<\/title>/);assert.match(html,/CENTRAL OPERACIONAL/);
  for(const path of ['/private-api/status','/private-api/health','/private-api/release','/private-api/config']) assert.match(js,new RegExp(path.replaceAll('/','\\/')));
  assert.doesNotMatch(html,/GIRO LOCAL/i);
});

test('central preserves complete sales machine infrastructure through progressive disclosure',()=>{
  for(const id of ['crm','follow-up','unit-economics','learning','outbound','db-state','schema-state','schema-tables','schema-migrations','quality-gate','dr-mode','switches']) assert.match(html,new RegExp(`id="${id}"`));
  for(const key of ['page_views','leads_qualified','pipeline_open','actions_scheduled','offers_sent','checkouts_started','payments_confirmed','refunds_confirmed']) assert.match(html,new RegExp(`data-kpi="${key}"`));
  assert.match(html,/id="details-dialog"/);
});

test('central keeps commercial truth and no-baseline semantics explicit',()=>{
  assert.match(html,/nenhuma venda simulada/i);assert.match(js,/SEM BASELINE/);assert.match(js,/BLOQUEADO GLOBALMENTE/);assert.match(html,/dados agregados · sem PII/i);
});

test('central has no inline executable code under strict CSP',()=>{
  assert.doesNotMatch(html,/<style[>\s]/i);assert.doesNotMatch(html,/<script>([\s\S]*?)<\/script>/i);assert.match(html,/href="\/index\.css"/);assert.match(html,/src="\/index\.js"/);
});

test('central prioritizes decision, pipeline and clean UTF-8',()=>{
  for(const id of ['queue-pressure','nba-mode','forecast-mode','readiness-state','blocker-count','predictive-forecast','commercial-score']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/Decisão segura\.\s*<br>Execução com verdade\./i);assert.match(html,/Prontidão comercial/);assert.match(js,/BASELINE NECESSÁRIO/);
  for(const bad of ['\u00c3\u00a9','\u00c3\u00a7','\u00c3\u00a3','\ufffd']) assert.equal((html+js).includes(bad),false);
});

test('central exposes authenticated live-company observability without inventing sales',()=>{
  for(const id of ['coverage-state','coverage-score','coverage-copy','source-health','channel-grid','live-operations','live-connection-state']) assert.match(html,new RegExp(`id="${id}"`));
  for(const path of ['/private-api/status','/private-api/health','/private-api/release','/private-api/config','/private-api/agent/status']) assert.match(js,new RegExp(path.replaceAll('/','\\/')));
  assert.match(js,/Promise\.allSettled/);
  assert.match(js,/renderPublicOperations/);
  assert.match(js,/renderCoverage/);
  assert.match(html,/Dados agregados · sem PII/i);
  assert.match(html,/Venda continua bloqueada/i);
});

test('detail dialog keeps regression-safe geometry and channel branding',()=>{
  assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css,/\.channel-section,\.controls-section\{grid-column:1\/-1\}/);
  assert.match(css,/\.quality-inline\{display:flex;align-items:center;justify-content:space-between/);
  assert.match(html,/class="detail-section controls-section"/);
  for(const brand of ['WhatsApp','TikTok','YouTube','LinkedIn']) assert.match(js,new RegExp(brand));
  assert.match(js,/channelLabel\(name\)/);
});


test('portfolio exposes ZEVANORY ONE as a first-class solution',async()=>{
  const solutions=await readFile(new URL('../public/solucoes.html',import.meta.url),'utf8');
  const one=await readFile(new URL('../public/zevanory-one.html',import.meta.url),'utf8');
  const sitemap=await readFile(new URL('../public/sitemap.xml',import.meta.url),'utf8');
  assert.match(html,/class=\"portfolio-link\" href=\"\/solucoes\">Nossas Solu\u00e7\u00f5es/);
  assert.match(solutions,/href=\"\/zevanory-one\">ZEVANORY ONE/);
  assert.match(one,/<title>ZEVANORY ONE \| ZEVANORY<\/title>/);
  assert.match(one,/PDV, atendimento, delivery, fidelidade/i);
  assert.match(sitemap,/https:\/\/zevanory\.api\.br\/zevanory-one/);
});
