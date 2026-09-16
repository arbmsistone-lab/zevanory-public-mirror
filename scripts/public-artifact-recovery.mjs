import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const root=process.cwd(), src=join(root,'public'), out=join(root,'.tmp-public-recovery');
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const walk=d=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name)):[join(d,e.name)]);
const required=['solucoes.html','arbm-sist.html','ia-na-pratica.html','vendas-na-pratica.html','lucro-e-caixa.html','combo-ia-vendas.html','negocio-completo.html','sitemap.xml','robots.txt','product.css'];
for(const f of required) if(!existsSync(join(src,f))) throw new Error(`missing public artifact: ${f}`);
rmSync(out,{recursive:true,force:true}); mkdirSync(out,{recursive:true}); cpSync(src,out,{recursive:true});
const originals=walk(src), restored=walk(out);
if(originals.length!==restored.length) throw new Error(`file-count mismatch ${originals.length}/${restored.length}`);
const manifest=new Map(originals.map(p=>[relative(src,p).replaceAll('\\','/'),sha(p)]));
for(const p of restored){const r=relative(out,p).replaceAll('\\','/'); if(manifest.get(r)!==sha(p)) throw new Error(`hash mismatch: ${r}`);}
const forbidden=/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|sk-proj-|gho_[A-Za-z0-9]+|MERCADOPAGO_ACCESS_TOKEN\s*=/i;
for(const p of restored){if(statSync(p).size<2000000 && forbidden.test(readFileSync(p,'utf8'))) throw new Error(`secret-like content: ${relative(out,p)}`);}
console.log(`PUBLIC_ARTIFACT_RECOVERY PASS files=${restored.length} sha256_verified=${restored.length}`);
rmSync(out,{recursive:true,force:true});