import {cp,copyFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';

const root=new URL('..',import.meta.url);
const src=new URL('../public/',import.meta.url);
const out=new URL('../.pages-dist/',import.meta.url);
const routes=['criativos','solucoes','arbm-sist','ia-na-pratica','vendas-na-pratica','lucro-e-caixa','combo-ia-vendas','negocio-completo','piloto','termos','privacidade','exclusao-dados','reembolso','afiliados'];

await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
await cp(src,out,{recursive:true});
for(const route of routes){
  const dir=new URL(`../.pages-dist/${route}/`,import.meta.url);
  await mkdir(dir,{recursive:true});
  await copyFile(new URL(`../public/${route}.html`,import.meta.url),new URL(`../.pages-dist/${route}/index.html`,import.meta.url));
}
console.log(`PAGES_STATIC_BUILD_READY routes=${routes.length} output=${join(root.pathname,'.pages-dist')}`);
