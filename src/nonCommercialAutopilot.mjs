import { createHash, randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { collectMarketSignals, aggregateMarketSignals } from './marketResearchFabric.mjs';
import { selectCreativeVariantWithVisualEvidence } from './creativeIntelligence.mjs';
import { creativeAssetUrl } from './creativeEngine.mjs';

export const AUTOPILOT_POLICY=Object.freeze({version:'noncommercial-autopilot-v3-elite',commercial_unlock:false,paid_media:false,sales:false,checkout:false,financial:false,min_creative_quality:0.96,min_creative_perceptual:0.93,min_verified_sources:5,min_independent_organizations:4,max_revision_rounds:3,watchdog_minutes:95});
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
async function traceAutopilot(sql,{traceId,cycleId,stage,started,details={}}){
  try{await sql.query(`insert into agent_runs(run_id,job_id,provider,model,mode,outcome,input_hash,tool_calls,latency_ms,decision,trace_id,span_id) values($1,null,'noncommercial-autopilot-trace',$2,'deterministic','completed',$3,0,$4,$5::jsonb,$6,$7)`,[randomUUID(),AUTOPILOT_POLICY.version,hash(`${cycleId}:${stage}`),Math.max(0,Date.now()-started),JSON.stringify({action:'autopilot_trace',cycle_id:cycleId,stage,...details,commercial_unlock:false,sales:false}),traceId,randomUUID()]);}catch{}
}
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
  const started=Date.now(),cycleId=autopilotCycleId(scheduledTime),traceId=randomUUID(),sql=connect(env.DATABASE_URL);
  await traceAutopilot(sql,{traceId,cycleId,stage:'cycle_started',started,details:{scheduled_time:new Date(scheduledTime).toISOString()}});
  const duplicate=await sql.query(`select 1 from agent_runs where provider='noncommercial-autopilot' and decision->>'cycle_id'=$1 limit 1`,[cycleId]);
  if(duplicate.length)return Object.freeze({ok:true,processed:false,reason:'cycle_already_completed',cycle_id:cycleId,commercial_unlock:false});
  const subject=await selectAutopilotSubject(sql,scheduledTime);
  await traceAutopilot(sql,{traceId,cycleId,stage:'subject_selected',started,details:{subject}});
  const first=await collectSignals(subject,{sql,env});
  let collected=first,aggregate=aggregateMarketSignals(subject,collected);
  await traceAutopilot(sql,{traceId,cycleId,stage:'market_collected',started,details:{verified_sources:Number(aggregate?.decision?.readiness?.verified_sources||0),independent_organizations:Number(aggregate?.decision?.readiness?.independent_organizations||0)}});
  if(Number(aggregate?.decision?.readiness?.verified_sources||0)<5){
    const retry=await collectSignals(subject,{sql,env});
    collected=mergeProviderResults(first,retry);aggregate=aggregateMarketSignals(subject,collected);
  }
  const candidate=buildProgramCandidate(subject,aggregate,cycleId);
  await traceAutopilot(sql,{traceId,cycleId,stage:'program_candidate_created',started,details:{candidate_id:candidate.candidate_id,market_decision:candidate.market_decision,market_score:candidate.market_score}});
  const evidenceReady=candidate.verified_sources>=AUTOPILOT_POLICY.min_verified_sources&&candidate.independent_organizations>=AUTOPILOT_POLICY.min_independent_organizations;
  const channelCreatives=[];
  for(const channel of CREATIVE_CHANNELS){
    let accepted=null,last=null;
    for(let round=1;round<=AUTOPILOT_POLICY.max_revision_rounds;round++){
      const brief={offerId:'OFFER-0001',channel,hook:round===1?candidate.name:`${candidate.name} · prova ${round}`,body:round===1?`Pesquisa e automação com evidência para ${subject}.`:`${subject}: evidência, clareza e aplicação prática sem promessa inflada.`,cta:'Conheça a ZEVANORY',objective:'awareness',campaignId:`${cycleId}-${channel}-r${round}`};
      const selection=await selectCreative(sql,brief),winner=selection?.winner||{},spec=winner.spec||{};
      const elite=evidenceReady&&Number(winner.quality_score||0)>=AUTOPILOT_POLICY.min_creative_quality&&Number(winner.perceptual_score||0)>=AUTOPILOT_POLICY.min_creative_perceptual&&winner.review_board?.unanimous===true;
      last={channel,round,selection,winner,spec,elite};if(elite){accepted=last;break;}
    }
    const item=accepted||last||{channel,round:0,selection:{},winner:{},spec:{},elite:false};
    channelCreatives.push(Object.freeze({channel,revision_round:item.round,creative_id:item.spec.creative_id||null,variant_id:item.spec.variant_id||null,campaign_id:item.spec.campaign_id||`${cycleId}-${channel}`,quality_score:Number(item.winner.quality_score||0),perceptual_score:Number(item.winner.perceptual_score||0),review_board:item.winner.review_board||item.selection?.review_board||null,selection_basis:item.selection?.selection_basis||null,asset_url:item.elite&&item.spec.creative_id?creativeAssetUrl(item.spec,['youtube','tiktok'].includes(channel)?'webm':'png',env):null,elite_accepted:item.elite,revision_required:!item.elite,central_ready:item.elite,commercial_unlock:false}));
  }
  const accepted=channelCreatives.filter(x=>x.elite_accepted),elite=accepted.length===CREATIVE_CHANNELS.length,best=[...accepted].sort((a,b)=>b.quality_score-a.quality_score||b.perceptual_score-a.perceptual_score)[0]||channelCreatives[0]||{};
  await traceAutopilot(sql,{traceId,cycleId,stage:'creatives_evaluated',started,details:{channels:CREATIVE_CHANNELS,candidate_count:channelCreatives.length,accepted_channels:accepted.length,rejected_channels:channelCreatives.length-accepted.length,best_channel:best.channel||null,quality_score:best.quality_score||0,perceptual_score:best.perceptual_score||0,elite_accepted:elite}});
  const creative=Object.freeze({channel:best.channel||null,creative_id:best.creative_id||null,variant_id:best.variant_id||null,campaign_id:best.campaign_id||cycleId,quality_score:best.quality_score||0,perceptual_score:best.perceptual_score||0,asset_url:best.asset_url||null,image_url:best.asset_url||null,review_board:best.review_board||null,selection_basis:best.selection_basis||null,publishable:false,elite_accepted:elite,revision_required:!elite,central_ready:elite,accepted_channels:accepted.length,total_channels:CREATIVE_CHANNELS.length,channel_creatives:Object.freeze(channelCreatives),commercial_unlock:false});
  await persistAutopilotCycle(sql,{cycleId,subject,aggregate,candidate,creative,started});
  await traceAutopilot(sql,{traceId,cycleId,stage:'cycle_completed',started,details:{candidate_id:candidate.candidate_id,creative_id:creative.creative_id,elite_accepted:creative.elite_accepted}});
  return Object.freeze({ok:true,processed:true,cycle_id:cycleId,trace_id:traceId,subject,candidate,creative,commercial_unlock:false,sales:false,checkout:false,financial:false});
}
