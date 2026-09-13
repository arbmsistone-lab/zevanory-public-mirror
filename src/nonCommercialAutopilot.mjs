import { createHash, randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { collectMarketSignals, aggregateMarketSignals } from './marketResearchFabric.mjs';
import { selectCreativeVariantWithVisualEvidence } from './creativeIntelligence.mjs';
import { creativeAssetUrl } from './creativeEngine.mjs';

export const AUTOPILOT_POLICY=Object.freeze({version:'noncommercial-autopilot-v2',commercial_unlock:false,paid_media:false,sales:false,checkout:false,financial:false,min_creative_quality:0.90,min_creative_perceptual:0.85,watchdog_minutes:95});
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
const CREATIVE_CHANNELS=Object.freeze(['instagram','youtube','tiktok','facebook','linkedin']);
const cleanTopic=(v)=>String(v||'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,140);
async function selectAutopilotSubject(sql,scheduledTime){
  const fallback=AUTOPILOT_SUBJECTS[hourSlot(scheduledTime)%AUTOPILOT_SUBJECTS.length];
  try{const rows=await sql.query(`select payload from intelligence_snapshots where snapshot_type='market_research' order by created_at desc limit 12`);for(const row of rows){for(const provider of row?.payload?.providers||[]){const topic=cleanTopic(provider?.sample?.top_title||provider?.sample?.title);if(topic.length>=12&&!AUTOPILOT_SUBJECTS.some(x=>x.toLowerCase()===topic.toLowerCase()))return topic;}}}catch{}
  return fallback;
}
const mergeProviderResults=(first=[],second=[])=>{const map=new Map();for(const row of [...first,...second]){const key=String(row?.organization||'').toLowerCase();if(!key)continue;const prev=map.get(key);if(!prev||(!prev.ok&&row?.ok))map.set(key,row);}return [...map.values()];};
export const autopilotHealthy=(lastCycleAt,now=Date.now())=>Boolean(lastCycleAt)&&now-new Date(lastCycleAt).getTime()<=AUTOPILOT_POLICY.watchdog_minutes*60000;
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
async function persistAutopilotCycle(sql,{cycleId,subject,aggregate,candidate,creative,started}){
  const marketPayload=JSON.stringify({...aggregate,cycle_id:cycleId,autopilot:true,commercial_unlock:false});
  const programContent=[`# ${candidate.name}`,`Status: ${candidate.status}`,`Tema pesquisado: ${candidate.subject}`,`Decisão de mercado: ${candidate.market_decision}`,`Score observado: ${candidate.market_score??'sem score completo'}`,`Fontes verificadas: ${candidate.verified_sources}`,`Organizações independentes: ${candidate.independent_organizations}`,`Ciclo: ${candidate.cycle_id}`,'Regra: rascunho interno; não vende, não publica e não libera checkout.',`Evidência agregada: ${JSON.stringify(aggregate?.decision||{})}`].join('\n');
  const candidatePayload=JSON.stringify({kind:'program_candidate',candidate,creative,policy:AUTOPILOT_POLICY,autopilot:true,commercial_unlock:false});
  const runDecision=JSON.stringify({action:'noncommercial_autopilot_cycle',cycle_id:cycleId,subject,candidate_id:candidate.candidate_id,creative_id:creative.creative_id,market_decision:candidate.market_decision,commercial_unlock:false,sales:false,checkout:false,financial:false});
  await sql.query(`with market as (insert into intelligence_snapshots(snapshot_id,snapshot_type,subject_ref,payload,evidence_count,organization_count,decision,score,observed_at) values($1,'market_research',$2,$3::jsonb,$4,$5,$6,$7,now()) returning 1), program as (insert into knowledge_documents(document_id,namespace,title,content,source_ref,trust_level,active) values($8,'program_drafts',$9,$10,$11,'internal',true) on conflict(namespace,title) do update set content=excluded.content,source_ref=excluded.source_ref,updated_at=now(),active=true returning 1), candidate as (insert into intelligence_snapshots(snapshot_id,snapshot_type,subject_ref,payload,evidence_count,organization_count,decision,score,observed_at) values($12,'investment_decision',$13,$14::jsonb,$15,$16,$17,$18,now()) returning 1) insert into agent_runs(run_id,job_id,provider,model,mode,outcome,input_hash,tool_calls,latency_ms,decision) select $19,null,'noncommercial-autopilot',$20,'deterministic','completed',$21,3,$22,$23::jsonb from market,program,candidate`,[randomUUID(),subject,marketPayload,candidate.verified_sources,candidate.independent_organizations,candidate.market_decision,candidate.market_score,randomUUID(),candidate.name,programContent,`autopilot:${cycleId}`,randomUUID(),candidate.candidate_id,candidatePayload,candidate.verified_sources,candidate.independent_organizations,candidate.market_decision,candidate.market_score,randomUUID(),AUTOPILOT_POLICY.version,hash(cycleId),Math.max(0,Date.now()-started),runDecision]);
}

export async function runNonCommercialAutopilot({env=process.env,scheduledTime=Date.now(),connect=neon,collectSignals=collectMarketSignals,selectCreative=selectCreativeVariantWithVisualEvidence}={}){
  if(!env.DATABASE_URL)return Object.freeze({ok:false,reason:'database_unavailable',commercial_unlock:false});
  const started=Date.now(),cycleId=autopilotCycleId(scheduledTime),sql=connect(env.DATABASE_URL);
  const duplicate=await sql.query(`select 1 from agent_runs where provider='noncommercial-autopilot' and decision->>'cycle_id'=$1 limit 1`,[cycleId]);
  if(duplicate.length)return Object.freeze({ok:true,processed:false,reason:'cycle_already_completed',cycle_id:cycleId,commercial_unlock:false});
  const subject=await selectAutopilotSubject(sql,scheduledTime);
  const first=await collectSignals(subject,{sql,env});
  let collected=first,aggregate=aggregateMarketSignals(subject,collected);
  if(Number(aggregate?.decision?.readiness?.verified_sources||0)<5){
    const retry=await collectSignals(subject,{sql,env});
    collected=mergeProviderResults(first,retry);aggregate=aggregateMarketSignals(subject,collected);
  }
  const candidate=buildProgramCandidate(subject,aggregate,cycleId);
  const selections=await Promise.all(CREATIVE_CHANNELS.map(channel=>selectCreative(sql,{offerId:'OFFER-0001',channel,hook:candidate.name,body:`Pesquisa e automação com evidência para ${subject}.`,cta:'Conheça a ZEVANORY',objective:'awareness',campaignId:`${cycleId}-${channel}`})));
  const candidates=selections.map((selection,index)=>({channel:CREATIVE_CHANNELS[index],selection,winner:selection?.winner||{}})).sort((a,b)=>Number(b.winner?.quality_score||0)-Number(a.winner?.quality_score||0)||Number(b.winner?.perceptual_score||0)-Number(a.winner?.perceptual_score||0));
  const best=candidates[0]||{},winner=best.winner||{},selection=best.selection||{},spec=winner.spec||{};
  const elite=Number(winner.quality_score||0)>=AUTOPILOT_POLICY.min_creative_quality&&Number(winner.perceptual_score||0)>=AUTOPILOT_POLICY.min_creative_perceptual&&winner.review_board?.unanimous===true;
  const creative=Object.freeze({channel:best.channel||null,creative_id:spec.creative_id||null,variant_id:spec.variant_id||null,campaign_id:spec.campaign_id||cycleId,quality_score:Number(winner.quality_score||0),perceptual_score:Number(winner.perceptual_score||0),review_board:winner.review_board||selection?.review_board||null,selection_basis:selection?.selection_basis||null,image_url:elite&&spec.creative_id?creativeAssetUrl(spec,['youtube','tiktok'].includes(best.channel)?'webm':'png',env):null,publishable:false,elite_accepted:elite,revision_required:!elite,channel_candidates:candidates.map(x=>({channel:x.channel,quality_score:Number(x.winner?.quality_score||0),perceptual_score:Number(x.winner?.perceptual_score||0),unanimous:x.winner?.review_board?.unanimous===true})),commercial_unlock:false});
  await persistAutopilotCycle(sql,{cycleId,subject,aggregate,candidate,creative,started});
  return Object.freeze({ok:true,processed:true,cycle_id:cycleId,subject,candidate,creative,commercial_unlock:false,sales:false,checkout:false,financial:false});
}
