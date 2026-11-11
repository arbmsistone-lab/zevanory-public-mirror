import {createHash} from 'node:crypto';
const prefix='zpc:shorts:v2:roteiro:',DAY=86400000,slots=['dica','oferta','calc'];
const hash=s=>createHash('sha256').update(s).digest('hex');
const norm=s=>s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N} ]/gu,'').replace(/\s+/g,' ').trim();
export function fingerprint(plan){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(plan.day)||!slots.includes(plan.slot)||!plan.speech||!Array.isArray(plan.sentences)||plan.sentences.join(' ')!==plan.speech)throw Error('script_fingerprint_invalid');
 return {schema:1,day:plan.day,slot:plan.slot,speech:plan.speech,sha256:hash(plan.speech),sentences:plan.sentences.map(norm)};
}
function decode(raw,day,slot){
 try{const r=JSON.parse(raw);if(Object.keys(r).sort().join(',')!=='day,schema,sentences,sha256,slot,speech'||r.schema!==1||r.day!==day||r.slot!==slot||r.sha256!==hash(r.speech)||!Array.isArray(r.sentences)||r.sentences.length<6||r.sentences.some(s=>typeof s!=='string'||!s||norm(s)!==s)||JSON.stringify(r.sentences)!==JSON.stringify(r.speech.match(/[^.!?]+[.!?]?/g).map(norm)))throw 0;return r;}catch{throw Error('script_receipt_unreadable');}
}
export function assertNovel(current,history){
 for(const prior of history){
  const age=(Date.parse(current.day)-Date.parse(prior.day))/DAY;
  if(age<0||age>60)continue;
  if(prior.sha256===current.sha256)throw Error('script_repeated_60d');
  const shared=current.sentences.filter(s=>prior.sentences.includes(s)).length/Math.min(current.sentences.length,prior.sentences.length);
  if(age<=30&&shared>.4)throw Error('script_similar_30d');
 }
}
export async function scriptHistory(kv,plan,{reserve=false,historyOnly=false}={}){
 if(!kv?.get||!kv?.put)throw Error('script_history_unavailable');
 const current=fingerprint(plan),history=[];
 // Missing is valid only when both the projection and its immutable receipt are
 // genuinely absent. Read failures and contradictory evidence never become [].
 for(let i=0;i<=60;i++){
  const day=new Date(Date.parse(plan.day+'T12:00:00Z')-i*DAY).toISOString().slice(0,10);
  for(const slot of slots){
   const key=prefix+day+':'+slot,raw=await kv.get(key),receipt=await kv.get(prefix+'receipt:'+day+':'+slot);
   if(raw===null&&receipt===null)continue;
   const verified=receipt===null?null:decode(receipt,day,slot);
   let record;try{record=decode(raw,day,slot);}catch{if(!verified)throw Error('script_history_unknown');record=verified;}
   if(verified&&record.sha256!==verified.sha256)throw Error('script_history_conflict');
   if(day===plan.day&&slot===plan.slot){if(historyOnly){history.push(record);continue;}if(record.sha256!==current.sha256)throw Error('script_slot_conflict');continue;}
   history.push(record);
  }
 }
 if(historyOnly)return history;
 assertNovel(current,history);
 if(reserve){const value=JSON.stringify(current),opts={expirationTtl:65*86400};await kv.put(prefix+'receipt:'+plan.day+':'+plan.slot,value,opts);await kv.put(prefix+plan.day+':'+plan.slot,value,opts);}
 return current;
}
