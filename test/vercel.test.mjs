import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import configHandler from '../api/config.mjs';

function mock(method='GET') {
  const headers={};
  return {req:{method},res:{statusCode:200,body:'',setHeader(k,v){headers[k.toLowerCase()]=v;},end(v=''){this.body=v;return this;},headers}};
}

test('production config blocks all sales while pre-sale gates are open',()=>{
  const old={sale:process.env.SALE_GLOBALLY_ENABLED,pre:process.env.PRE_SALE_GATES_APPROVED,wa:process.env.WHATSAPP_SALES_ENABLED};
  delete process.env.SALE_GLOBALLY_ENABLED; delete process.env.PRE_SALE_GATES_APPROVED; delete process.env.WHATSAPP_SALES_ENABLED;
  const {req,res}=mock('GET');
  configHandler(req,res);
  const body=JSON.parse(res.body);
  assert.equal(res.statusCode,200);
  assert.equal(body.commercial_enabled,false);
  assert.equal(body.whatsapp_enabled,false);
  assert.equal(body.whatsapp_number,null);
  assert.equal(body.production_mode,'pre-sale-blocked');
  for(const [k,v] of Object.entries({SALE_GLOBALLY_ENABLED:old.sale,PRE_SALE_GATES_APPROVED:old.pre,WHATSAPP_SALES_ENABLED:old.wa})) { if(v===undefined) delete process.env[k]; else process.env[k]=v; }
});

test('event function uses Neon with idempotent insert',async()=>{
  const raw=await readFile(new URL('../api/events-public.mjs',import.meta.url),'utf8');
  assert.ok(raw.includes('@neondatabase/serverless'));
  assert.ok(raw.includes('ON CONFLICT (event_id) DO NOTHING'));
  assert.ok(raw.includes('sql.query(`'));
  assert.ok(raw.includes('normalizePublicEvent'));
});

test('temporary migration surfaces are absent',async()=>{
  let endpoint=true;
  try { await access(new URL('../api/admin-migrate.mjs',import.meta.url)); } catch { endpoint=false; }
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(endpoint,false);
  assert.equal(Boolean(pkg.scripts['vercel-build']),false);
});

test('vercel routing publishes landing and exact event endpoint',async()=>{
  const raw=await readFile(new URL('../vercel.json',import.meta.url),'utf8');
  const cfg=JSON.parse(raw);
  assert.ok(cfg.rewrites.some(x=>x.source==='/'&&x.destination==='/public/index.html'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/piloto'&&x.destination==='/public/piloto.html'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/termos'&&x.destination==='/public/termos.html'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/privacidade'&&x.destination==='/public/privacidade.html'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/exclusao-dados'&&x.destination==='/public/exclusao-dados.html'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/reembolso'&&x.destination==='/public/reembolso.html'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/afiliados'&&x.destination==='/public/afiliados.html'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/legal.css'&&x.destination==='/public/legal.css'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/api/events/public'&&x.destination==='/api/events-public'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/api/webhooks/meta'&&x.destination==='/api/webhooks?provider=meta'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/api/webhooks/resend'&&x.destination==='/api/webhooks?provider=resend'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/api/webhooks/mercadolivre'&&x.destination==='/api/webhooks?provider=mercadolivre'));
  assert.equal(cfg.cleanUrls,true);
});

test('vercel global headers harden browser attack surface',async()=>{
  const raw=await readFile(new URL('../vercel.json',import.meta.url),'utf8');
  const cfg=JSON.parse(raw);
  const headers=Object.fromEntries(cfg.headers[0].headers.map(({key,value})=>[key,value]));
  assert.equal(headers['X-Content-Type-Options'],'nosniff');
  assert.equal(headers['X-Frame-Options'],'DENY');
  assert.equal(headers['Permissions-Policy'],'camera=(), microphone=(), geolocation=()');
  assert.equal(headers['Cross-Origin-Opener-Policy'],'same-origin');
});
test('vercel enforces strict CSP and cross-origin isolation headers',async()=>{
  const raw=await readFile(new URL('../vercel.json',import.meta.url),'utf8');
  const cfg=JSON.parse(raw);
  const headers=Object.fromEntries(cfg.headers[0].headers.map(({key,value})=>[key,value]));
  assert.equal(headers['Content-Security-Policy'],"default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'");
  assert.equal(headers['Cross-Origin-Resource-Policy'],'same-origin');
  assert.equal(headers['X-DNS-Prefetch-Control'],'off');
});

test('vercel Hobby serverless function budget stays within 12',async()=>{
  const {readdir}=await import('node:fs/promises');
  const apiFiles=(await readdir(new URL('../api/',import.meta.url),{withFileTypes:true})).filter(x=>x.isFile()&&x.name.endsWith('.mjs'));
  assert.ok(apiFiles.length<=12,`serverless function budget exceeded: ${apiFiles.length}/12`);
  assert.equal(apiFiles.length,11);
});
