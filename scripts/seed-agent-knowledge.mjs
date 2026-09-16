import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

if(process.env.KNOWLEDGE_SEED_ALLOWED!=='true') throw new Error('knowledge_seed_not_authorized');
if(!process.env.DATABASE_URL) throw new Error('database_url_required');
const root=new URL('../',import.meta.url);
const docs=[
  ['company','ZEVANORY identidade e posicionamento','config/brand-identity.json','official'],
  ['company','ZEVANORY mensagem comercial por canal','src/commercialMessaging.mjs','official'],
  ['company','ZEVANORY portfolio e contas comerciais','launch/ZEVANORY-PRODUCTS-V21-HANDOFF.md','official'],
  ['company','ZEVANORY identidade omnichannel','launch/ZEVANORY-OMNICHANNEL-IDENTITY.md','official'],
  ['commercial','Oferta canonica ZEVANORY','specs/OFFER-0001-ia-vendas-whatsapp.md','internal'],
  ['product:ARBM-SIST','ARBM SIST plano de canais','launch/ARBM-SIST-CHANNEL-PLAN.md','official'],
  ['product:ARBM-SIST','ARBM SIST demonstracoes comerciais','launch/ARBM-SIST-DEMO-SCRIPTS-20260831.md','official'],
  ['product:ARBM-SIST','ARBM SIST perfis e posicionamento','launch/ARBM-SIST-SOCIAL-PROFILES.md','official'],
  ['benchmarks','Parametros de mercado','specs/MARKET_PARAMETERS.md','verified'],
  ['architecture','Autonomous Revenue Engine EG-0035','evidence/EG-0035-autonomous-revenue-engine-world-benchmark.md','verified'],
];
const productRelease='v2.1';
const productRoot=new URL(`../products/releases/${productRelease}/`,import.meta.url);
for(const entry of await readdir(productRoot,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^ZEV-/.test(entry.name))continue;
  for(const file of ['README.md','CHECKLIST-IMPLEMENTACAO.md','PLANO-INTEGRADO.md','PROJETO-FINAL.md','AVALIACAO-PRATICA.md','FAQ.md','GLOSSARIO.md','REFERENCIAS.md','SUPORTE-E-TROUBLESHOOTING.md','TERMOS.txt','manifest.json']){
    try{await readFile(new URL(`${entry.name}/${file}`,productRoot),'utf8');docs.push([`product:${entry.name}`,`${entry.name} ${productRelease} ${file}`,`products/releases/${productRelease}/${entry.name}/${file}`,'official']);}catch{}
  }
  try{for(const mod of await readdir(new URL(`${entry.name}/modulos/`,productRoot))){if(mod.endsWith('.md'))docs.push([`product:${entry.name}`,`${entry.name} ${productRelease} ${mod}`,`products/releases/${productRelease}/${entry.name}/modulos/${mod}`,'official']);}}catch{}
}
const supportRoot=new URL('../products/support/',import.meta.url);
try{
  for(const product of await readdir(supportRoot,{withFileTypes:true})){
    if(!product.isDirectory())continue;
    const entries=await readdir(new URL(`${product.name}/`,supportRoot),{withFileTypes:true});
    for(const entry of entries){
      if(entry.isFile()&&/\.(md|json|ts|txt)$/i.test(entry.name))docs.push([`product:${product.name.toUpperCase()}`,`${product.name} ${entry.name}`,`products/support/${product.name}/${entry.name}`,'official']);
      if(!entry.isDirectory())continue;
      for(const file of await readdir(new URL(`${product.name}/${entry.name}/`,supportRoot))){
        if(!/\.(md|json|ts|txt)$/i.test(file))continue;
        docs.push([`product:${product.name.toUpperCase()}`,`${product.name} ${entry.name} ${file}`,`products/support/${product.name}/${entry.name}/${file}`,'official']);
      }
    }
  }
}catch{}
const sql=neon(process.env.DATABASE_URL); let seeded=0;
// Retire superseded content-product releases before activating the current certified release.
for(const code of ['ZEV-CMB-011','ZEV-IA-011','ZEV-LCX-011','ZEV-NGC-011','ZEV-VEN-011']){
  await sql.query("update knowledge_documents set active=false,updated_at=now() where namespace=$1 and source_ref like 'products/releases/v%' and source_ref not like $2",[`product:${code}`,`products/releases/${productRelease}/%`]);
}
await sql.query("update knowledge_documents set active=false,updated_at=now() where namespace='company' and source_ref='launch/ZEVANORY-PRODUCTS-V11-HANDOFF.md'");

for(const [namespace,title,path,trust] of docs){
  const content=(await readFile(new URL(path,root),'utf8')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ').slice(0,50000);
  await sql.query('update knowledge_documents set active=false,updated_at=now() where namespace=$1 and source_ref=$2 and title<>$3',[namespace,path,title]);
  await sql.query(`insert into knowledge_documents(document_id,namespace,title,content,source_ref,trust_level,active)
    values($1,$2,$3,$4,$5,$6,true)
    on conflict(namespace,title) do update set content=excluded.content,source_ref=excluded.source_ref,trust_level=excluded.trust_level,active=true,updated_at=now()`,
    [randomUUID(),namespace,title,content,path,trust]);
  seeded++;
}
console.log(JSON.stringify({ok:true,seeded}));
