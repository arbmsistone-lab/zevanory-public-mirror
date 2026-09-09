import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCreativeVariants, creativeQualityScore, selectCreativeVariant, loadCreativeOutcomeEvidence, CREATIVE_INTELLIGENCE_POLICY } from '../src/creativeIntelligence.mjs';
import { createCreativeSpec } from '../src/creativeEngine.mjs';
import { creativeHtml } from '../src/creativeRenderer.mjs';
import { normalizePublicEvent } from '../src/publicEvent.mjs';

const input={offerId:'OFFER-0001',channel:'instagram',hook:'Automacao com controle',body:'IA, execucao segura e evidencia real para operacoes digitais.',cta:'Conheca a ZEVANORY',objective:'awareness'};

test('creative intelligence creates three distinct channel-aware variants',()=>{
  const variants=buildCreativeVariants(input);
  assert.equal(variants.length,3);
  assert.equal(new Set(variants.map(x=>x.spec.creative_id)).size,3);
  assert.deepEqual(variants.map(x=>x.spec.layout),['editorial','contrast','proof']);
  assert.ok(variants.every(x=>x.quality_score>=CREATIVE_INTELLIGENCE_POLICY.min_quality_score));
});

test('quality score rejects weak incomplete creative',()=>{
  const strong=createCreativeSpec(input);
  const weak={...strong,hook:'x',body:'x',cta:'muito longo para um chamado de acao adequado e claro',brand:'OTHER'};
  assert.ok(creativeQualityScore(strong)>creativeQualityScore(weak));
});
test('selection never claims observed winner without mature evidence',()=>{
  const selected=selectCreativeVariant(input,[]);
  assert.equal(selected.selection_basis,'quality_only_no_observed_winner');
  assert.equal(selected.performance_claim_allowed,false);
});

test('mature observed evidence outranks unobserved quality-only variants',()=>{
  const selected=selectCreativeVariant(input,[{variant_id:'v2',sessions:60,paid:8}]);
  assert.equal(selected.winner.variant_id,'v2');
  assert.equal(selected.selection_basis,'observed_outcomes_plus_quality');
  assert.equal(selected.performance_claim_allowed,true);
});

test('creative outcome evidence reads attribution from canonical telemetry',async()=>{
  let query=''; const sql={query:async(q,args)=>{query=q;assert.equal(args[0],'campaign-x');return [{variant_id:'v1',sessions:31,paid:3}];}};
  const rows=await loadCreativeOutcomeEvidence(sql,'campaign-x');
  assert.equal(rows[0].variant_id,'v1'); assert.match(query,/payload->>'variant_id'/); assert.match(query,/payment_confirmed/);
});

test('renderer html contains timed scenes and canonical brand',()=>{
  const spec=buildCreativeVariants({...input,channel:'tiktok'})[0].spec,html=creativeHtml(spec);
  assert.match(html,/sceneAt/); assert.match(html,/__drawAt/); assert.match(html,/ZEVANORY/);
});
test('public attribution is bounded and non-sensitive',()=>{
  const event=normalizePublicEvent({event_id:'550e8400-e29b-41d4-a716-446655440001',session_id:'550e8400-e29b-41d4-a716-446655440000',name:'page_view',channel:'central',campaign_id:'camp-1',variant_id:'v2',creative_id:'abc123'});
  assert.deepEqual(event.payload,{campaign_id:'camp-1',variant_id:'v2',creative_id:'abc123'});
});
test('bounded exploration is deterministic per operation',async()=>{
  const mod=await import('../src/creativeIntelligence.mjs');
  const selection=selectCreativeVariant(input,[]);
  const a=mod.chooseCreativeForOperation(selection,'operation-123'),b=mod.chooseCreativeForOperation(selection,'operation-123');
  assert.equal(a.selected.variant_id,b.selected.variant_id); assert.equal(a.exploration_rate,CREATIVE_INTELLIGENCE_POLICY.cold_start_exploration_rate);
});
