import { createHash, randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { collectMarketSignals, aggregateMarketSignals } from './marketResearchFabric.mjs';
import { selectCreativeVariantWithVisualEvidence } from './creativeIntelligence.mjs';
import { creativeAssetUrl } from './creativeEngine.mjs';

export const AUTOPILOT_POLICY=Object.freeze({version:'noncommercial-autopilot-v1',commercial_unlock:false,paid_media:false,sales:false,checkout:false,financial:false});
export const AUTOPILOT_SUBJECTS=Object.freeze([
  'IA aplicada a pequenos negócios',
  'automação de atendimento omnichannel',
  'vendas conversacionais com IA',
  'gestão de caixa e margem para pequenos negócios',
  'conteúdo orgânico com IA para empresas locais',
  'automação operacional sem dependência de provedor',
  'produtividade com agentes de IA para Windows',
  'inteligência de mercado para pequenos negócios',
]);
const hash=(v)=>createHash('sha256').update(String(v)).digest('hex');
const hourSlot=(ms)=>Math.floor(Number(ms||Date.now())/3600000);
export const autopilotCycleId=(scheduledTime=Date.now())=>`autopilot-${hourSlot(scheduledTime)}`;
const titleCase=(v)=>String(v||'').replace(/(^|\s)\S/g,x=>x.toUpperCase());
export function buildProgramCandidate(subject,aggregate,cycleId){
  const decision=aggregate?.decision||{};
  const score=Number(decision?.opportunity?.score);
  const suffix=hash(subject).slice(0,6).toUpperCase();
  return Object.freeze({
    candidate_id:`ZEV-PROG-${suffix}`,
    name:`Programa ZEVANORY · ${titleCase(subject)}`,
    type:'internal_program_candidate',status:'research_draft',subject,
    market_decision:String(decision.decision||'EVIDENCIA_INSUFICIENTE'),
    market_score:Number.isFinite(score)?Number(score.toFixed(4)):null,
    verified_sources:Number(decision?.readiness?.verified_sources||0),
    independent_organizations:Number(decision?.readiness?.independent_organizations||0),
    cycle_id:cycleId,commercial_unlock:false,publishable:false,sellable:false,
  });
}

async function persistMarketSnapshot(sql,{cycleId,subject,aggregate}){
  await sql.query(`insert into intelligence_snapshots(snapshot_id,snapshot_type,subject_ref,payload,evidence_count,organization_count,decision,score,observed_at)
    values($1,'market_research',$2,$3::jsonb,$4,$5,$6,$7,now())`,[
    randomUUID(),subject,JSON.stringify({...aggregate,cycle_id:cycleId,autopilot:true,commercial_unlock:false}),
    Number(aggregate?.decision?.readiness?.verified_sources||0),Number(aggregate?.decision?.readiness?.independent_organizations||0),
    aggregate?.decision?.decision||null,aggregate?.decision?.opportunity?.score??null,
  ]);
}
async function persistProgramDraft(sql,candidate,aggregate){
  const content=[
    `# ${candidate.name}`,
    `Status: ${candidate.status}`,
    `Tema pesquisado: ${candidate.subject}`,
    `Decisão de mercado: ${candidate.market_decision}`,
    `Score observado: ${candidate.market_score??'sem score completo'}`,
    `Fontes verificadas: ${candidate.verified_sources}`,
    `Organizações independentes: ${candidate.independent_organizations}`,
    `Ciclo: ${candidate.cycle_id}`,
    'Regra: rascunho interno; não vende, não publica e não libera checkout.',
    `Evidência agregada: ${JSON.stringify(aggregate?.decision||{})}`,
  ].join('\n');
  await sql.query(`insert into knowledge_documents(document_id,namespace,title,content,source_ref,trust_level,active)
    values($1,'program_drafts',$2,$3,$4,'internal',true)
    on conflict(namespace,title) do update set content=excluded.content,source_ref=excluded.source_ref,updated_at=now(),active=true`,
    [randomUUID(),candidate.name,content,`autopilot:${candidate.cycle_id}`]);
}

async function persistCandidateSnapshot(sql,{candidate,creative}){
  const payload={kind:'program_candidate',candidate,creative,policy:AUTOPILOT_POLICY,autopilot:true,commercial_unlock:false};
  await sql.query(`insert into intelligence_snapshots(snapshot_id,snapshot_type,subject_ref,payload,evidence_count,organization_count,decision,score,observed_at)
    values($1,'investment_decision',$2,$3::jsonb,$4,$5,$6,$7,now())`,[
    randomUUID(),candidate.candidate_id,JSON.stringify(payload),candidate.verified_sources,candidate.independent_organizations,
    candidate.market_decision,candidate.market_score,
  ]);
}

async function persistAutopilotRun(sql,{cycleId,subject,candidate,creative,started}){
  await sql.query(`insert into agent_runs(run_id,job_id,provider,model,mode,outcome,input_hash,tool_calls,latency_ms,decision)
    values($1,null,'noncommercial-autopilot',$2,'deterministic','completed',$3,3,$4,$5::jsonb)`,[
    randomUUID(),AUTOPILOT_POLICY.version,hash(cycleId),Math.max(0,Date.now()-started),
    JSON.stringify({action:'noncommercial_autopilot_cycle',cycle_id:cycleId,subject,candidate_id:candidate.candidate_id,creative_id:creative.creative_id,market_decision:candidate.market_decision,commercial_unlock:false,sales:false,checkout:false,financial:false}),
  ]);
}
export async function runNonCommercialAutopilot({env=process.env,scheduledTime=Date.now(),connect=neon,collectSignals=collectMarketSignals,selectCreative=selectCreativeVariantWithVisualEvidence}={}){
  if(!env.DATABASE_URL)return Object.freeze({ok:false,reason:'database_unavailable',commercial_unlock:false});
  const started=Date.now(),cycleId=autopilotCycleId(scheduledTime),sql=connect(env.DATABASE_URL);
  const duplicate=await sql.query(`select 1 from agent_runs where provider='noncommercial-autopilot' and decision->>'cycle_id'=$1 limit 1`,[cycleId]);
  if(duplicate.length)return Object.freeze({ok:true,processed:false,reason:'cycle_already_completed',cycle_id:cycleId,commercial_unlock:false});
  const subject=AUTOPILOT_SUBJECTS[hourSlot(scheduledTime)%AUTOPILOT_SUBJECTS.length];
  const collected=await collectSignals(subject,{sql,env});
  const aggregate=aggregateMarketSignals(subject,collected);
  const candidate=buildProgramCandidate(subject,aggregate,cycleId);
  await persistMarketSnapshot(sql,{cycleId,subject,aggregate});
  await persistProgramDraft(sql,candidate,aggregate);
  const selection=await selectCreative(sql,{offerId:'OFFER-0001',channel:'instagram',hook:candidate.name,body:`Pesquisa e automação com evidência para ${subject}.`,cta:'Conheça a ZEVANORY',objective:'awareness',campaignId:cycleId});
  const winner=selection?.winner||{};const spec=winner.spec||{};
  const creative=Object.freeze({creative_id:spec.creative_id||null,variant_id:spec.variant_id||null,campaign_id:spec.campaign_id||cycleId,quality_score:Number(winner.quality_score||0),perceptual_score:Number(winner.perceptual_score||0),review_board:winner.review_board||selection?.review_board||null,selection_basis:selection?.selection_basis||null,image_url:spec.creative_id?creativeAssetUrl(spec,'png',env):null,publishable:false,commercial_unlock:false});
  await persistCandidateSnapshot(sql,{candidate,creative});
  await persistAutopilotRun(sql,{cycleId,subject,candidate,creative,started});
  return Object.freeze({ok:true,processed:true,cycle_id:cycleId,subject,candidate,creative,commercial_unlock:false,sales:false,checkout:false,financial:false});
}
