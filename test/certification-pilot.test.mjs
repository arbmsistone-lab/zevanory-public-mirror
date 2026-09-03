import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  certificationPilotPolicy,
  createCertificationPilotInvite,
  authorizeCertificationPilotCheckout,
  recordCertificationPilotCheckoutEvidence,
  hashCertificationPilotToken,
} from '../src/certificationPilot.mjs';

const readyEnv={
  CERTIFICATION_PILOT_ENABLED:'true',CERTIFICATION_PILOT_MAX_ORDERS:'10',
  CHECKOUT_ENABLED:'true',FINANCIAL_EVENTS_ENABLED:'true',SALE_GLOBALLY_ENABLED:'false',
  ACTIVE_OFFER_TYPE:'digital_product',OFFER_SELECTION_APPROVED:'true',SERVICE_DELIVERY_MODE:'digital',
  SUPPLIER_LEGAL_NAME:'Empresa Real',SUPPLIER_TAX_ID:'12345678000199',SUPPLIER_ADDRESS:'Endereco Real',
  SUPPORT_CHANNEL:'support@example.com',PAYMENT_PROVIDER:'asaas',PAYMENT_MERCHANT_IDENTITY_VERIFIED:'true',
  ASAAS_ENV:'production',ASAAS_API_KEY:'secret',ASAAS_WEBHOOK_TOKEN:'secret',
  ARBM_SIST_CODE_SIGNING_READY:'true',ARBM_SIST_PUBLIC_RELEASE_APPROVED:'true',
};

test('certification pilot is closed by default and never opens global sales',()=>{
  assert.equal(certificationPilotPolicy({}).ready,false);
  const ready=certificationPilotPolicy(readyEnv);
  assert.equal(ready.ready,true);assert.equal(ready.max_orders,10);
  assert.equal(certificationPilotPolicy({...readyEnv,SALE_GLOBALLY_ENABLED:'true'}).ready,false);
});
test('invite creation stores only token hash and returns raw token once',async()=>{
  const calls=[];
  const db={query:async(sql,args)=>{calls.push({sql,args});return [{invite_id:'11111111-1111-4111-8111-111111111111',expires_at:'2026-09-04T00:00:00Z'}];}};
  const invite=await createCertificationPilotInvite(db,{createdBy:'owner',env:readyEnv,ttlHours:24});
  assert.match(invite.token,/^[A-Za-z0-9_-]{40,}$/);
  assert.equal(invite.max_orders,1);
  assert.equal(calls.length,1);
  assert.equal(calls[0].args[1],hashCertificationPilotToken(invite.token));
  assert.notEqual(calls[0].args[1],invite.token);
});

test('pilot checkout is invite-bound, capacity-limited and production-gated',async()=>{
  const sid='22222222-2222-4222-8222-222222222222';
  const rid='33333333-3333-4333-8333-333333333333';
  let n=0;
  const db={query:async()=>{n++;if(n===1)return [];if(n===2)return [{count:0}];return [{invite_id:'11111111-1111-4111-8111-111111111111'}];}};
  const auth=await authorizeCertificationPilotCheckout(db,{token:'x'.repeat(48),sessionId:sid,requestId:rid,env:readyEnv});
  assert.equal(auth.authorized,true);assert.equal(auth.replay,false);
  const blocked=await authorizeCertificationPilotCheckout({query:async(sql)=>sql.includes('count(*)')?[{count:10}]:[]},{token:'x'.repeat(48),sessionId:sid,requestId:rid,env:readyEnv});
  assert.equal(blocked.authorized,false);assert.equal(blocked.reason,'pilot_capacity_reached');
});
test('checkout and operator surfaces wire the pilot without a public bypass',()=>{
  const asaas=fs.readFileSync('src/http/checkoutAsaas.mjs','utf8');
  const mp=fs.readFileSync('src/http/checkoutMercadoPago.mjs','utf8');
  const operator=fs.readFileSync('api/events-operator.mjs','utf8');
  const migration=fs.readFileSync('db/migrations/016_certification_pilot.sql','utf8');
  for(const source of [asaas,mp]){
    assert.match(source,/x-certification-pilot-token/);
    assert.match(source,/authorizeCertificationPilotCheckout/);
    assert.match(source,/certification_pilot_invite_id/);
  }
  assert.match(operator,/certification_pilot_invite_create/);
  assert.match(operator,/CERTIFICATION_PILOT_APPROVER/);
  assert.match(operator,/commercial_unlock:false/);
  assert.match(migration,/token_sha256/);
  assert.match(migration,/certification_pilot boolean NOT NULL DEFAULT false/);
});

test('successful pilot checkout records only verified canonical checkout evidence',async()=>{
  const order='44444444-4444-4444-8444-444444444444';
  const session='55555555-5555-4555-8555-555555555555';
  const calls=[];
  const db={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.includes('select o.order_id from orders o')) return [{order_id:order}];
    if(sql.includes('insert into lifecycle_evidence_events')) return [{evidence_id:'e',dimension:'checkout',source_class:'canonical_database',verification_status:'verified',evidence_sha256:'a'.repeat(64)}];
    return [];
  }};
  const result=await recordCertificationPilotCheckoutEvidence(db,{orderId:order,sessionId:session,provider:'asaas'});
  assert.equal(result.recorded,true);
  assert.ok(calls.some(x=>x.sql.includes("o.status='checkout_ready'")));
  assert.ok(calls.some(x=>x.sql.includes("'certification_pilot','checkout_started'")));
  assert.ok(calls.some(x=>x.sql.includes('insert into lifecycle_evidence_events')));
});
