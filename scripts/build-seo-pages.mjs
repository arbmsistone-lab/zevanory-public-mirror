import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const base='https://zevanory.api.br';
const image=`${base}/brand/social/zevanory-social-profile-1080.png`;
const products=[
  {slug:'arbm-sist',name:'ARBM SIST',type:'SoftwareApplication',tag:'Automação e IA com controle',desc:'Agente de desenvolvimento e automação com IA local-first, arquitetura independente de provedor, controles de custo e rollback.',forWhom:'Equipes e operações que precisam automatizar com governança, rastreabilidade e independência de fornecedor.',includes:['Orquestração de IA e automações','Controles fail-closed e rollback','Arquitetura preparada para múltiplos provedores']},
  {slug:'ia-na-pratica',name:'ZEVANORY IA na Prática',type:'Product',tag:'IA aplicada ao trabalho real',desc:'Conteúdo prático para transformar IA em processos claros, repetíveis e úteis no dia a dia.',forWhom:'Profissionais e pequenos negócios que querem usar IA com método, sem depender de improviso.',includes:['Fluxos práticos de uso','Modelos de aplicação','Orientação para execução e revisão']},
  {slug:'vendas-na-pratica',name:'ZEVANORY Vendas na Prática',type:'Product',tag:'Processo comercial claro e executável',desc:'Método prático para organizar prospecção, atendimento, oferta, acompanhamento e aprendizado comercial.',forWhom:'Operações que precisam vender com mais método, acompanhamento e clareza de próxima ação.',includes:['Organização do funil','Roteiros de atendimento e follow-up','Medição e melhoria do processo']},
  {slug:'lucro-e-caixa',name:'ZEVANORY Lucro & Caixa',type:'Product',tag:'Decisões financeiras mais claras',desc:'Material prático para acompanhar entradas, saídas, margem e caixa com linguagem objetiva.',forWhom:'Negócios que precisam enxergar melhor dinheiro, margem e decisões do dia a dia.',includes:['Leitura simples do caixa','Organização de custos e margens','Rotina de acompanhamento financeiro']},
  {slug:'combo-ia-vendas',name:'ZEVANORY Combo IA + Vendas',type:'Product',tag:'IA e vendas trabalhando juntas',desc:'Combinação dos métodos de IA e vendas para acelerar execução comercial com processos mais claros.',forWhom:'Quem quer aplicar IA diretamente à rotina comercial e reduzir trabalho disperso.',includes:['IA na Prática','Vendas na Prática','Fluxo integrado de execução comercial']},
  {slug:'negocio-completo',name:'ZEVANORY Negócio Completo',type:'Product',tag:'Visão integrada para operar melhor',desc:'Pacote de organização prática para IA, vendas e gestão financeira em uma única jornada.',forWhom:'Pequenos negócios que querem integrar execução, comercial e controle financeiro.',includes:['IA aplicada','Processo comercial','Lucro e caixa em linguagem prática']},
];
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const schema=(p,url)=>JSON.stringify({
  '@context':'https://schema.org','@type':p.type,name:p.name,brand:{'@type':'Brand',name:'ZEVANORY'},
  description:p.desc,url,image,provider:{'@type':'Organization',name:'ZEVANORY',url:base}
});
const shell=(title,description,canonical,body,jsonLd)=>`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${canonical}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${image}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${image}">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/product.css">
<script type="application/ld+json">${jsonLd}</script></head><body>
<header class="site-header"><a href="/" aria-label="ZEVANORY"><img src="/brand/zevanory-logo-dark.svg" alt="ZEVANORY"></a><nav><a href="/solucoes">Soluções</a><a href="/piloto">Piloto</a><a href="/termos">Termos</a></nav></header>
${body}<footer><strong>ZEVANORY</strong><span>Menos improviso. Mais execução.</span><nav><a href="/privacidade">Privacidade</a><a href="/reembolso">Reembolso</a></nav></footer></body></html>`;
for(const p of products){
  const url=`${base}/${p.slug}`;
  const body=`<main><section class="hero"><p class="eyebrow">ZEVANORY · ${esc(p.tag)}</p><h1>${esc(p.name)}</h1><p class="lead">${esc(p.desc)}</p><div class="actions"><a class="primary" href="/solucoes">Conheça as soluções</a><a class="secondary" href="mailto:contato@zevanory.api.br">Falar com a ZEVANORY</a></div><p class="gate">Disponibilidade comercial sujeita aos gates oficiais da ZEVANORY.</p></section><section class="grid"><article><h2>Para quem é</h2><p>${esc(p.forWhom)}</p></article><article><h2>O que você encontra</h2><ul>${p.includes.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></article><article><h2>Como avaliamos qualidade</h2><p>Demonstração real, evidência verificável e métricas observadas antes de qualquer alegação de performance.</p></article></section><section class="proof"><h2>Decida com clareza</h2><p>A ZEVANORY explica o que a solução faz, para quem serve e quais limites existem antes de qualquer contratação.</p><a href="/piloto">Ver piloto de certificação</a></section></main>`;
  writeFileSync(join(root,`${p.slug}.html`),shell(`${p.name} | ZEVANORY`,p.desc,url,body,schema(p,url)),'utf8');
}
const cards=products.map(p=>`<article><p>${esc(p.tag)}</p><h2><a href="/${p.slug}">${esc(p.name)}</a></h2><span>${esc(p.desc)}</span><a class="card-link" href="/${p.slug}">Ver detalhes →</a></article>`).join('');
const portfolioSchema=JSON.stringify({'@context':'https://schema.org','@type':'CollectionPage',name:'Soluções ZEVANORY',url:`${base}/solucoes`,description:'Portfólio oficial de soluções ZEVANORY.',publisher:{'@type':'Organization',name:'ZEVANORY',url:base}});
const portfolioBody=`<main><section class="hero"><p class="eyebrow">Portfólio oficial</p><h1>Soluções ZEVANORY</h1><p class="lead">IA, automação, software e produtos digitais para organizar, executar e evoluir com mais controle.</p></section><section class="catalog">${cards}</section></main>`;
writeFileSync(join(root,'solucoes.html'),shell('Soluções ZEVANORY | IA, automação e software','Conheça o portfólio oficial ZEVANORY: ARBM SIST, IA na Prática, Vendas na Prática, Lucro & Caixa e soluções integradas.',`${base}/solucoes`,portfolioBody,portfolioSchema),'utf8');
const staticUrls=[['/',1.0,'weekly'],['/solucoes',0.95,'weekly'],...products.map(p=>[`/${p.slug}`,0.9,'weekly']),['/termos',0.4,'monthly'],['/privacidade',0.4,'monthly'],['/reembolso',0.4,'monthly'],['/afiliados',0.4,'monthly']];
const lastmod=new Date().toISOString().slice(0,10);
const sitemap=`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${staticUrls.map(([path,priority,freq])=>`  <url><loc>${base}${path}</loc><lastmod>${lastmod}</lastmod><changefreq>${freq}</changefreq><priority>${priority}</priority></url>`).join('\n')}\n</urlset>\n`;
writeFileSync(join(root,'sitemap.xml'),sitemap,'utf8');
console.log(`SEO_PAGES_BUILT products=${products.length} sitemap_urls=${staticUrls.length}`);
