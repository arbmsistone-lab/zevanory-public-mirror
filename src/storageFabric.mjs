import { buildJournalEntry, appendJournalQuorum, buildHttpJournalProvider } from './durableOperationJournal.mjs';

const clean=(v,max=1000)=>String(v??'').trim().slice(0,max);

export function buildConfiguredJournalProviders(env=process.env,{fetchImpl=globalThis.fetch}={}){
  const providers=[];
  for(let slot=1;slot<=3;slot+=1){
    const prefix=`DURABLE_JOURNAL_${slot}`;
    const endpoint=clean(env[`${prefix}_URL`],2000);
    const token=clean(env[`${prefix}_TOKEN`],4000);
    const encryptionKey=clean(env[`${prefix}_KEY`],500);
    if(!endpoint&&!token&&!encryptionKey)continue;
    providers.push(buildHttpJournalProvider({
      id:clean(env[`${prefix}_ID`],120)||`journal-${slot}`,
      endpoint,token,encryptionKey,
      independenceDomain:clean(env[`${prefix}_DOMAIN`],200)||`journal-domain-${slot}`,
      fetchImpl,
    }));
  }
  return Object.freeze(providers);
}

export function storageOperation({operationId,operationType,payload,subjectRef=null}={}){
  const id=clean(operationId,200);const type=clean(operationType,120);
  if(!id||!type)throw new Error('storage_operation_invalid');
  return Object.freeze({operation_id:id,operation_type:type,subject_ref:subjectRef?clean(subjectRef,300):null,payload:payload??null});
}
export async function preserveStorageOperation(operation,{env=process.env,fetchImpl=globalThis.fetch,requiredCopies=1}={}){
  const providers=buildConfiguredJournalProviders(env,{fetchImpl});
  if(providers.length===0)return Object.freeze({preserved:false,reason:'no_journal_provider_configured',copies:0,independent_domains:0,proofs:Object.freeze([])});
  const entry=buildJournalEntry({operationId:operation.operation_id,operationType:operation.operation_type,payload:{subject_ref:operation.subject_ref,payload:operation.payload}});
  return appendJournalQuorum(entry,providers,{requiredCopies});
}

export async function executeStorageMutation({operation,mutate,env=process.env,fetchImpl=globalThis.fetch,requiredJournalCopies=1}={}){
  if(typeof mutate!=='function')throw new Error('storage_mutation_required');
  if(!env.DATABASE_URL){
    const journal=await preserveStorageOperation(operation,{env,fetchImpl,requiredCopies:requiredJournalCopies});
    return Object.freeze({ok:false,preserved:journal.preserved,replayable:journal.preserved,reconciliation_required:false,reason:journal.preserved?'database_unavailable_preserved':'database_unavailable_unpreserved',journal});
  }
  try{
    const result=await mutate();
    return Object.freeze({ok:true,preserved:false,replayable:false,reconciliation_required:false,result});
  }catch(error){
    const journal=await preserveStorageOperation(operation,{env,fetchImpl,requiredCopies:requiredJournalCopies});
    return Object.freeze({ok:false,preserved:journal.preserved,replayable:false,reconciliation_required:true,reason:'database_effect_uncertain',error:String(error?.message||'database_mutation_failed').slice(0,240),journal});
  }
}

export const STORAGE_FABRIC_RULES=Object.freeze({
  no_blind_database_failover:true,
  prewrite_unavailability_can_replay:true,
  postattempt_failure_requires_reconciliation:true,
  journal_payload_encrypted:true,
  idempotency_required:true,
});
