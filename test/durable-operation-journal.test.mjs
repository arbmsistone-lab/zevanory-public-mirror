import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  buildJournalEntry, sealJournalEntry, openJournalEntry,
  defineJournalProvider, appendJournalQuorum,
  handleCloudflareJournalAppend,
} from '../src/durableOperationJournal.mjs';

const key=randomBytes(32).toString('base64');

test('journal envelope encrypts payload and verifies integrity',()=>{
  const entry=buildJournalEntry({operationId:'op-1',operationType:'lead_event',payload:{email:'x@example.test',value:42}});
  const sealed=sealJournalEntry(entry,key);
  assert.equal(JSON.stringify(sealed).includes('x@example.test'),false);
  const opened=openJournalEntry(sealed,key);
  assert.deepEqual(opened.payload,entry.payload);
  assert.equal(opened.payload_sha256,entry.payload_sha256);
});

test('tampered journal payload is rejected',()=>{
  const entry=buildJournalEntry({operationId:'op-2',operationType:'checkout_intent',payload:{amount:10}});
  const sealed=sealJournalEntry(entry,key);
  const broken={...sealed,ciphertext_b64:Buffer.from('tampered').toString('base64')};
  assert.throws(()=>openJournalEntry(broken,key));
});
test('journal quorum counts only independent domains',async()=>{
  const entry=buildJournalEntry({operationId:'op-3',operationType:'event',payload:{ok:true}});
  const make=(id,domain)=>defineJournalProvider({id,independenceDomain:domain,append:async()=>({preserved:true})});
  const oneDomain=await appendJournalQuorum(entry,[make('a','same'),make('b','same')],{requiredCopies:2});
  assert.equal(oneDomain.preserved,false);assert.equal(oneDomain.independent_domains,1);
  const twoDomains=await appendJournalQuorum(entry,[make('a','one'),make('b','two')],{requiredCopies:2});
  assert.equal(twoDomains.preserved,true);assert.equal(twoDomains.independent_domains,2);
});

test('cloudflare journal route is authenticated and idempotent by operation id',async()=>{
  const token='journal-secret-token-1234567890';
  const writes=[];const env={DURABLE_JOURNAL_TOKEN:token,ZEVANORY_PRIVATE_ARTIFACTS:{put:async(k,v)=>writes.push({k,v})}};
  const entry=buildJournalEntry({operationId:'op-4',operationType:'event',payload:{safe:true}});
  const envelope=sealJournalEntry(entry,key);
  const request=new Request('https://example.test/private/journal/append',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(envelope)});
  const response=await handleCloudflareJournalAppend(request,env);
  assert.equal(response.status,201);assert.equal(writes[0].k,'opjournal:op-4');
  const denied=await handleCloudflareJournalAppend(new Request('https://example.test/private/journal/append',{method:'POST',body:'{}'}),env);
  assert.equal(denied.status,401);
});
