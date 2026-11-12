import {PUBLISHED_PREFIX} from './music-policy.mjs';
const date=/^\d{4}-\d{2}-\d{2}$/,file=/^assets\/musica\/[a-z0-9-]+\.ogg$/;
export function publicationRecord(value){if(!value||!date.test(value.day)||!['dica','calc','oferta'].includes(value.slot)||!/^[A-Za-z0-9_-]{6,32}$/.test(value.video_id||'')||!file.test(value.arquivo)||!Number.isSafeInteger(value.em)||value.em<=0)throw Error('music_publication_unreadable');return value;}
export async function recordMusicPublication(kv,plan,result,track,em=Date.now()){
 if(result.privacy_status!=='public')return;
 if(plan.v2===true&&result.reused===true&&!result.music_file)throw Error('music_attribution_unconfirmed');
 const value=publicationRecord({day:plan.day,slot:plan.slot,video_id:result.video_id,arquivo:result.music_file||track.arquivo,em}),key=PUBLISHED_PREFIX+plan.day+':'+plan.slot,prior=await kv.get(key);
 if(prior!==null){const r=publicationRecord(JSON.parse(prior));if(r.video_id!==value.video_id||r.arquivo!==value.arquivo)throw Error('music_publication_conflict');return;}
 await kv.put(key,JSON.stringify(value),{expirationTtl:400*86400});
}
export async function musicPublications(kv,day,days=30){
 if(!date.test(day)||!Number.isInteger(days)||days<1||days>180)throw Error('music_history_range_invalid');
 const rows=[],seen=new Set();for(let i=0;i<days;i++){const d=new Date(Date.parse(day+'T12:00:00Z')-i*86400000).toISOString().slice(0,10);for(const slot of ['dica','calc','oferta']){const raw=await kv.get(PUBLISHED_PREFIX+d+':'+slot);if(raw===null)continue;const r=publicationRecord(JSON.parse(raw));if(r.day!==d||r.slot!==slot||seen.has(r.video_id))throw Error('music_publication_conflict');seen.add(r.video_id);rows.push(r);}}
 return rows;
}
export function updateObservation(state,publications){const next=structuredClone(state);for(const [file,row] of Object.entries(next.faixas)){row.videos=new Set(publications.filter(r=>r.arquivo===file&&r.day>=row.desde).map(r=>r.video_id)).size;if(row.status==='observacao'&&row.videos>=5)row.status='ativa';}return next;}

export function lastPublishedMusic(rows,fallback=null,currentAttempt=null){const last=[...rows].sort((a,b)=>b.em-a.em)[0]||null;if(currentAttempt&&fallback?.em===currentAttempt.em&&fallback?.arquivo===currentAttempt.arquivo)return last;return last&&(!fallback||last.em>=fallback.em)?last:fallback;}
