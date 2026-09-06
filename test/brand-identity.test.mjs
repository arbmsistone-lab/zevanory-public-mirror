import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const pages=['public/index.html','public/piloto.html','public/termos.html','public/privacidade.html','public/reembolso.html','public/afiliados.html'];
test('official brand assets exist locally',async()=>{
  for(const p of ['public/brand/zevanory-logo-dark.svg','public/brand/zevanory-logo-light.svg','public/brand/zevanory-mark.svg','public/brand/favicon.svg']) await access(new URL(p,root));
});
test('all public surfaces use official favicon and brand',async()=>{
  for(const p of pages){const html=await readFile(new URL(p,root),'utf8');assert.match(html,/href="\/brand\/favicon\.svg"/);assert.match(html,/src="\/brand\/zevanory-logo-dark\.svg"/);}
});
test('brand is self-hosted and legacy identity absent',async()=>{
  for(const p of pages){const html=await readFile(new URL(p,root),'utf8');assert.doesNotMatch(html,/GIRO LOCAL|girolocal\.api\.br/i);assert.doesNotMatch(html,/https?:\/\/(?!zevanory\.api\.br)[^"']+\.(?:png|jpg|jpeg|svg)/i);}
});