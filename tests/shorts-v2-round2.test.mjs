import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {readTextNormalized} from './helpers/text.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {comparisons,compareVoices,phrase} from '../scripts/shorts-v2/compare-voices.mjs';
import {planSlot} from '../scripts/channels/youtube-daily-short.mjs';
import * as core from '../scripts/shorts-v2/core.mjs';
import * as history from '../scripts/shorts-v2/script-history.mjs';
import {tts,ttsRequest} from '../scripts/shorts-v2/render.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const coreSource=new URL('../scripts/shorts-v2/core.mjs',import.meta.url),historySource=new URL('../scripts/shorts-v2/script-history.mjs',import.meta.url);
const manifest=JSON.parse(readTextNormalized(new URL('../data/musica-licencas.json',import.meta.url)));
const plan=(day='2026-11-11')=>planSlot(day,'oferta',{hotmartOpen:true});
async function licensed(m){for(const field of ['pagina_licenca','evidencia_licenca','sha256_original']){const broken=structuredClone(manifest);delete broken.faixas[0][field];await assert.rejects(()=>m.licensedTrack({theme:'ia',manifest:broken,root:new URL('../',import.meta.url)}),/music_license_invalid/);}}
test('NC01: track evidence and original download hash are mandatory',()=>licensed(core));
test('NC01 mutant: accept missing license evidence',()=>killedMutation(coreSource,[["!/(CC0|Creative Commons 0|public.domain|domínio público)/i.test(row.evidencia_licenca||'')||",'']],licensed));
async function calendar(m){const previous=[];for(let i=0;i<30;i++){const day=new Date(Date.parse('2026-11-11')+i*86400000).toISOString().slice(0,10);for(const slot of ['dica','oferta']){const p=m.planV2(planSlot(day,slot,{hotmartOpen:true})),f=history.fingerprint(p);assert.doesNotThrow(()=>history.assertNovel(f,previous));previous.push(f);}}assert.equal(new Set(previous.map(r=>r.sha256)).size,60);}
test('NC02: 30 real calendar days are distinct and below 40 percent overlap',()=>calendar(core));
test('NC02 mutant: fixed theme script',()=>killedMutation(coreSource,[["const episode=episodeScript(plan),lines=",`const episode=episodeScript({...plan,slot:'oferta',entry:{...plan.entry,niche:'salão',angle:'dor',short_variant:0,product:{sku:'ZEV-IA-011'}},screen:{hook:'fixo',tip:'Escolha uma tarefa pequena e revise cada resultado.'}}),lines=`]],calendar));
async function repeated(m){const first=history.fingerprint(core.planV2(plan()));const duplicate={...first,day:'2026-11-12'};assert.throws(()=>m.assertNovel(duplicate,[first]),/script_repeated_60d/);const similar={...duplicate,sha256:'0'.repeat(64)};assert.throws(()=>m.assertNovel(similar,[first]),/script_similar_30d/);}
test('NC02: duplicate episode and more than 40 percent shared sentences rejected',()=>repeated(history));
test('NC02 mutant: repetition guard disabled',()=>killedMutation(historySource,[['for(const prior of history){','for(const prior of []){']],repeated));
test('NC02: corrupt projection needs readable receipt; preview never erases history',async()=>{const p=core.planV2(plan()),data=new Map(),kv={get:async k=>data.get(k)??null,put:async(k,v)=>data.set(k,v)};await history.scriptHistory(kv,p,{reserve:true});const key='zpc:shorts:v2:roteiro:'+p.day+':'+p.slot;data.set(key,'{');await history.scriptHistory(kv,p);assert.equal(data.get(key),'{');data.delete(key.replace('roteiro:','roteiro:receipt:'));await assert.rejects(()=>history.scriptHistory(kv,p),/script_history_unknown/);});
const config={voz_fixa:'Achird',modelo:'gemini-3.8-flash-tts',comparacao_aprovada:true,nivel_gratuito_confirmado:true,publicacao_aprovada:true};
async function wrongModel(m){assert.throws(()=>m.assertVoice(config,'Achird',{model:'gemini-2.5-flash-preview-tts'}),/brand_model_changed/);}
test('NC05: model must match approved model',()=>wrongModel(core));
test('NC05 mutant: a different model accepted',()=>killedMutation(coreSource,[["model!==config.modelo",'false']],wrongModel));
test('NC05: 3.8 Interactions and 2.5 generateContent use distinct protocols without fallback',async()=>{for(const model of ['gemini-3.8-flash-tts','gemini-2.5-flash-preview-tts']){let count=0;const modern=model.includes('3.8');const out=await tts('frase única','Kore','synthetic',{model,freeTierConfirmed:true,fetchImpl:async(url,opts)=>{count++;const body=JSON.parse(opts.body);assert.equal(url.includes('/interactions'),modern);if(modern){assert.equal(body.model,model);assert.equal(body.generation_config.speech_config[0].voice,'Kore');}else assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,'Kore');const data=Buffer.alloc(100).toString('base64');return {ok:true,json:async()=>modern?{steps:[{type:'model_output',content:[{type:'audio',data,mime_type:'audio/l16',sample_rate:24000}]}]}:{candidates:[{content:{parts:[{inlineData:{data,mimeType:'audio/L16;rate=24000'}}]}}]}};}});assert.equal(count,1);assert.equal(out.model,model);}let calls=0;await assert.rejects(()=>tts('t','Achird','synthetic',{model:config.modelo,freeTierConfirmed:true,fetchImpl:async()=>{calls++;return {ok:false};}}));assert.equal(calls,1);assert.throws(()=>ttsRequest('t','Achird','unknown'));});
test('NC05: comparison is exactly 4 voices times 2 models; owner approved 3.8/Achird and free tier, publication still pending',async()=>{const c=JSON.parse(readTextNormalized(new URL('../data/shorts-padrao-v2.json',import.meta.url)));assert.equal(c.candidatas.length*c.modelos_comparacao.length,8);assert.equal(c.modelo,'gemini-3.8-flash-tts');assert.equal(c.voz_fixa,'Achird');assert.equal(c.comparacao_aprovada,true);assert.equal(c.nivel_gratuito_confirmado,true);assert.equal(c.publicacao_aprovada,false,'publicação só após o proprietário aprovar a prévia');});
async function classification(m){for(const id of ['dica:rotina-diaria-farmacia','farmácia','diária'])assert.equal(m.themeFor({entry:{theme_id:id}}),'dicas');assert.equal(m.themeFor({entry:{theme_id:'ia:vendas'}}),'dicas');assert.equal(m.themeFor({entry:{theme_id:'farmacia',product:{sku:'ZEV-LCX-011'}}}),'financas');}
test('NC06: exact SKU and word boundaries; ambiguous classifications use dicas',()=>classification(core));
test('NC06 mutant: IA substring inside farmacia accepted',()=>killedMutation(coreSource,[[String.raw`/\b(ia|inteligencia|tecnologia)\b/`,String.raw`/(ia|inteligencia|tecnologia)/`]],classification));

test('NC05: comparison writer processes all eight identities with exactly the same phrase',async()=>{const c=JSON.parse(readTextNormalized(new URL('../data/shorts-padrao-v2.json',import.meta.url))),dir=await mkdtemp(join(tmpdir(),'zev-comparison-'));let calls=[];try{const report=await compareVoices({...c,nivel_gratuito_confirmado:true},dir,{key:'synthetic',synthesize:async(text,voice,key,{model})=>{assert.equal(text,phrase);calls.push({voice,model});return {pcm:Buffer.alloc(100),voice,model};},run:()=>{},measure:()=>({lufs:-16,peak:-1.5})});assert.equal(report.candidates.length,8);assert.equal(new Set(report.candidates.map(r=>r.file)).size,8);assert.deepEqual(calls,comparisons(c).map(({voice,model})=>({voice,model})));assert.equal(report.selected,null);assert.equal(report.status,'owner_listening_required');}finally{await rm(dir,{recursive:true,force:true});}});
test('v3: estilo (parâmetro style) vai para os dois protocolos; sem estilo, o v2 continua com o STYLE original',async()=>{const {ESTILO_V3}=await import('../scripts/shorts-v3/render.mjs');const {STYLE}=await import('../scripts/shorts-v2/core.mjs');
 assert.equal(ESTILO_V3,STYLE,'estilo original (o calmo piorou o alinhamento)');const {VOZ_ATEMPO}=await import('../scripts/shorts-v3/render.mjs');assert.ok(VOZ_ATEMPO>=0.9&&VOZ_ATEMPO<1);
 const m=ttsRequest('t','Achird','gemini-3.8-flash-tts',ESTILO_V3),l=ttsRequest('t','Achird','gemini-2.5-flash-preview-tts',ESTILO_V3);
 assert.equal(m.body.input[0].content[0].annotations[0].style,ESTILO_V3);assert.ok(l.body.contents[0].parts[0].text.startsWith(ESTILO_V3));
 assert.equal(ttsRequest('t','Achird','gemini-3.8-flash-tts').body.input[0].content[0].annotations[0].style,STYLE);
 let enviado;await tts('t','Achird','k',{model:'gemini-3.8-flash-tts',freeTierConfirmed:true,style:ESTILO_V3,fetchImpl:async(u,o)=>{enviado=JSON.parse(o.body);return {ok:true,json:async()=>({steps:[{type:'model_output',content:[{type:'audio',data:Buffer.alloc(4800).toString('base64'),mime_type:'audio/l16',sample_rate:24000}]}]})};}});
 assert.equal(enviado.input[0].content[0].annotations[0].style,ESTILO_V3);});
// Ensaio 44111864755 (17/11): TTS sem resposta em 60 s -> erro único 'free_tts_network_failed' (sem separar timeout de
// rede). Agora: prazo 120 s, UMA nova tentativa só para timeout/rede/5xx (nunca 4xx/429), e o erro final diz o tipo.
test('TTS: timeout ou 5xx tenta de novo UMA vez; 429/4xx não repete; erro final diz o tipo (timeout, rede:<código>, HTTP)',async()=>{
 const R=await import('../scripts/shorts-v2/render.mjs');
 assert.equal(R.TTS_TIMEOUT_MS,120000);assert.equal(R.TTS_TENTATIVAS,2);assert.ok(R.TTS_TIMEOUT_MS*R.TTS_TENTATIVAS+R.TTS_ESPERA_MS<5*60000,'cabe no job de voz de 5 min');
 const ok={ok:true,status:200,json:async()=>({steps:[{type:'model_output',content:[{type:'audio',data:Buffer.alloc(4800).toString('base64'),mime_type:'audio/l16;rate=24000',sample_rate:24000}]}]})};
 const timeout=()=>{const e=new Error('t');e.name='TimeoutError';throw e;};
 const rede=()=>{throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});};
 const roda=async seq=>{let n=0;const esperas=[],notas=[];let erro=null,out=null;
  try{out=await tts('frase','Achird','k',{model:'gemini-3.8-flash-tts',freeTierConfirmed:true,esperar:async ms=>{esperas.push(ms);},note:m=>notas.push(m),fetchImpl:async(u,o)=>{assert.ok(o.signal,'prazo por chamada');const s=seq[n++];return typeof s==='function'?s():s;}});}catch(e){erro=e.message;}
  return {n,esperas,notas,erro,out};};
 let r=await roda([timeout,ok]);assert.equal(r.erro,null);assert.equal(r.n,2);assert.deepEqual(r.esperas,[5000]);assert.match(r.notas[0],/TTS_TENTATIVA 1 falhou=free_tts_timeout/);assert.equal(r.out.pcm.length,4800);
 r=await roda([timeout,timeout]);assert.equal(r.erro,'free_tts_timeout');assert.equal(r.n,2,'no máximo 2 chamadas');
 r=await roda([rede,rede]);assert.equal(r.erro,'free_tts_network_failed:ECONNRESET');assert.equal(r.n,2);
 r=await roda([{ok:false,status:503},ok]);assert.equal(r.erro,null);assert.equal(r.n,2);
 r=await roda([{ok:false,status:503},{ok:false,status:502}]);assert.equal(r.erro,'free_tts_unavailable:502');
 r=await roda([{ok:false,status:429},ok]);assert.equal(r.erro,'free_tts_unavailable:429');assert.equal(r.n,1,'cota (429) não repete');
 r=await roda([{ok:false,status:400},ok]);assert.equal(r.erro,'free_tts_unavailable:400');assert.equal(r.n,1);
 r=await roda([ok]);assert.equal(r.erro,null);assert.equal(r.n,1);assert.deepEqual(r.esperas,[]);
});
