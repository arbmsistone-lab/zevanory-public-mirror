import fs from "node:fs";
import path from "node:path";
const root="C:/Users/airto/zevanory-canonical-finalizer";
const out=path.join(root,"sales-public");
fs.rmSync(out,{recursive:true,force:true}); fs.mkdirSync(out,{recursive:true});
const files=["solucoes.html","arbm-contador-saloes.html","ia-na-pratica.html","vendas-na-pratica.html","lucro-e-caixa.html","combo-ia-vendas.html","negocio-completo.html","termos.html","privacidade.html","reembolso.html","afiliados.html","product.css","legal.css","whatsapp-contact.js","robots.txt"];
for(const f of files) fs.copyFileSync(path.join(root,"public",f),path.join(out,f));
fs.cpSync(path.join(root,"public","brand"),path.join(out,"brand"),{recursive:true});
let cfo=fs.readFileSync(path.join(root,"zevanory-cfo","index.html"),"utf8").replaceAll("/zevanory-public-mirror/","/");
fs.writeFileSync(path.join(out,"zevanory-cfo.html"),cfo);
for(const f of fs.readdirSync(out,{recursive:true})){const p=path.join(out,String(f));if(!fs.existsSync(p)||fs.statSync(p).isDirectory())continue;if(!/\.(html|xml|js|txt)$/.test(p))continue;let s=fs.readFileSync(p,"utf8");s=s.replaceAll("https://zevanory.api.br","https://vendas.zevanory.api.br");fs.writeFileSync(p,s);}
let sol=fs.readFileSync(path.join(out,"solucoes.html"),"utf8");
if(!sol.includes("/zevanory-cfo")) sol=sol.replace('<section class="container catalog-grid">','<section class="container catalog-grid">\n<a class="catalog-card" href="/zevanory-cfo"><span class="catalog-type">Inteligência financeira com IA</span><h2>ZEVANORY CFO</h2><p>Caixa, recebíveis, conciliação, previsão e decisões financeiras com dados reais, governança e execução fail-closed.</p><span class="card-link">Ver ZEVANORY CFO →</span></a>');
fs.writeFileSync(path.join(out,"solucoes.html"),sol);
const all=fs.readdirSync(out,{recursive:true}).filter(f=>String(f).endsWith(".html")).map(f=>fs.readFileSync(path.join(out,String(f)),"utf8")).join("\n");
if(/ARBM SIST|ZEVANORY ONE|\/arbm-sist|\/zevanory-one/.test(all)) throw new Error("retired product leaked into sales surface");
console.log("SALES_PUBLIC_PREPARED=PASS");