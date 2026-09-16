import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicDecision } from '../src/aiProvider.mjs';
import { authorizeTool } from '../src/agentPolicy.mjs';
import { evaluateAgentDecision } from '../src/agentEvals.mjs';
import { channelReadiness, assertChannelActionAllowed, assertChannelPublicationAllowed } from '../src/channelAdapters.mjs';
import { chooseTool } from '../src/revenueAgent.mjs';

test('AI provider falls back deterministically without external key', async()=>{
  const decision=deterministicDecision({stage:'qualified'});
  assert.equal(decision.provider,'deterministic');
  assert.equal(decision.action,'offer');
  assert.match(decision.input_hash,/^[a-f0-9]{64}$/);
});

test('tool policy is deny-by-default for commercial and financial actions',()=>{
  const env={SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false',CHECKOUT_ENABLED:'false',FINANCIAL_EVENTS_ENABLED:'false'};
  assert.equal(authorizeTool('get_command_center',env).allowed,true);
  assert.equal(authorizeTool('send_message',env).allowed,false);
  assert.equal(authorizeTool('start_checkout',env).allowed,false);
  assert.equal(authorizeTool('not_real',env).allowed,false);
});
test('agent eval rejects unsupported commercial claims',()=>{
  const result=evaluateAgentDecision({decision:{action:'offer',rationale:'Venda garantida amanhã',confidence:.8}});
  assert.equal(result.pass,false);
  assert.ok(result.issues.includes('unsupported_commercial_claim'));
});

test('channel adapters remain provider-agnostic and gated',()=>{
  const env={SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false'};
  const state=channelReadiness(env);
  assert.equal(state.whatsapp.provider,'meta-whatsapp-cloud-api');
  assert.equal(state.email.configured,false);
  assert.equal(channelReadiness({TIKTOK_CLIENT_KEY:'k',TIKTOK_CLIENT_SECRET:'s',TIKTOK_TOKEN_ENCRYPTION_KEY:'x',TIKTOK_EXPECTED_USERNAME:'zevanory',TIKTOK_CONTENT_SOURCE_VERIFIED:'false',TIKTOK_IDENTITY_VERIFIED:'true',TIKTOK_CLIENT_AUDITED:'true'}).tiktok.configured,false);
  assert.equal(channelReadiness({TIKTOK_CLIENT_KEY:'k',TIKTOK_CLIENT_SECRET:'s',TIKTOK_TOKEN_ENCRYPTION_KEY:'x',TIKTOK_EXPECTED_USERNAME:'zevanory',TIKTOK_CONTENT_SOURCE_VERIFIED:'true',TIKTOK_IDENTITY_VERIFIED:'true',TIKTOK_CLIENT_AUDITED:'true'}).tiktok.configured,true);
  assert.throws(()=>assertChannelActionAllowed('whatsapp',env));
});

test('agent maps decisions only to registered safe tools',()=>{
  assert.equal(chooseTool({action:'first_response'}),'schedule_follow_up');
  assert.equal(chooseTool({action:'qualify'}),'remember_fact');
  assert.equal(chooseTool({action:'offer'}),'create_offer_draft');
  assert.equal(chooseTool({action:'unknown'}),'get_command_center');
});
test('agent worker uses benchmarked follow-up scheduler instead of fixed delay', async()=>{
  const { readFile }=await import('node:fs/promises');
  const worker=await readFile(new URL('../src/agentWorker.mjs',import.meta.url),'utf8');
  assert.match(worker,/buildFollowUpPlan/);
  assert.doesNotMatch(worker,/60\*60\*1000/);
});

test('operator bridge prevents pipeline regression', async()=>{
  const { readFile }=await import('node:fs/promises');
  const source=await readFile(new URL('../api/events-operator.mjs',import.meta.url),'utf8');
  assert.match(source,/salesStageRank/);
  assert.match(source,/invalid_sales_transition/);
});

test('commercial and financial decisions map to gated tools',()=>{
  assert.equal(chooseTool({action:'send_message'}),'send_message');
  assert.equal(chooseTool({action:'publish_content'}),'publish_content');
  assert.equal(chooseTool({action:'start_checkout'}),'start_checkout');
  assert.equal(chooseTool({action:'refund_payment'}),'refund_payment');
});


test('Nuvemshop readiness requires current NubeSDK verification',()=>{
  const base={
    NUVEMSHOP_APP_ID:'app',
    NUVEMSHOP_CLIENT_SECRET:'secret',
    COMMERCIAL_OAUTH_ENCRYPTION_KEY:'key',
    NUVEMSHOP_IDENTITY_VERIFIED:'true',
    NUVEMSHOP_WEBHOOKS_VERIFIED:'true'
  };
  assert.equal(channelReadiness(base).nuvemshop.configured,false);
  assert.ok(channelReadiness(base).nuvemshop.missing.includes('NUVEMSHOP_NUBESDK_VERIFIED'));
  assert.equal(channelReadiness({...base,NUVEMSHOP_NUBESDK_VERIFIED:'true'}).nuvemshop.configured,true);
});

test('organic publishing is allowed while sales stay blocked',()=>{
  const env={SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false',CHECKOUT_ENABLED:'false',FINANCIAL_EVENTS_ENABLED:'false',ORGANIC_PUBLISHING_ENABLED:'true'};
  const organic={organic_only:true,commercial_intent:false,objective:'awareness',content:'Conteudo institucional da ZEVANORY'};
  assert.equal(authorizeTool('publish_content',env,organic).allowed,true);
  assert.equal(authorizeTool('send_message',env).allowed,false);
  assert.equal(authorizeTool('start_checkout',env).allowed,false);
  assert.equal(authorizeTool('refund_payment',env).allowed,false);
  assert.equal(authorizeTool('publish_content',env,{...organic,content:'Compre agora por R$ 99'}).allowed,false);
});


test('organic publishing cannot bypass commerce channels',()=>{
 const env={SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false',ORGANIC_PUBLISHING_ENABLED:'true'};const organic={organic_only:true,commercial_intent:false,objective:'awareness',content:'Conteudo institucional'};
 assert.equal(assertChannelPublicationAllowed('instagram',organic,env).allowed,true);
 for(const channel of ['whatsapp','email','affiliate','nuvemshop','mercado_livre'])assert.throws(()=>assertChannelPublicationAllowed(channel,organic,env),/organic_publication_not_authorized/);
});
