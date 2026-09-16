import test from 'node:test';
import assert from 'node:assert/strict';
import { probeMercadoPagoCredential } from '../src/financialAccountReadModel.mjs';

test('mercadopago probe is false without token',async()=>{
  const out=await probeMercadoPagoCredential({env:{},fetchImpl:async()=>{throw new Error('must_not_call')}});
  assert.deepEqual(out,{provider:'mercadopago',configured:false,authenticated:false,status:null});
});

test('mercadopago probe authenticates without exposing identity',async()=>{
  const out=await probeMercadoPagoCredential({env:{MERCADOPAGO_ACCESS_TOKEN:'secret'},fetchImpl:async()=>new Response('{"id":123}',{status:200})});
  assert.deepEqual(out,{provider:'mercadopago',configured:true,authenticated:true,status:200});
  assert.equal('id' in out,false);
});

test('mercadopago probe reports rejected credential safely',async()=>{
  const out=await probeMercadoPagoCredential({env:{MERCADOPAGO_ACCESS_TOKEN:'secret'},fetchImpl:async()=>new Response('{}',{status:401})});
  assert.deepEqual(out,{provider:'mercadopago',configured:true,authenticated:false,status:401});
});