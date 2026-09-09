import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreativeSpec, creativeStoryboard, creativeAssetUrl, verifyCreativeToken } from '../src/creativeEngine.mjs';
import { creativeHtml } from '../src/creativeRenderer.mjs';
import { evaluateAgentDecision } from '../src/agentEvals.mjs';
import { chooseTool } from '../src/revenueAgent.mjs';

const env={CREATIVE_ASSET_SIGNING_KEY:'x'.repeat(48),PUBLIC_BASE_URL:'https://zevanory.api.br'};

test('creative engine builds deterministic brand-safe image and video specs',()=>{
  const a=createCreativeSpec({offerId:'OFFER-0001',channel:'instagram',hook:'Automacao sem dependencia',body:'Controle, evidencia e execucao segura.',cta:'Conheca'});
  const b=createCreativeSpec({offerId:'OFFER-0001',channel:'instagram',hook:'Automacao sem dependencia',body:'Controle, evidencia e execucao segura.',cta:'Conheca'});
  assert.equal(a.creative_id,b.creative_id); assert.equal(a.brand,'ZEVANORY'); assert.deepEqual([a.width,a.height],[1080,1080]);
  const v=createCreativeSpec({offerId:'OFFER-0001',channel:'tiktok'}); assert.deepEqual([v.width,v.height],[1080,1920]); assert.equal(creativeStoryboard(v).length,3);
});

test('signed creative URL is tamper evident',()=>{
  const spec=createCreativeSpec({offerId:'OFFER-0001',channel:'youtube'}); const url=new URL(creativeAssetUrl(spec,'webm',env));
  const ok=verifyCreativeToken(url.searchParams.get('p'),url.searchParams.get('s'),env); assert.equal(ok.format,'webm'); assert.equal(ok.spec.creative_id,spec.creative_id);
  assert.equal(verifyCreativeToken(url.searchParams.get('p')+'x',url.searchParams.get('s'),env),null);
});

test('creative HTML carries canonical brand and no remote dependency',()=>{
  const spec=createCreativeSpec({offerId:'OFFER-0001',channel:'instagram',hook:'Teste'}); const html=creativeHtml(spec);
  assert.match(html,/ZEVANORY/); assert.match(html,/zevanory\.api\.br/); assert.doesNotMatch(html,/https:\/\//i);
});

test('agent can draft creative while publish remains separately gated',()=>{
  assert.equal(chooseTool({action:'create_creative'}),'create_creative');
  const draft=evaluateAgentDecision({decision:{action:'create_creative',rationale:'prepare asset',confidence:.9,channel:'instagram'},tool:'create_creative',authorization:{allowed:true}});
  assert.equal(draft.pass,true);
  const auto=evaluateAgentDecision({decision:{action:'publish_content',rationale:'publish approved content',confidence:.9,channel:'instagram',content:'Conteudo valido',auto_creative:true},tool:'publish_content',authorization:{allowed:false}});
  assert.equal(auto.pass,true); assert.ok(!auto.issues.includes('instagram_media_missing'));
  const manual=evaluateAgentDecision({decision:{action:'publish_content',rationale:'manual media',confidence:.9,channel:'instagram',content:'Conteudo valido',auto_creative:false},tool:'publish_content',authorization:{allowed:false}});
  assert.equal(manual.pass,false); assert.ok(manual.issues.includes('instagram_media_missing'));
});
