import {createHash} from 'node:crypto';

export const CONTENT_DEDUP_POLICY=Object.freeze({
  version:'content-dedup-v1',window_days:90,max_history:250,
  same_channel_threshold:0.82,cross_channel_threshold:0.92,
  min_tokens_for_near_duplicate:8,shingle_size:3,
});
const cleanSpace=(value)=>String(value||'').replace(/\s+/gu,' ').trim();
export function canonicalizeContent(value){
  return cleanSpace(String(value||'').normalize('NFKC').toLowerCase()
    .replace(/https?:\/\/\S+/giu,' ')
    .replace(/[\p{P}\p{S}]+/gu,' '));
}
export function contentFingerprint(value){
  return createHash('sha256').update(canonicalizeContent(value),'utf8').digest('hex');
}
export function contentTokens(value){return canonicalizeContent(value).split(' ').filter(Boolean);}
export function shingles(value,size=CONTENT_DEDUP_POLICY.shingle_size){
  const tokens=contentTokens(value);const out=new Set();
  if(tokens.length<size){if(tokens.length)out.add(tokens.join(' '));return out;}
  for(let i=0;i<=tokens.length-size;i++)out.add(tokens.slice(i,i+size).join(' '));
  return out;
}
export function jaccardSimilarity(a,b){
  const left=a instanceof Set?a:shingles(a),right=b instanceof Set?b:shingles(b);
  if(!left.size&&!right.size)return 1;if(!left.size||!right.size)return 0;
  let intersection=0;for(const item of left)if(right.has(item))intersection++;
  return intersection/(left.size+right.size-intersection);
}
export function compareContent(candidate,historyItem={}){
  const current=canonicalizeContent(candidate),previous=canonicalizeContent(historyItem.content);
  if(!current)return Object.freeze({duplicate:true,kind:'empty',similarity:1});
  if(current===previous)return Object.freeze({duplicate:true,kind:'exact',similarity:1});
  const tokenCount=Math.min(contentTokens(current).length,contentTokens(previous).length);
  if(tokenCount<CONTENT_DEDUP_POLICY.min_tokens_for_near_duplicate)return Object.freeze({duplicate:false,kind:'short_text',similarity:0});
  const similarity=jaccardSimilarity(shingles(current),shingles(previous));
  const sameChannel=String(historyItem.channel||'').toLowerCase()===String(historyItem.candidate_channel||'').toLowerCase();
  const threshold=sameChannel?CONTENT_DEDUP_POLICY.same_channel_threshold:CONTENT_DEDUP_POLICY.cross_channel_threshold;
  return Object.freeze({duplicate:similarity>=threshold,kind:similarity>=threshold?'near':'novel',similarity,threshold});
}

export async function evaluateContentNovelty(sql,{content,channel}={}){
  const canonical=canonicalizeContent(content);if(!canonical)throw new Error('content_empty');
  const rows=await sql.query(`select destination,payload->>'content' content,created_at from integration_outbox
    where event_type='publish_content' and status<>'dead_letter' and created_at>=now()-interval '90 days'
    order by created_at desc limit 250`);
  const currentHash=contentFingerprint(canonical);
  let best=null;
  for(const row of rows){
    const previous=String(row.content||'');if(!previous)continue;
    const previousHash=contentFingerprint(previous);
    const previousChannel=String(row.destination||'').replace(/^channel:/,'');
    const cmp=previousHash===currentHash?{duplicate:true,kind:'exact',similarity:1,threshold:1}:compareContent(canonical,{content:previous,channel:previousChannel,candidate_channel:channel});
    if(!best||cmp.similarity>best.similarity)best={...cmp,channel:previousChannel,created_at:row.created_at||null};
    if(cmp.duplicate)return Object.freeze({allowed:false,reason:cmp.kind==='exact'?'content_duplicate_exact':'content_duplicate_near',fingerprint:currentHash,match:Object.freeze(best),policy:CONTENT_DEDUP_POLICY.version});
  }
  return Object.freeze({allowed:true,reason:'content_novel',fingerprint:currentHash,match:best?Object.freeze(best):null,policy:CONTENT_DEDUP_POLICY.version});
}
