import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPOSABLE_ARCHITECTURE, validateArchitectureContract } from '../src/composableArchitecture.mjs';
import { buildOutboxEvent, nextRetryDelayMs } from '../src/integrationOutbox.mjs';

test('composable architecture contract is acyclic and complete',()=>{
  assert.equal(validateArchitectureContract().valid,true);
  assert.equal(COMPOSABLE_ARCHITECTURE.integrationPattern,'transactional-outbox');
  assert.equal(COMPOSABLE_ARCHITECTURE.migrationPattern,'strangler');
});

test('architecture keeps distributed microservices and paid infrastructure optional',()=>{
  assert.equal(COMPOSABLE_ARCHITECTURE.distributedMicroservicesRequired,false);
  assert.equal(COMPOSABLE_ARCHITECTURE.paidInfrastructureRequired,false);
});

test('outbox event requires deterministic integration boundaries',()=>{
  assert.throws(()=>buildOutboxEvent({}),/outbox_event_invalid/);
  const event=buildOutboxEvent({aggregateType:'lead',aggregateId:'abc',eventType:'lead.updated',destination:'crm',payload:{x:1}});
  assert.equal(event.aggregate_type,'lead');
  assert.equal(event.destination,'crm');
  assert.ok(event.idempotency_key.length>=32);
});

test('outbox retry is bounded exponential backoff',()=>{
  assert.equal(nextRetryDelayMs(1),1000);
  assert.equal(nextRetryDelayMs(2),2000);
  assert.equal(nextRetryDelayMs(20),3600000);
});
