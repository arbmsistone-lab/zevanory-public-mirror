import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

if(process.env.KNOWLEDGE_SEED_ALLOWED!=='true') throw new Error('knowledge_seed_not_authorized');
if(!process.env.DATABASE_URL) throw new Error('database_url_required');
const root=new URL('../',import.meta.url);
const docs=[
  ['commercial','Oferta canônica ZEVANORY','specs/OFFER-0001-ia-vendas-whatsapp.md','internal'],
  ['benchmarks','Parâmetros de mercado','specs/MARKET_PARAMETERS.md','verified'],
  ['architecture','Autonomous Revenue Engine EG-0035','evidence/EG-0035-autonomous-revenue-engine-world-benchmark.md','verified'],
];
const sql=neon(process.env.DATABASE_URL); let seeded=0;
for(const [namespace,title,path,trust] of docs){
  const content=(await readFile(new URL(path,root),'utf8')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ').slice(0,50000);
  await sql.query(`insert into knowledge_documents(document_id,namespace,title,content,source_ref,trust_level,active)
    values($1,$2,$3,$4,$5,$6,true)
    on conflict(namespace,title) do update set content=excluded.content,source_ref=excluded.source_ref,trust_level=excluded.trust_level,active=true,updated_at=now()`,
    [randomUUID(),namespace,title,content,path,trust]);
  seeded++;
}
console.log(JSON.stringify({ok:true,seeded}));
