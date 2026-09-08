import { defineExecutionProvider, executeUniversallySafely, evaluateEvidenceQuorum } from './universalExecutionFabric.mjs';

const clean=(v,max=1000)=>String(v??'').trim().slice(0,max);
const SHA=/^[0-9a-f]{40}$/i;

export function defineDeploymentProvider({id,deploy,verify,ready=()=>true,independenceDomain=null,cost=0}={}){
  if(typeof deploy!=='function'||typeof verify!=='function')throw new Error('deployment_provider_invalid');
  return defineExecutionProvider({id,capabilities:['deploy:preview','deploy:verify'],cost,independenceDomain,
    health:async()=>Boolean(await ready())?{state:'available'}:{state:'unavailable'},
    execute:async(operation)=>{
      const sha=clean(operation?.sha,40).toLowerCase();if(!SHA.test(sha))throw new Error('deployment_sha_invalid');
      const deployment=await deploy(operation);
      const proof=await verify({operation,deployment});
      if(proof?.status!=='pass'||clean(proof?.artifact_sha,40).toLowerCase()!==sha)throw new Error('deployment_proof_invalid');
      return Object.freeze({deployment,proof:Object.freeze({...proof,artifact_sha:sha,operation_sha:sha})});
    },
  });
}

export async function deployWithFabric({sha,providers=[],metadata={}}={}){
  if(!SHA.test(clean(sha,40)))throw new Error('deployment_sha_invalid');
  return executeUniversallySafely({operation:Object.freeze({sha:clean(sha,40).toLowerCase(),metadata}),providers,requirements:{capabilities:['deploy:preview','deploy:verify'],zeroCost:true}});
}
export function certifyDeploymentEvidence(results=[],{required=2}={}){
  const evidence=[];
  for(const item of results){
    const proof=item?.proof||item?.result?.proof;
    if(!proof)continue;
    evidence.push({status:proof.status,artifact_sha:proof.artifact_sha,operation_sha:proof.operation_sha,provider:item.provider||proof.provider,independence_domain:item.independence_domain||proof.independence_domain});
  }
  return evaluateEvidenceQuorum(evidence,{required});
}

export async function collectDeploymentProofs({sha,providers=[],metadata={}}={}){
  const proofs=[];const failures=[];
  for(const provider of providers){
    try{
      const result=await provider.execute(Object.freeze({sha:clean(sha,40).toLowerCase(),metadata}));
      proofs.push(Object.freeze({provider:provider.id,independence_domain:provider.independence_domain,...result}));
    }catch(error){failures.push(Object.freeze({provider:provider.id,independence_domain:provider.independence_domain,reason:clean(error?.message||'deployment_failed',240)}));}
  }
  return Object.freeze({proofs:Object.freeze(proofs),failures:Object.freeze(failures)});
}
