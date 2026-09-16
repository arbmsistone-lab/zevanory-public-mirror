import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCreativeVariants, buildChannelPlacementSet, creativeQualityScore, selectCreativeVariant, selectCreativeVariantWithVisualEvidence, loadCreativeOutcomeEvidence, CREATIVE_INTELLIGENCE_POLICY, deterministicPerceptualScore, evaluateCreativeApprovalBoard } from '../src/creativeIntelligence.mjs';
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
  assert.equal(selected.selection_basis,'structural_quality_no_observed_winner');
  assert.equal(selected.performance_claim_allowed,false);
});

test('mature observed evidence outranks unobserved quality-only variants',()=>{
  const selected=selectCreativeVariant(input,[{variant_id:'v2',sessions:60,paid:8}]);
  assert.equal(selected.winner.variant_id,'v2');
  assert.equal(selected.selection_basis,'observed_economics_plus_structural_quality');
  assert.equal(selected.performance_claim_allowed,true);
});

test('creative outcome evidence reads attribution from canonical telemetry',async()=>{
  let query=''; const sql={query:async(q,args)=>{query=q;assert.equal(args[0],'campaign-x');return [{variant_id:'v1',sessions:31,paid:3}];}};
  const rows=await loadCreativeOutcomeEvidence(sql,'campaign-x');
  assert.equal(rows[0].variant_id,'v1'); assert.match(query,/payload->>'variant_id'/); assert.match(query,/payment_confirmed/); assert.match(query,/refunded_total/); assert.match(query,/net_revenue_brl/);
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

test('perceptual visual evidence can change the selected creative',async()=>{
  const selected=await selectCreativeVariantWithVisualEvidence(null,input,CREATIVE_INTELLIGENCE_POLICY,{visualEvaluator:async(spec)=>({perceptual_score:spec.layout==='proof'?.96:spec.layout==='contrast'?.80:.74,min_frame_score:.74,frames:[]})});
  assert.equal(selected.winner.spec.layout,'proof');
  assert.equal(selected.selection_basis,'perceptual_quality_no_observed_winner');
  assert.ok(selected.winner.perceptual_score>=.9);
});

test('economic ranking penalizes refunds and rewards net revenue per session',()=>{
  const observed=[
    {variant_id:'v1',sessions:60,paid:10,gross_revenue_brl:1000,refunded_brl:900,net_revenue_brl:100},
    {variant_id:'v2',sessions:60,paid:8,gross_revenue_brl:900,refunded_brl:0,net_revenue_brl:900},
  ];
  const selected=selectCreativeVariant(input,observed);
  assert.equal(selected.winner.variant_id,'v2');
  assert.ok(selected.winner.net_revenue_brl>selected.ranking.find(x=>x.variant_id==='v1').net_revenue_brl);
});

test('channel placement set exposes multiple certified formats without changing default',()=>{
  const ig=buildChannelPlacementSet({...input,channel:'instagram'}),yt=buildChannelPlacementSet({...input,channel:'youtube'});
  assert.ok(ig.some(x=>x.placement==='story'&&x.width===1080&&x.height===1920));
  assert.ok(ig.some(x=>x.placement==='feed_portrait'&&x.height===1350));
  assert.ok(yt.some(x=>x.placement==='thumbnail'&&x.width===1280&&x.height===720));
});

test('deterministic perceptual scorer is stable and does not saturate all variants',()=>{
  const variants=buildCreativeVariants(input);
  const a=variants.map(x=>deterministicPerceptualScore(x.spec).perceptual_score);
  const b=variants.map(x=>deterministicPerceptualScore(x.spec).perceptual_score);
  assert.deepEqual(a,b);assert.equal(new Set(a).size,3);assert.ok(a.every(x=>x>=CREATIVE_INTELLIGENCE_POLICY.min_perceptual_score&&x<1));
});


test('senior board requires unanimous 5 of 5 for technical release',async()=>{
  const selected=await selectCreativeVariantWithVisualEvidence(null,input);
  assert.equal(selected.review_board.required,5);assert.equal(selected.review_board.approved_count,5);assert.equal(selected.review_board.unanimous,true);assert.equal(selected.technical_release_ready,true);
});

test('senior board blocks technical release on any single rejection',()=>{
  const spec=createCreativeSpec({...input,cta:'chamado para acao excessivamente longo que viola clareza de conversao'});
  const board=evaluateCreativeApprovalBoard({spec,structural_score:1,quality_score:1,perceptual_score:1,visual_min_frame_score:1});
  assert.equal(board.required,5);assert.equal(board.approved_count,4);assert.equal(board.unanimous,false);assert.equal(board.status,'revision_required');
});
