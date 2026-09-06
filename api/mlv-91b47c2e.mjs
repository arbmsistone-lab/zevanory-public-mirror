import { neon } from '@neondatabase/serverless';
import { verifyMercadoLivreLive } from '../src/mercadoLivreVerification.mjs';
export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  if(req.method!=='GET'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'database_unavailable'}));}
  try{
    const sql=neon(process.env.DATABASE_URL);
    const v=await verifyMercadoLivreLive(sql,{env:process.env,fetchImpl:globalThis.fetch});
    res.statusCode=200; return res.end(JSON.stringify(v));
  }catch(error){res.statusCode=503;return res.end(JSON.stringify({error:String(error?.message||'verification_failed')}));}
}
