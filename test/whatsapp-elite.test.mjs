import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {extractWhatsappInboundMessages,queueWhatsappConversation} from '../src/supportIntake.mjs';
import {understandWhatsappInbound} from '../src/whatsappMedia.mjs';
import {buildOutboundAdapters} from '../src/outboundAdapters.mjs';
import {evaluateAgentDecision} from '../src/agentEvals.mjs';
import {CHANNEL_PROFILES,OFFICIAL_WHATSAPP} from '../src/channelProfiles.mjs';

test('WhatsApp inbound extracts text audio image video and document safely',()=>{
  const payload={entry:[{changes:[{value:{messages:[
    {id:'m1',from:'558899999999',type:'text',text:{body:'Quero conhecer o ARBM ONE'}},
    {id:'m2',from:'558899999999',type:'audio',audio:{id:'a1',mime_type:'audio/ogg'}},
    {id:'m3',from:'558899999999',type:'image',image:{id:'i1',mime_type:'image/jpeg',caption:'Veja este erro'}},
    {id:'m4',from:'558899999999',type:'video',video:{id:'v1',mime_type:'video/mp4',caption:'Veja o v?deo'}},
    {id:'m5',from:'558899999999',type:'document',document:{id:'d1',mime_type:'application/pdf',filename:'erro.pdf'}}
  ]}}]}]};
  const rows=extractWhatsappInboundMessages(payload);
  assert.deepEqual(rows.map(x=>x.type),['text','audio','image','video','document']);
  assert.equal(rows[2].text,'Veja este erro');assert.equal(rows[4].filename,'erro.pdf');
});

test('ordinary WhatsApp sales inbound creates lead review instead of being ignored',async()=>{
  const seen=[];const sql={query:async(q,args=[])=>{seen.push([String(q),args]);if(String(q).includes("select lead_id,session_id,stage"))return [];if(String(q).includes("insert into agent_jobs"))return [{job_id:'job-1'}];return [];}};
  const r=await queueWhatsappConversation(sql,{contactRef:'558899999999',text:'Quero conhecer os planos do ARBM ONE',messageId:'wamid.1'});
  assert.equal(r.queued,true);assert.equal(r.kind,'commercial');
  assert.ok(seen.some(([q])=>q.includes("'lead_review'")));assert.ok(seen.some(([q])=>q.includes('last_inbound_message')));
});

test('audio is transcribed through free edge AI route with 99pct understanding confidence',async()=>{
  globalThis.__ZEVANORY_EDGE_AI__={AI:{run:async(model,input)=>{assert.equal(model,'@cf/openai/whisper');assert.ok(Array.isArray(input.audio));return {text:'Quero saber o valor e como funciona o ARBM ONE'};}}};
  let n=0;const fetchImpl=async()=>{n++;if(n===1)return {ok:true,json:async()=>({url:'https://media.test/a',mime_type:'audio/ogg'})};return {ok:true,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer,headers:{get:()=> 'audio/ogg'}};};
  const r=await understandWhatsappInbound({type:'audio',media_id:'a1',text:'',caption:''},{env:{WHATSAPP_ACCESS_TOKEN:'x',META_GRAPH_VERSION:'v26.0'},fetchImpl});
  assert.equal(r.understanding_confidence,.99);assert.match(r.understanding,/ARBM ONE/);
  delete globalThis.__ZEVANORY_EDGE_AI__;
});

test('image is understood through edge toMarkdown route with 99pct confidence',async()=>{
  globalThis.__ZEVANORY_EDGE_AI__={AI:{toMarkdown:async()=>({data:'Captura mostra erro 500 no cadastro do produto.'}),run:async()=>({response:'fallback'})}};
  let n=0;const fetchImpl=async()=>{n++;if(n===1)return {ok:true,json:async()=>({url:'https://media.test/i',mime_type:'image/jpeg'})};return {ok:true,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer,headers:{get:()=> 'image/jpeg'}};};
  const r=await understandWhatsappInbound({type:'image',media_id:'i1',text:'Veja isso'},{env:{WHATSAPP_ACCESS_TOKEN:'x',META_GRAPH_VERSION:'v26.0'},fetchImpl});
  assert.equal(r.understanding_confidence,.99);assert.match(r.understanding,/erro 500/);
  delete globalThis.__ZEVANORY_EDGE_AI__;
});

test('video fails closed when visual understanding cannot be proven',async()=>{
  globalThis.__ZEVANORY_EDGE_AI__={AI:{run:async()=>{throw new Error('unsupported')}}};
  let n=0;const fetchImpl=async()=>{n++;if(n===1)return {ok:true,json:async()=>({url:'https://media.test/v',mime_type:'video/mp4'})};return {ok:true,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer,headers:{get:()=> 'video/mp4'}};};
  const r=await understandWhatsappInbound({type:'video',media_id:'v1',text:''},{env:{WHATSAPP_ACCESS_TOKEN:'x',META_GRAPH_VERSION:'v26.0'},fetchImpl});
  assert.equal(r.understanding_mode,'video_requires_visual_review');assert.equal(r.understanding_confidence,0);
  delete globalThis.__ZEVANORY_EDGE_AI__;
});

test('outbound WhatsApp sends audio video document and image with native message types',async()=>{
  for(const [media_type,url] of [['audio','https://cdn.test/a.ogg'],['video','https://cdn.test/v.mp4'],['document','https://cdn.test/d.pdf'],['image','https://cdn.test/i.jpg']]){
    let body;const fetchImpl=async(_u,o)=>{body=JSON.parse(o.body);return {ok:true,status:200,json:async()=>({messages:[{id:'wamid.out'}]})};};
    const adapters=buildOutboundAdapters({env:{META_GRAPH_VERSION:'v26.0',WHATSAPP_ACCESS_TOKEN:'t',WHATSAPP_PHONE_NUMBER_ID:'p',WHATSAPP_SALES_ENABLED:'true'},fetchImpl,commercialGate:()=>({enabled:true})});
    const r=await adapters['channel:whatsapp']({event_type:'send_message',destination:'channel:whatsapp',payload:{contact_ref:'558899999999',text:'Mensagem ZEVANORY',media_url:url,media_type}});
    assert.equal(r.accepted,true);assert.equal(body.type,media_type);
  }
});

test('customer-facing auto-send requires confidence of at least 99pct',()=>{
  const context={lead:{contact_ref:'558899999999',stage:'contacted'},job_type:'lead_review'};
  const bad=evaluateAgentDecision({decision:{action:'send_message',rationale:'responder',confidence:.98,message:'Posso te explicar como funciona.'},context,tool:'send_message',authorization:{allowed:true}});
  assert.equal(bad.pass,false);assert.ok(bad.issues.includes('customer_message_confidence_below_99pct'));
  const good=evaluateAgentDecision({decision:{action:'send_message',rationale:'responder',confidence:.99,message:'Posso te explicar como funciona.'},context,tool:'send_message',authorization:{allowed:true}});
  assert.equal(good.pass,true);
});

test('all canonical sales fronts expose official WhatsApp route',()=>{
  assert.equal(OFFICIAL_WHATSAPP.e164,'558892340423');
  for(const [channel,p] of Object.entries(CHANNEL_PROFILES)){assert.match(p.whatsappUrl,/^https:\/\/wa\.me\/558892340423/);assert.equal(p.whatsapp,'+55 88 9234-0423',channel);}
});

test('all public commercial pages load the official WhatsApp contact injector',()=>{
  const dir=new URL('../public/',import.meta.url);const skip=new Set(['zevanory-robot-control.html','financeiro.html']);
  for(const name of fs.readdirSync(dir).filter(x=>x.endsWith('.html')&&!skip.has(x))){const html=fs.readFileSync(new URL(name,dir),'utf8');assert.match(html,/\/whatsapp-contact\.js/,name);}
});
