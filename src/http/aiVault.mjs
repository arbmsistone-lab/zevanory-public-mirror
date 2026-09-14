import { aiVaultStatus, constantTimeEqual, deriveAiVaultIngestToken, storeAiVaultSecret } from '../src/aiSecretVault.mjs';

async function readJson(req){
  let raw='';
  for await (const chunk of req){ raw+=chunk.toString(); if(raw.length>8192)throw new Error('payload_too_large'); }
  return JSON.parse(raw||'{}');
}
const json=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.end(JSON.stringify(body));};

export default async function handler(req,res){
  const master=process.env.AI_VAULT_ENCRYPTION_KEY;
  if(!master)return json(res,503,{error:'ai_vault_disabled'});
  if(req.method==='GET'){
    const expected=await deriveAiVaultIngestToken(master),provided=req.headers['x-zevanory-ai-vault-token'];
    if(!constantTimeEqual(provided,expected))return json(res,401,{error:'unauthorized'});
    return json(res,200,{ok:true,...await aiVaultStatus()});
  }
  if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});
  const expected=await deriveAiVaultIngestToken(master),provided=req.headers['x-zevanory-ai-vault-token'];
  if(!constantTimeEqual(provided,expected))return json(res,401,{error:'unauthorized'});
  try{
    const body=await readJson(req);
    const result=await storeAiVaultSecret(body.provider,body.secret,{master});
    return json(res,200,result);
  }catch(error){return json(res,400,{error:String(error?.message||'invalid_request')});}
}
