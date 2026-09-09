import test from 'node:test';
import assert from 'node:assert/strict';
import { publishViaBuffer } from '../src/bufferSocial.mjs';
import { buildOutboundAdapters } from '../src/outboundAdapters.mjs';

const gate=()=>({enabled:true});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('Buffer appends creative landing URL exactly once',async()=>{
  let sent; const url='https://zevanory.api.br/?zc=c1&zv=v1&zi=i1';
  await publishViaBuffer({channel:'linkedin',event:{payload:{content:'ZEVANORY update',landing_url:url}},env:{BUFFER_API_KEY:'k',BUFFER_LINKEDIN_CHANNEL_ID:'li'},fetchImpl:async(u,o)=>{sent=JSON.parse(o.body);return response({data:{createPost:{post:{id:'1',status:'scheduled'}}}});}});
  const text=sent.variables.input.text; assert.match(text,/zevanory\.api\.br/); assert.equal(text.split(url).length-1,1);
});

test('Facebook receives tracked landing URL in post body',async()=>{
  let sent; const url='https://zevanory.api.br/?zc=c1&zv=v1&zi=i1';
  const env={META_ACCESS_TOKEN:'t',META_PAGE_ID:'p',META_GRAPH_VERSION:'v26.0'};
  const adapters=buildOutboundAdapters({env,commercialGate:gate,fetchImpl:async(u,o)=>{sent=JSON.parse(o.body);return response({id:'post-1'});}});
  const out=await adapters['channel:facebook']({payload:{content:'Conteudo',landing_url:url}});
  assert.equal(out.provider,'meta_facebook'); assert.match(sent.message,/zc=c1/);
});
test('Instagram caption carries attribution without duplicating URL',async()=>{
  const calls=[],url='https://zevanory.api.br/?zc=c2&zv=v3&zi=i9';
  const env={META_ACCESS_TOKEN:'t',INSTAGRAM_BUSINESS_ACCOUNT_ID:'ig',META_GRAPH_VERSION:'v26.0'};
  const adapters=buildOutboundAdapters({env,commercialGate:gate,fetchImpl:async(u,o)=>{calls.push({u,body:JSON.parse(o.body)});return u.endsWith('/media_publish')?response({id:'published'}):response({id:'container'});}});
  const out=await adapters['channel:instagram']({payload:{content:'Legenda',media_url:'https://zevanory.api.br/media.png',landing_url:url}});
  assert.equal(out.provider,'meta_instagram');
  assert.match(calls[0].body.caption,/zc=c2/); assert.equal(calls[0].body.caption.split(url).length-1,1);
});
