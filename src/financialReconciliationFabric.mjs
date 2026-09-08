import { preserveStorageOperation, storageOperation } from './storageFabric.mjs';

const clean=(v,max=1000)=>String(v??'').trim().slice(0,max);

export function financialReconciliationOperation({provider,eventId,kind,orderId=null,payload}={}){
  const p=clean(provider,80);const e=clean(eventId,200);const k=clean(kind,120);
  if(!p||!e||!k)throw new Error('financial_reconciliation_operation_invalid');
  return storageOperation({
    operationId:`financial:${p}:${k}:${e}`,
    operationType:`financial.${k}`,
    subjectRef:orderId?clean(orderId,200):null,
    payload:Object.freeze({provider:p,event_id:e,order_id:orderId?clean(orderId,200):null,payload:payload??null,financial_truth:false,reconciliation_required:true}),
  });
}

export async function preserveFinancialReconciliation(input,{env=process.env,fetchImpl=globalThis.fetch,requiredCopies=1}={}){
  const operation=financialReconciliationOperation(input);
  const journal=await preserveStorageOperation(operation,{env,fetchImpl,requiredCopies});
  return Object.freeze({preserved:journal.preserved,reconciliation_required:true,financial_truth:false,operation_id:operation.operation_id,journal});
}

export async function preserveCheckoutIntent({provider,requestId,sessionId,offerId,amountBrl},{env=process.env,fetchImpl=globalThis.fetch,requiredCopies=1}={}){
  const operation=storageOperation({operationId:`checkout-intent:${clean(requestId,200)}`,operationType:'financial.checkout_intent',subjectRef:sessionId,payload:{provider:clean(provider,80),request_id:clean(requestId,200),session_id:clean(sessionId,200),offer_id:clean(offerId,200),amount_brl:Number(amountBrl),provider_called:false,financial_truth:false}});
  const journal=await preserveStorageOperation(operation,{env,fetchImpl,requiredCopies});
  return Object.freeze({preserved:journal.preserved,pending_storage:journal.preserved,provider_called:false,financial_truth:false,operation_id:operation.operation_id,journal});
}

export const FINANCIAL_RECONCILIATION_RULES=Object.freeze({
  journal_never_proves_payment:true,
  journal_never_unlocks_fulfillment:true,
  provider_snapshot_requires_canonical_reconciliation:true,
  ambiguous_checkout_never_auto_retries_provider:true,
  financial_write_never_uses_read_replica:true,
});
