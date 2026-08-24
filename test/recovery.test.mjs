import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  recoveryDiagnosticReady,
  listAsaasPaymentsByExternalReference,
  summarizeUncertainRecovery,
} from '../src/recovery.mjs';

const orderId='550e8400-e29b-41d4-a716-446655440000';
const externalReference=`ZEVANORY:EXP-0001:${orderId}`;

test('recovery diagnostic is sandbox-only and fail-closed',()=>{
  assert.equal(recoveryDiagnosticReady({env:'sandbox',apiKey:'k',databaseUrl:'db'}),true);
  assert.equal(recoveryDiagnosticReady({env:'production',apiKey:'k',databaseUrl:'db'}),false);
  assert.equal(recoveryDiagnosticReady({env:'sandbox',apiKey:'',databaseUrl:'db'}),false);
});

test('recovery provider lookup is GET-only and externalReference-scoped',async()=>{
  let seen;
  const rows=await listAsaasPaymentsByExternalReference(externalReference,'key',async(url,opts)=>{
    seen={url:String(url),opts};
    return {ok:true,json:async()=>({data:[]})};
  });
  assert.deepEqual(rows,[]);
  assert.equal(seen.opts.method,'GET');
  assert.match(seen.url,/externalReference=ZEVANORY%3AEXP-0001%3A/);
});
test('recovery summary never mutates and reports provider evidence only',()=>{
  const order={order_id:orderId,external_reference:externalReference,status:'checkout_uncertain'};
  assert.deepEqual(summarizeUncertainRecovery(order,[]),{
    order_id:orderId,
    result:'provider_record_not_found',
    provider_matches:0,
    provider_statuses:[],
  });
  const found=summarizeUncertainRecovery(order,[{externalReference,status:'PENDING'}]);
  assert.equal(found.result,'provider_records_found');
  assert.equal(found.provider_matches,1);
  assert.deepEqual(found.provider_statuses,['PENDING']);
});

test('diagnostic script is read-only by construction',async()=>{
  const source=await readFile(new URL('../scripts/diagnose-uncertain-checkouts.mjs',import.meta.url),'utf8');
  assert.match(source,/WHERE status='checkout_uncertain'/);
  assert.match(source,/mode:'read-only'/);
  assert.doesNotMatch(source,/\bINSERT\b/i);
  assert.doesNotMatch(source,/\bUPDATE\b/i);
  assert.doesNotMatch(source,/\bDELETE\b/i);
});
