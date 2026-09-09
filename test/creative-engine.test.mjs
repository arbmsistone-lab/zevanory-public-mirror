import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreativeSpec, creativeStoryboard, creativeAssetUrl, verifyCreativeToken } from '../src/creativeEngine.mjs';
import { creativeHtml, perceptualQualityScore, webmHasAudioTrack } from '../src/creativeRenderer.mjs';
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

test('perceptual score penalizes clipping and flat low-contrast render',()=>{
  const strong=perceptualQualityScore({dynamic_range:220,luminance_std:55,occupied_fraction:.35,edge_density:.08,overflow:false,hook_lines:3});
  const weak=perceptualQualityScore({dynamic_range:40,luminance_std:5,occupied_fraction:.95,edge_density:.001,overflow:true,hook_lines:7});
  assert.ok(strong>=.8);assert.ok(weak<.5);
});

test('encoded WebM audio track detector requires TrackType audio',()=>{
  assert.equal(webmHasAudioTrack(Buffer.from([0x1a,0x45,0xdf,0xa3,0x83,0x81,0x02])),true);
  assert.equal(webmHasAudioTrack(Buffer.from([0x1a,0x45,0xdf,0xa3,0x83,0x81,0x01])),false);
});

test('legacy signed v2 creative tokens remain valid after v3 rollout',async()=>{
  const legacy={version:2,brand:'ZEVANORY',channel:'instagram',objective:'awareness',width:1080,height:1080,layout:'editorial',format_name:'social_static',campaign_id:'legacy-campaign',variant_id:'v1',offer_id:'OFFER-0001',product:'ARBM SIST',price_brl:1197,hook:'Automacao com controle',body:'IA, execucao segura e evidencia real.',cta:'Conheca a ZEVANORY',site:'zevanory.api.br'};
  const crypto=await import('node:crypto');
  const creative_id=crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex').slice(0,24),spec={...legacy,creative_id};
  const payload=Buffer.from(JSON.stringify({spec,format:'png'})).toString('base64url');
  const sig=crypto.createHmac('sha256',env.CREATIVE_ASSET_SIGNING_KEY).update(payload).digest('base64url');
  const verified=verifyCreativeToken(payload,sig,env); assert.equal(verified.spec.creative_id,creative_id); assert.equal(verified.spec.version,2);
});