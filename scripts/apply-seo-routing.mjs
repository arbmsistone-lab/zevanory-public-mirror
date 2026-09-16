import { readFileSync,writeFileSync } from 'node:fs';
const file=new URL('../vercel.json',import.meta.url);
const cfg=JSON.parse(readFileSync(file,'utf8'));
const routes=[
  ['/solucoes','/public/solucoes.html'],['/arbm-sist','/public/arbm-sist.html'],
  ['/ia-na-pratica','/public/ia-na-pratica.html'],['/vendas-na-pratica','/public/vendas-na-pratica.html'],
  ['/lucro-e-caixa','/public/lucro-e-caixa.html'],['/combo-ia-vendas','/public/combo-ia-vendas.html'],
  ['/negocio-completo','/public/negocio-completo.html'],['/product.css','/public/product.css']
];
const existing=new Set(cfg.rewrites.map(x=>x.source));
const insertion=routes.filter(([source])=>!existing.has(source)).map(([source,destination])=>({source,destination}));
const rootIndex=cfg.rewrites.findIndex(x=>x.source==='/');
cfg.rewrites.splice(rootIndex<0?cfg.rewrites.length:rootIndex,0,...insertion);
writeFileSync(file,JSON.stringify(cfg,null,2)+'\n','utf8');
console.log(`SEO_ROUTES_APPLIED added=${insertion.length}`);
