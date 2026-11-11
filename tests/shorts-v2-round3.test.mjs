import test from 'node:test';
import assert from 'node:assert/strict';
import {planSlot} from '../scripts/channels/youtube-daily-short.mjs';
import * as core from '../scripts/shorts-v2/core.mjs';
import {fingerprint,assertNovel} from '../scripts/shorts-v2/script-history.mjs';
export function simulate(m=core){const history=[],counts={dica:0,calc:0,oferta:0};for(let i=0;i<180;i++){const day=new Date(Date.parse('2026-11-12')+i*86400000).toISOString().slice(0,10);for(const slot of ['dica','calc','oferta']){const raw=planSlot(day,slot,{hotmartOpen:true}),p=m.planV2(raw,{hotmartOpen:true,history}),f=fingerprint(p);assertNovel(f,history);history.push(f);counts[slot]++;}}return {counts,total:history.length};}
test('NC07: 180 consecutive days, three slots, accumulated history',()=>assert.deepEqual(simulate(),{counts:{dica:180,calc:180,oferta:180},total:540}));

import {readFile} from 'node:fs/promises';
import * as scenes from '../scripts/shorts-v2/scenes.mjs';
import * as episode from '../scripts/shorts-v2/episode.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const eSource=new URL('../scripts/shorts-v2/episode.mjs',import.meta.url),sSource=new URL('../scripts/shorts-v2/scenes.mjs',import.meta.url),cSource=new URL('../scripts/shorts-v2/core.mjs',import.meta.url);
async function catalog(m){const data=JSON.parse(await readFile(new URL('../data/shorts-episodios-v2.json',import.meta.url),'utf8'));for(const e of data.episodes){const slot=e.theme_id.split(':')[0];assert.doesNotThrow(()=>assert.equal(m.episodeScript({slot,entry:{theme_id:e.theme_id},screen:{tip:e.tip}}).hook,e.hook));}}
test('NC07: every authored calendar lesson is addressable',()=>catalog(episode));
test('NC07 mutant: removing one lesson fails catalog coverage',()=>killedMutation(eSource,[['EPISODES.episodes.find','EPISODES.episodes.filter((_,i)=>i!==0).find']],catalog));
function sceneFixture(){const p=core.planV2(planSlot('2026-11-12','dica',{hotmartOpen:true}));let t=0;const words=p.speech.split(/\s+/).map(word=>{const start=t;t+=.31;return {word,start,end:t-.02};});return {p,words,duration:t+1};}
async function boundaries(m){const {p,words,duration}=sceneFixture(),list=m.sceneTimeline(p,words,duration);let cursor=0;for(const [i,s] of list.entries()){assert.equal(s.text,p.sentences[i]);assert.equal(s.start,words[cursor].start);cursor+=p.sentences[i].split(/\s+/).length;assert.equal(s.end,i===list.length-1?duration:words[cursor].start);}assert.equal(scenes.validateScenes(list,p,words,duration),true);}
test('NC08: complete sentences use actual aligned word boundaries',()=>boundaries(scenes));
test('NC08 mutant: fixed 2.5 second grid fails boundaries',()=>killedMutation(sSource,[['start:words[from].start','start:i*2.5']],boundaries));
test('NC08: fragment ending in article rejected; accented nouns accepted',()=>{const {p,words,duration}=sceneFixture(),list=scenes.sceneTimeline(p,words,duration);list[1].text='Separe as atividades e os';assert.throws(()=>scenes.validateScenes(list,p,words,duration),/scene_sentence_boundary/);assert.equal(scenes.validateScenes(scenes.sceneTimeline(p,words,duration),p,words,duration),true);});
async function quiet(m){assert.ok(m.quality({voiceMusicDb:30}).reasons.includes('voice_music_balance'));}
test('NC10: music too quiet is explicitly rejected',()=>quiet(core));
test('NC10 mutant: removing upper balance bound fails',()=>killedMutation(cSource,[['q.voiceMusicDb<=22','true']],quiet));
async function contrast(m){assert.ok(m.quality({captionContrast:2}).reasons.includes('caption_contrast'));}
test('NC09: insufficient contrast rejected',()=>contrast(core));
test('NC09 mutant: accepting low contrast fails',()=>killedMutation(cSource,[['q.captionContrast>=4.5','true']],contrast));
test('NC07: missing plan warns and performs no KV writes or QC downgrade',async()=>{const logs=[],kv={get:async()=>null,put:async()=>assert.fail('planning must not write')},raw=planSlot('2026-11-12','dica',{hotmartOpen:true});raw.screen.tip='Tarefa inexistente.';assert.equal(await core.planV2WithHistory(raw,{kv,hotmartOpen:true,note:(...a)=>logs.push(a)}),null);assert.equal(logs[0][0],'warning');assert.match(logs[0][1],/^SHORT_PLAN /);const source=await readFile(new URL('../scripts/channels/youtube-daily-short.mjs',import.meta.url),'utf8');assert.match(source,/if\(!plan\)continue;/);});
test('NC07: planner respects persisted receipts and retries same variant idempotently',async()=>{const map=new Map(),kv={get:async k=>map.get(k)??null,put:async(k,v)=>map.set(k,v)};for(let i=0;i<15;i++){const day=new Date(Date.parse('2026-11-12')+i*86400000).toISOString().slice(0,10);for(const slot of ['dica','calc','oferta']){const raw=planSlot(day,slot,{hotmartOpen:true}),p=await core.planV2WithHistory(raw,{kv,hotmartOpen:true});assert.ok(p);const {scriptHistory}=await import('../scripts/shorts-v2/script-history.mjs');await scriptHistory(kv,p,{reserve:true});assert.equal((await core.planV2WithHistory(raw,{kv,hotmartOpen:true})).speech,p.speech);}}});

test('NC07 composed mutant: deleting a used lesson breaks the full 180-day simulation',async()=>{
 const fs=await import('node:fs/promises'),{pathToFileURL}=await import('node:url');const file=new URL('../scripts/shorts-v2/episode-round3-deleted.mjs',import.meta.url);
 try{const source=await fs.readFile(eSource,'utf8');await fs.writeFile(file,source.replace('EPISODES.episodes.find','EPISODES.episodes.filter((_,i)=>i!==1).find'));await killedMutation(cSource,[["from './episode.mjs'","from '"+file.href+"'"]],async m=>assert.doesNotThrow(()=>simulate(m)));}finally{await fs.rm(file,{force:true});}
});

test('NC08: text exceeding frame width is rejected',()=>assert.ok(core.quality({textRight:1100}).reasons.includes('text_safe_area')));

test('NC08: a partial video stream is rejected even when container duration is valid',()=>assert.ok(core.quality({duration:29,videoDuration:3.2,videoFrames:96}).reasons.includes('video_incomplete')));
