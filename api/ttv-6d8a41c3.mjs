import { Pool } from '@neondatabase/serverless';
import { loadTikTokCredential, refreshTikTokCredential, fetchTikTokCreator } from '../src/tiktokOAuth.mjs';
export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  if(req.method!=='GET'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  let pool;
  try{
    pool=new Pool({connectionString:process.env.DATABASE_URL}); const c=await pool.connect();
    const sql={query:(text,args)=>c.query(text,args).then(r=>r.rows)};
    let cred=await loadTikTokCredential(sql,process.env,{mode:'production'});
    if(new Date(cred.expires_at).getTime()<=Date.now()+120000) cred=await refreshTikTokCredential(sql,cred,{env:process.env,fetchImpl:globalThis.fetch,mode:'production'});
    const creator=await fetchTikTokCreator(cred.access_token,globalThis.fetch); c.release();
    const expected=String(process.env.TIKTOK_EXPECTED_USERNAME||'').replace(/^@/,'').toLowerCase();
    const verified=Boolean(expected)&&creator.username.toLowerCase()===expected;
    res.statusCode=200; return res.end(JSON.stringify({provider:'tiktok',credential_present:true,verified,username:creator.username,nickname:creator.nickname}));
  }catch(error){res.statusCode=503;return res.end(JSON.stringify({provider:'tiktok',verified:false,error:String(error?.message||'verification_failed')}));}
  finally{if(pool)await pool.end().catch(()=>{});}
}
