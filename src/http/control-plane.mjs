import { readFile } from 'node:fs/promises';
import { buildControlPlaneSnapshot } from '../controlPlanePolicy.mjs';

async function loadCertification(){
  try{
    const raw=await readFile(new URL('../../public/control-plane-certification.json',import.meta.url),'utf8');
    const parsed=JSON.parse(raw);
    return parsed && typeof parsed==='object' ? parsed : null;
  }catch{return null;}
}

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){
    res.statusCode=405;
    return res.end(JSON.stringify({error:'method_not_allowed'}));
  }
  const certification=await loadCertification();
  res.statusCode=200;
  return res.end(JSON.stringify(buildControlPlaneSnapshot(process.env,certification)));
}
