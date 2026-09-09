const STATES = Object.freeze(['available','degraded','quota_limited','unavailable','recovering']);
const safeNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const uniq = (values=[]) => Object.freeze([...new Set(values.map(v=>String(v).trim()).filter(Boolean))].sort());

export function defineExecutionProvider({id, capabilities=[], execute, health=()=>({state:'available'}), cost=0, independenceDomain=null, priority=0}={}){
  if(!id || typeof execute!=='function') throw new Error('execution_provider_invalid');
  return Object.freeze({
    id:String(id), capabilities:uniq(capabilities), execute, health,
    cost:Math.max(0,safeNumber(cost,0)), independence_domain:String(independenceDomain||id),
    priority:safeNumber(priority,0),
  });
}

export function providerSatisfies(provider, requirements={}){
  const required=uniq(requirements.capabilities||[]);
  if(required.some(cap=>!provider.capabilities.includes(cap))) return false;
  if(requirements.zeroCost===true && provider.cost>0) return false;
  return true;
}

export function scoreExecutionProvider(provider, health={}){
  const state=STATES.includes(health.state)?health.state:'unavailable';
  const stateScore={available:100,recovering:70,degraded:50,quota_limited:20,unavailable:-1000}[state];
  const quota=Math.max(0,Math.min(100,safeNumber(health.quotaRemainingPct,100)));
  const latencyPenalty=Math.min(30,safeNumber(health.latencyMs,0)/1000);
  const failurePenalty=Math.min(80,safeNumber(health.failureRate,0)*100);
  return stateScore + quota/10 + provider.priority - latencyPenalty - failurePenalty;
}
export async function rankExecutionProviders(providers=[], requirements={}, circuitState={}){
  const ranked=[];
  for(const provider of providers){
    if(!providerSatisfies(provider,requirements)) continue;
    const circuit=circuitState[provider.id]||{};
    if(circuit.openUntil && Number(circuit.openUntil)>Date.now()) continue;
    let health;
    try{ health=await provider.health(); }catch{ health={state:'unavailable',reason:'health_probe_failed'}; }
    const score=scoreExecutionProvider(provider,health);
    if(score<=-900) continue;
    ranked.push(Object.freeze({provider,health:Object.freeze({...health}),score}));
  }
  ranked.sort((a,b)=>b.score-a.score || a.provider.id.localeCompare(b.provider.id));
  return Object.freeze(ranked);
}

export async function executeUniversally({operation,providers=[],requirements={},circuitState={},maxAttempts}={}){
  const ranked=await rankExecutionProviders(providers,requirements,circuitState);
  const limit=Math.max(1,Math.min(ranked.length,Number(maxAttempts)||ranked.length||1));
  const attempts=[];
  for(const candidate of ranked.slice(0,limit)){
    const {provider}=candidate;
    try{
      const result=await provider.execute(operation);
      attempts.push(Object.freeze({provider:provider.id,independence_domain:provider.independence_domain,status:'executed'}));
      return Object.freeze({ok:true,provider:provider.id,independence_domain:provider.independence_domain,result,attempts:Object.freeze(attempts)});
    }catch(error){
      attempts.push(Object.freeze({provider:provider.id,independence_domain:provider.independence_domain,status:'failed',reason:String(error?.message||'provider_failed').slice(0,240)}));
    }
  }
  return Object.freeze({ok:false,preserved:true,reason:ranked.length?'all_qualified_providers_failed':'no_qualified_provider_available',attempts:Object.freeze(attempts)});
}
export function evaluateEvidenceQuorum(evidence=[], policy={}){
  const required=Math.max(1,Number(policy.required)||2);
  const accepted=evidence.filter(item=>item?.status==='pass' && item?.artifact_sha && item?.operation_sha);
  const domains=new Set(accepted.map(item=>String(item.independence_domain||item.provider||'')).filter(Boolean));
  const operationShas=new Set(accepted.map(item=>String(item.operation_sha)));
  const artifactShas=new Set(accepted.map(item=>String(item.artifact_sha)));
  const pass=accepted.length>=required && domains.size>=required && operationShas.size===1 && artifactShas.size===1;
  return Object.freeze({pass,required,accepted:accepted.length,independent_domains:domains.size,reason:pass?'quorum_satisfied':'quorum_not_satisfied'});
}

export function nextCircuitState(previous={}, {success=false, now=Date.now(), threshold=3, coolDownMs=60000}={}){
  if(success) return Object.freeze({failures:0,openUntil:0,state:'available'});
  const failures=Math.max(0,Number(previous.failures)||0)+1;
  const open=failures>=Math.max(1,Number(threshold)||3);
  return Object.freeze({failures,openUntil:open?now+Math.max(1000,Number(coolDownMs)||60000):0,state:open?'unavailable':'degraded'});
}

export const UNIVERSAL_EXECUTION_RULES=Object.freeze({
  provider_named_gate_forbidden:true,
  provider_named_core_dependency_forbidden:true,
  preserve_operation_when_dependency_unavailable:true,
  reroute_before_retry:true,
  zero_cost_required:true,
  evidence_quorum_by_independence_domain:true,
  heavy_local_execution_forbidden:true,
});
export async function executeUniversallySafely({operation,providers=[],requirements={},circuitState={},maxAttempts}={}){
  const ranked=await rankExecutionProviders(providers,requirements,circuitState);
  const limit=Math.max(1,Math.min(ranked.length,Number(maxAttempts)||ranked.length||1));
  const attempts=[];
  for(const candidate of ranked.slice(0,limit)){
    const {provider}=candidate;
    try{
      const result=await provider.execute(operation);
      attempts.push(Object.freeze({provider:provider.id,independence_domain:provider.independence_domain,status:'executed'}));
      return Object.freeze({ok:true,provider:provider.id,independence_domain:provider.independence_domain,result,attempts:Object.freeze(attempts)});
    }catch(error){
      const ambiguous=Boolean(error?.ambiguous);
      const retryable=Boolean(error?.retryable);
      attempts.push(Object.freeze({provider:provider.id,independence_domain:provider.independence_domain,status:ambiguous&&!retryable?'reconciliation_required':'failed',retryable,reason:String(error?.message||'provider_failed').slice(0,240)}));
      if(ambiguous){
        if(retryable)return Object.freeze({ok:false,preserved:true,reconciliation_required:false,retryable:true,retry_provider:provider.id,reason:String(error?.message||'provider_retryable').slice(0,240),attempts:Object.freeze(attempts)});
        return Object.freeze({ok:false,preserved:true,reconciliation_required:true,retryable:false,reason:'provider_effect_uncertain',attempts:Object.freeze(attempts)});
      }
    }
  }
  return Object.freeze({ok:false,preserved:true,reconciliation_required:false,reason:ranked.length?'all_qualified_providers_failed':'no_qualified_provider_available',attempts:Object.freeze(attempts)});
}
