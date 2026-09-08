import test from 'node:test';
import assert from 'node:assert/strict';
import { providerConfirmationOperation, preserveProviderConfirmations, PROVIDER_CONFIRMATION_RULES } from '../src/providerConfirmationFabric.mjs';

const journalFetch=async()=>({ok:true,json:async()=>({preserved:true,journal_ref:'j'})});
const env={DURABLE_JOURNAL_1_URL:'https://journal.example/append',DURABLE_JOURNAL_1_TOKEN:'x'.repeat(32),DURABLE_JOURNAL_1_KEY:Buffer.alloc(32,8).toString('base64'),DURABLE_JOURNAL_1_DOMAIN:'journal-a'};
const confirmation={provider:'meta_whatsapp',destination:'channel:whatsapp',provider_message_id:'wamid.1',status:'delivered',rank:20,occurred_at_ms:1,provider_event_id:'meta:wamid.1:delivered:1'};

test('provider confirmation journal never marks canonical confirmation',()=>{
  const op=providerConfirmationOperation(confirmation);
  assert.equal(op.payload.confirmed_in_canonical_store,false);
  assert.equal(op.payload.reconciliation_required,true);
  assert.match(op.operation_id,/provider-confirmation:meta_whatsapp/);
});

test('all confirmations must be preserved before acknowledgement',async()=>{
  const result=await preserveProviderConfirmations([confirmation],{env,fetchImpl:journalFetch});
  assert.equal(result.preserved,true);assert.equal(result.preserved_count,1);assert.equal(result.total,1);
});
