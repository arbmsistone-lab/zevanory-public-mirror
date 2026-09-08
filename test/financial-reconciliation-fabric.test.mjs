import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { financialReconciliationOperation, preserveCheckoutIntent, FINANCIAL_RECONCILIATION_RULES } from '../src/financialReconciliationFabric.mjs';

const root=new URL('../',import.meta.url);
const key=Buffer.alloc(32,5).toString('base64');
const journalEnv={DURABLE_JOURNAL_1_URL:'https://journal.example/append',DURABLE_JOURNAL_1_TOKEN:'x'.repeat(32),DURABLE_JOURNAL_1_KEY:key,DURABLE_JOURNAL_1_DOMAIN:'independent-journal'};
const fetchOk=async()=>new Response(JSON.stringify({preserved:true,journal_ref:'ref-1'}),{status:201,headers:{'content-type':'application/json'}});

test('financial journal record is never payment truth',()=>{
  const op=financialReconciliationOperation({provider:'asaas',eventId:'evt-1',kind:'webhook_pending',orderId:'order-1',payload:{status:'CONFIRMED'}});
  assert.equal(op.payload.financial_truth,false);assert.equal(op.payload.reconciliation_required,true);
  assert.equal(FINANCIAL_RECONCILIATION_RULES.journal_never_proves_payment,true);
  assert.equal(FINANCIAL_RECONCILIATION_RULES.journal_never_unlocks_fulfillment,true);
});

test('checkout intent can be durably preserved without calling provider',async()=>{
  const result=await preserveCheckoutIntent({provider:'mercadopago',requestId:'request-1',sessionId:'session-1',offerId:'offer-1',amountBrl:347},{env:journalEnv,fetchImpl:fetchOk});
  assert.equal(result.preserved,true);assert.equal(result.pending_storage,true);assert.equal(result.provider_called,false);assert.equal(result.financial_truth,false);
});
test('checkout handlers preserve prewrite intent and post-provider evidence',async()=>{
  const [asaas,mp]=await Promise.all([readFile(new URL('src/http/checkoutAsaas.mjs',root),'utf8'),readFile(new URL('src/http/checkoutMercadoPago.mjs',root),'utf8')]);
  for(const source of [asaas,mp]){
    assert.match(source,/preserveCheckoutIntent/);assert.match(source,/provider_called:false/);
    assert.match(source,/checkout_provider_accepted_storage_unconfirmed/);assert.match(source,/reconciliation_required:true/);
  }
});

test('financial webhooks preserve authenticated provider snapshot when canonical DB is unavailable',async()=>{
  const [asaas,mp]=await Promise.all([readFile(new URL('src/http/webhookAsaas.mjs',root),'utf8'),readFile(new URL('src/http/webhookMercadoPago.mjs',root),'utf8')]);
  for(const source of [asaas,mp]){assert.match(source,/webhook_pending_canonical_reconciliation/);assert.match(source,/financial_truth:false/);assert.match(source,/webhook_database_effect_uncertain/);}
  assert.doesNotMatch(mp,/financial_provider_not_selected/);
});

test('fulfillment journal never creates delivery authority',async()=>{
  const source=await readFile(new URL('src/cloudflareArtifactRoutes.mjs',root),'utf8');
  assert.match(source,/pending_validation/);assert.match(source,/issued:false/);assert.match(source,/download_url:null/);assert.match(source,/download_validation_unavailable/);
});
