import { neon } from '@neondatabase/serverless';
import { loadTikTokCredential, refreshTikTokCredential, fetchTikTokCreator } from '../src/tiktokOAuth.mjs';
export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  if(req.method!=='GET'){res.statusCode=405;return res.end('{"error":"method_not_allowed"}');}
  try{
    const sql=neon(process.env.DATABASE_URL);
    let c=await loadTikTokCredential(sql,process.env,{mode:'production'});
    if(new Date(c.expires_at).getTime()<=Date.now()+120000)c=await refreshTikTokCredential(sql,c,{env:process.env,mode:'production'});
    const p=await fetchTikTokCreator(c.access_token);
    const expected=String(process.env.TIKTOK_EXPECTED_USERNAME||'').replace(/^@/,'').toLowerCase();
    const scope=String(c.scope||'');
    const ok=p.username.toLowerCase()===expected && scope.split(',').map(x=>x.trim()).includes('video.publish');
    res.statusCode=ok?200:409;return res.end(JSON.stringify({connected:true,username_match:p.username.toLowerCase()===expected,video_publish_scope:scope.includes('video.publish'),provider_creator_ok:true,final_verified:ok}));
  }catch(e){res.statusCode=503;return res.end(JSON.stringify({connected:false,error:String(e?.message||'verification_failed')}));}
}
