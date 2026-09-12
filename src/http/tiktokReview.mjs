import { Pool } from '@neondatabase/serverless';
import { fetchTikTokCreator, loadTikTokCredential, readTikTokReviewSession, refreshTikTokCredential } from '../tiktokOAuth.mjs';
import { fetchTikTokPostStatus, publishTikTok } from '../socialPosting.mjs';

const json=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');return res.end(JSON.stringify(body));};
const cookie=(req,name)=>String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)||'';
const query=(req)=>{try{return new URL(req.url||'','https://zevanory.api.br').searchParams;}catch{return new URLSearchParams();}};
const bodyFrom=async(req)=>{
  if(req.body&&typeof req.body==='object')return req.body;
  if(typeof req.body==='string'&&req.body.trim())return JSON.parse(req.body);
  const chunks=[];for await(const chunk of req)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
  const text=Buffer.concat(chunks).toString('utf8').trim();return text?JSON.parse(text):{};
};

async function withReviewCredential(req,work){
  const session=readTikTokReviewSession(cookie(req,'zevanory_tiktok_review_session'),process.env);
  if(!process.env.DATABASE_URL)throw new Error('tiktok_review_database_unavailable');
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try{const client=await pool.connect();try{
    const sql={query:(text,args)=>client.query(text,args).then(r=>r.rows)};
    let credential=await loadTikTokCredential(sql,process.env,{mode:'review'});
    if(String(credential.account_id)!==session.subject)throw new Error('tiktok_review_session_subject_mismatch');
    if(new Date(credential.expires_at).getTime()<=Date.now()+30*60*1000)credential=await refreshTikTokCredential(sql,credential,{env:process.env,mode:'review'});
    return await work({credential,sql,session});
  }finally{client.release();}}finally{await pool.end().catch(()=>{});}
}
export default async function handler(req,res){
  try{
    if(req.method==='GET'){
      const action=String(query(req).get('action')||'creator').toLowerCase();
      if(action!=='creator')return json(res,400,{error:'tiktok_review_action_invalid'});
      const creator=await withReviewCredential(req,async({credential})=>fetchTikTokCreator(credential.access_token));
      return json(res,200,{connected:true,mode:'review',creator,commercial_enabled:false});
    }
    if(req.method==='POST'){
      const payload=await bodyFrom(req),action=String(payload.action||'publish').toLowerCase();
      if(action==='status'){
        const status=await withReviewCredential(req,async({credential})=>fetchTikTokPostStatus({publishId:payload.publish_id,accessToken:credential.access_token}));
        return json(res,200,{ok:true,...status});
      }
      if(action!=='publish')return json(res,400,{error:'tiktok_review_action_invalid'});
      const result=await withReviewCredential(req,async({credential})=>publishTikTok({event:{payload:{...payload,user_consent:payload.user_consent===true,music_usage_confirmation:payload.music_usage_confirmation===true}},env:{...process.env,TIKTOK_CLIENT_AUDITED:'false'},accessToken:credential.access_token}));
      return json(res,202,{ok:true,...result,review_only:true,commercial_enabled:false});
    }
    return json(res,405,{error:'method_not_allowed'});
  }catch(error){
    const message=String(error?.message||'tiktok_review_failed');
    const auth=/session|credential_missing|access_token/.test(message);
    return json(res,auth?401:400,{ok:false,error:message,commercial_enabled:false});
  }
}
