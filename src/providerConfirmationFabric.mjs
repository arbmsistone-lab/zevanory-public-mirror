import { preserveStorageOperation, storageOperation } from './storageFabric.mjs';

const clean=(v,max=300)=>String(v??'').trim().slice(0,max);

export function providerConfirmationOperation(confirmation={}){
  const eventId=clean(confirmation.provider_event_id,300);
  const provider=clean(confirmation.provider,80);
  if(!eventId||!provider)throw new Error('provider_confirmation_operation_invalid');
  return storageOperation({operationId:`provider-confirmation:${provider}:${eventId}`,operationType:'provider.confirmation_reconciliation',subjectRef:clean(confirmation.provider_message_id,300)||null,payload:{confirmation,confirmed_in_canonical_store:false,reconciliation_required:true}});
}

export async function preserveProviderConfirmations(confirmations=[],options={}){
  const proofs=[];let preservedCount=0;
  for(const confirmation of confirmations){
    const operation=providerConfirmationOperation(confirmation);
    const result=await preserveStorageOperation(operation,options);
    proofs.push({operation_id:operation.operation_id,preserved:result.preserved});
    if(result.preserved)preservedCount+=1;
  }
  return Object.freeze({preserved:confirmations.length>0&&preservedCount===confirmations.length,preserved_count:preservedCount,total:confirmations.length,proofs:Object.freeze(proofs),reconciliation_required:true});
}

export const PROVIDER_CONFIRMATION_RULES=Object.freeze({atomic_canonical_update:true,journal_never_marks_confirmed:true,replay_requires_idempotent_event_id:true});
