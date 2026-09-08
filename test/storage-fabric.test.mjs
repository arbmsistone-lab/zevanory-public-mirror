import test from 'node:test';
import assert from 'node:assert/strict';
import { executeStorageMutation, storageOperation, STORAGE_FABRIC_RULES } from '../src/storageFabric.mjs';

const key=Buffer.alloc(32,11).toString('base64');
const envWithJournal={
  DURABLE_JOURNAL_1_URL:'https://journal.example/append',
  DURABLE_JOURNAL_1_TOKEN:'journal-token-12345678901234567890',
  DURABLE_JOURNAL_1_KEY:key,
  DURABLE_JOURNAL_1_DOMAIN:'journal.example',
};
const okJournal=async()=>({ok:true,status:201,json:async()=>({preserved:true,journal_ref:'j-1'})});

test('pre-write database outage preserves replayable operation',async()=>{
  let mutateCalled=false;
  const op=storageOperation({operationId:'evt-1',operationType:'telemetry.public_event',payload:{x:1}});
  const result=await executeStorageMutation({operation:op,env:envWithJournal,fetchImpl:okJournal,mutate:async()=>{mutateCalled=true;}});
  assert.equal(result.ok,false);assert.equal(result.preserved,true);assert.equal(result.replayable,true);
  assert.equal(result.reconciliation_required,false);assert.equal(mutateCalled,false);
});
test('post-attempt failure is never marked replayable',async()=>{
  const op=storageOperation({operationId:'evt-2',operationType:'operator.event',payload:{x:2}});
  const env={...envWithJournal,DATABASE_URL:'postgres://configured'};
  const result=await executeStorageMutation({operation:op,env,fetchImpl:okJournal,mutate:async()=>{throw new Error('socket_lost_after_write');}});
  assert.equal(result.ok,false);assert.equal(result.preserved,true);assert.equal(result.replayable,false);
  assert.equal(result.reconciliation_required,true);assert.equal(result.reason,'database_effect_uncertain');
});

test('successful mutation does not journal or request reconciliation',async()=>{
  let fetchCalls=0;const env={...envWithJournal,DATABASE_URL:'postgres://configured'};
  const op=storageOperation({operationId:'evt-3',operationType:'operator.event',payload:{x:3}});
  const result=await executeStorageMutation({operation:op,env,fetchImpl:async()=>{fetchCalls+=1;return okJournal();},mutate:async()=>({inserted:true})});
  assert.equal(result.ok,true);assert.equal(result.result.inserted,true);assert.equal(fetchCalls,0);
});

test('storage rules forbid blind database failover',()=>{
  assert.equal(STORAGE_FABRIC_RULES.no_blind_database_failover,true);
  assert.equal(STORAGE_FABRIC_RULES.postattempt_failure_requires_reconciliation,true);
  assert.equal(STORAGE_FABRIC_RULES.idempotency_required,true);
});
