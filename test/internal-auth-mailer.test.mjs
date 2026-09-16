import test from 'node:test';
import assert from 'node:assert/strict';
import {handleInternalAuthMailer} from '../src/internalAuthMailer.mjs';

test('mailer interno rejeita acesso por hostname publico',async()=>{
  const r=await handleInternalAuthMailer(new Request('https://zevanory.api.br/internal/auth/password-reset',{method:'POST'}),{RESEND_API_KEY:'x'});
  assert.equal(r.status,404);
});

test('mailer interno valida produto e origem do reset',async()=>{
  const req=new Request('https://zevanory.internal/internal/auth/password-reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({product:'outro',email:'a@b.com',resetUrl:'https://evil.invalid/?reset_token='+'a'.repeat(64)})});
  const r=await handleInternalAuthMailer(req,{RESEND_API_KEY:'x'});
  assert.equal(r.status,400);
});

test('mailer interno usa Resend sem expor segredo',async()=>{
  const original=globalThis.fetch;let auth='';
  globalThis.fetch=async(_url,init)=>{auth=init.headers.authorization;return new Response(JSON.stringify({id:'mail_1'}),{status:200,headers:{'content-type':'application/json'}})};
  try{const req=new Request('https://zevanory.internal/internal/auth/password-reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({product:'arbm-contador-saloes',email:'cliente@example.com',resetUrl:'https://arbm-mei-api.zevanory.workers.dev/?reset_token='+'a'.repeat(64)})});const r=await handleInternalAuthMailer(req,{RESEND_API_KEY:'secret'});assert.equal(r.status,202);assert.equal(auth,'Bearer secret');}finally{globalThis.fetch=original;}
});