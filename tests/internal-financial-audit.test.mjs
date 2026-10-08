import test from "node:test";
import assert from "node:assert/strict";
import {classifyPayment,classifyPaymentEvidence,safeFinancialAuditDimensions,safeDbHost,handleInternalFinancialAudit} from "../worker/internal-financial-audit.mjs";
const row={id:"12345",provider:"mercadopago",pilot:false,orphan:false,reference:"ZEVANORY:abc",order_id:"abc"};
const ok={status:200,body:{id:12345,collector_id:9876,external_reference:"ZEVANORY:abc",live_mode:true}};
test("financial classification: only owned validated payment counts as production",()=>{
 assert.equal(classifyPayment(row,ok,9876),"producao_confirmado");
 assert.equal(classifyPayment(row,{status:404,body:null},9876),"nao_existe_em_producao");
 assert.equal(classifyPayment(row,{status:403,body:null},9876),"ambiguo");
 assert.equal(classifyPayment(row,ok,1111),"ambiguo");
 assert.equal(classifyPayment({...row,pilot:true},ok,9876),"ambiguo");
 assert.equal(classifyPayment({...row,provider:"asaas"},ok,9876),"ambiguo");
 assert.equal(classifyPayment({...row,orphan:true},ok,9876),"ambiguo");
 assert.equal(classifyPayment({...row,id:"TEST123"},ok,9876),"ambiguo");
 assert.equal(classifyPayment(row,{...ok,body:{...ok.body,external_reference:"different"}},9876),"ambiguo");
 assert.equal(classifyPayment(row,{...ok,body:{...ok.body,live_mode:false}},9876),"ambiguo");
});
test("database host reports suffix only",()=>{
 assert.equal(safeDbHost("postgres://some-user:secret@ep-abc-pooler.us-east-2.aws.neon.tech/name"),"neon.tech");
 assert.equal(safeDbHost("postgres://secret:secret@somehost.render.com:5432/name"),"render.com");
 assert.equal(safeDbHost("postgres://secret:secret@myhost.local/name"),"unknown");
});
test("both audit endpoints require authentication, reject write methods",async()=>{
 for(const p of ["/api/internal/audit/financial-classification","/api/internal/audit/runtime-identity"]){
  const env={CERTIFICATION_E2E_TOKEN:"x".repeat(40),DATABASE_URL:"postgresql://sensitive:password@db.internal/secret",MERCADOPAGO_ACCESS_TOKEN:"APP_USR-SENSITIVE"};
  const r=await handleInternalFinancialAudit(new Request("https://zevanory.api.br"+p),env);
  assert.equal(r.status,401);
  const text=await r.text();
  assert.equal(text.includes("sensitive"),false);
  assert.equal(text.includes("password"),false);
  assert.equal(text.includes("APP_USR"),false);
  const wr=await handleInternalFinancialAudit(new Request("https://zevanory.api.br"+p,{method:"POST"}),env);
  assert.equal(wr.status,405);
 }
});
test("unrelated routes are not intercepted",async()=>{
 assert.equal(await handleInternalFinancialAudit(new Request("https://zevanory.api.br/api/health"),{}),null);
});

test("certification is separated only after production account returns 404",()=>{
 const pilot={...row,pilot:true};
 assert.deepEqual(classifyPaymentEvidence(pilot,{status:404,body:null},9876),
  {classification:"teste_certificacao",reason:"pilot_id_absent_from_production_account"});
 assert.equal(classifyPayment(pilot,ok,9876),"ambiguo");
 assert.equal(classifyPaymentEvidence(pilot,ok,9876).reason,"pilot_payment_visible_in_production_account");
 assert.equal(classifyPaymentEvidence(pilot,{status:403,body:null},9876).classification,"ambiguo");
});
test("unknown or malformed events cannot silently be treated as non-production",()=>{
 assert.equal(classifyPaymentEvidence({...row,pilot:null},{status:404,body:null},9876).classification,"ambiguo");
 assert.equal(classifyPaymentEvidence({...row,id:"",pilot:true},{status:404,body:null},9876).classification,"ambiguo");
 assert.equal(classifyPaymentEvidence({...row,orphan:true,pilot:true},{status:404,body:null},9876).classification,"ambiguo");
 assert.equal(classifyPaymentEvidence({...row,provider:"some-other-provider"},{status:404,body:null},9876).classification,"ambiguo");
 assert.equal(classifyPaymentEvidence(row,{status:503,body:null},9876).classification,"ambiguo");
 assert.equal(classifyPaymentEvidence(row,{...ok,body:{...ok.body,collector_id:123}},9876).reason,"merchant_account_mismatch");
});

test("audit breakdown reports fixed enums only, never provider event ID or customer reference",()=>{
 const raw={provider:"mercadopago",normalized_event:"payment_confirmed",pilot:true,id:"",provider_event_id:"mp-test:SECRET_PRIVATE_ID",reference:"private@example.com"};
 const x=safeFinancialAuditDimensions(raw);
 assert.deepEqual(x,{provider:"mercadopago",event:"payment_confirmed",pilot:"pilot_true",id_format:"missing",marker_hint:"mp_test_prefix"});
 assert.equal(JSON.stringify(x).includes("PRIVATE"),false);
 assert.equal(JSON.stringify(x).includes("@"),false);
});
test("unknown non-Mercado Pago ID format cannot claim commercial proof",()=>{
 const x=safeFinancialAuditDimensions({provider:"stripe",normalized_event:"refund_confirmed",pilot:false,id:"pi_sandbox_mock",provider_event_id:"fixture:123"});
 assert.deepEqual(x,{provider:"stripe",event:"refund_confirmed",pilot:"pilot_false",id_format:"other_format",marker_hint:"fixture_or_seed_prefix"});
 assert.equal(classifyPaymentEvidence({id:"pi_sandbox_mock",provider:"stripe",pilot:false,orphan:false},{status:0,body:null},123).classification,"ambiguo");
});
