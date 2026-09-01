import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const privacy=await readFile(new URL('../public/arbm-sist-privacidade.html',import.meta.url),'utf8');
const offer=await readFile(new URL('../public/arbm-sist.html',import.meta.url),'utf8');
const vercel=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));

test('ARBM SIST exposes a dedicated privacy policy for Store distribution',()=>{
  assert.match(privacy,/ARBM SIST V10/);
  assert.match(privacy,/local-first/i);
  assert.ok(privacy.includes('telemetria externa')&&privacy.includes('desativados por padrão'));
  assert.match(privacy,/conectores opcionais/i);
  assert.match(privacy,/chaves de API não são incluídas/i);
  assert.match(privacy,/não vende dados pessoais/i);
});

test('ARBM SIST Store privacy route is public and linked from the offer',()=>{
  assert.ok(vercel.rewrites.some(x=>x.source==='/arbm-sist/privacidade'&&x.destination==='/public/arbm-sist-privacidade.html'));
  assert.match(offer,/href="\/arbm-sist\/privacidade">Privacidade ARBM SIST/);
});
