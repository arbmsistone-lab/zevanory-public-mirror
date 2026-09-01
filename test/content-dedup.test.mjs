import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalizeContent,contentFingerprint,jaccardSimilarity,compareContent,evaluateContentNovelty,CONTENT_DEDUP_POLICY} from '../src/contentDedup.mjs';

test('canonicalization is Unicode stable and ignores cosmetic URL punctuation',()=>{
  const a='Oferta ＺＥＶＡＮＯＲＹ! https://x.example/a?utm_source=x';
  const b='oferta ZEVANORY';
  assert.equal(canonicalizeContent(a),canonicalizeContent(b));
  assert.equal(contentFingerprint(a),contentFingerprint(b));
});

test('Jaccard shingles distinguish identical and unrelated content',()=>{
  assert.equal(jaccardSimilarity('um dois tres quatro','um dois tres quatro'),1);
  assert.equal(jaccardSimilarity('um dois tres quatro','alpha beta gamma delta'),0);
});

test('same-channel near duplicate is blocked above conservative threshold',()=>{
  const original='Conheça a nova automação de vendas da Zevanory para organizar leads responder clientes e acompanhar resultados reais';
  const variant='Conheça a nova automação de vendas da Zevanory para organizar leads responder clientes e acompanhar resultados verdadeiros';
  const r=compareContent(variant,{content:original,channel:'instagram',candidate_channel:'instagram'});
  assert.equal(r.duplicate,true);assert.equal(r.kind,'near');assert.ok(r.similarity>=CONTENT_DEDUP_POLICY.same_channel_threshold);
});
test('cross-channel adaptation is allowed unless similarity is extreme',()=>{
  const original='Conheça a nova automação de vendas da Zevanory para organizar leads responder clientes e acompanhar resultados reais';
  const variant='Conheça a nova automação de vendas da Zevanory para organizar leads responder clientes e acompanhar resultados verdadeiros';
  const r=compareContent(variant,{content:original,channel:'instagram',candidate_channel:'facebook'});
  assert.equal(r.duplicate,false);assert.ok(r.similarity<CONTENT_DEDUP_POLICY.cross_channel_threshold);
});

test('exact duplicate is blocked across channels using canonical fingerprint',async()=>{
  const sql={query:async()=>[{destination:'channel:instagram',content:'Oferta premium ZEVANORY! https://z.example/x',created_at:'2026-09-01T10:00:00Z'}]};
  const r=await evaluateContentNovelty(sql,{content:'oferta premium zevanory',channel:'facebook'});
  assert.equal(r.allowed,false);assert.equal(r.reason,'content_duplicate_exact');assert.equal(r.match.channel,'instagram');
});

test('novel content remains allowed and exposes deterministic fingerprint',async()=>{
  const sql={query:async()=>[{destination:'channel:instagram',content:'Automação comercial para organizar leads com segurança e governança comprovável',created_at:'2026-09-01T10:00:00Z'}]};
  const r=await evaluateContentNovelty(sql,{content:'Guia técnico de implantação para equipes que precisam reduzir retrabalho operacional sem promessas de resultado',channel:'instagram'});
  assert.equal(r.allowed,true);assert.equal(r.reason,'content_novel');assert.equal(r.fingerprint.length,64);assert.equal(r.policy,'content-dedup-v1');
});
