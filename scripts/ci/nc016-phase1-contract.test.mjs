import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const root=fileURLToPath(new URL("../..",import.meta.url));
const read=path=>readFileSync(join(root,path),"utf8");
const pricing=[
 ["ia-na-pratica",97],["vendas-na-pratica",97],["lucro-e-caixa",147],
 ["combo-ia-vendas",157],["negocio-completo",247]
];
// NC-019 (DEC-01 v3, minuta R64): a liberação de 192 h não é vinculada ao prazo de garantia/arrependimento.
const deadline="O acesso online pelo Hotmart Club e as planilhas XLSX ficam disponíveis imediatamente após a aprovação do pagamento. Os PDFs e o pacote ZIP são enviados por e-mail 192 horas (8 dias) após a aprovação do pagamento.";

test("NC016-A1 root CP tombstone cannot index, offer or reactivate",()=>{
 const page=read("conteudo-pronto/index.html");
 assert.match(page,/noindex,nofollow/);
 assert.match(page,/Página indisponível/);
 assert.doesNotMatch(page,/data-zev-open-text|data-zev-sub|R\$|index,follow|pay\.hotmart\.com|\/assinar\//);
 assert.equal(page,read("sales-public/conteudo-pronto.html"));
});

test("NC016-A2 table C cannot drift between Python builder, Worker and published catalog",()=>{
 const builder=read("scripts/build_sales_public.py");
 const worker=read("worker/sales-public-worker.mjs");
 for(const [slug,price] of pricing){
   const sourceRe=new RegExp('"'+slug+'": \\{"sku": "[^"]+", "name": "[^"]+", "price": '+price+',');
   assert.match(builder,sourceRe,slug+" build");
   const catalogRe=new RegExp('<article[^>]+id="p-'+slug+'"[^>]*>[\\s\\S]*?<\\/article>');
   for(const pagePath of ["sales-public/index.html","sales-public/solucoes.html"]){
     const match=read(pagePath).match(catalogRe);
     assert.ok(match,slug+" "+pagePath);
     assert.match(match[0],new RegExp('<p class="catalog-price">R\\$ '+price+'<span>'),slug+" "+pagePath);
   }
   const product=read("sales-public/"+slug+".html");
   assert.match(product,new RegExp("Preço de tabela: R\\$ "+price+"\\b"),slug+" price");
 }
 const expected=[["ZEV-IA-011",97],["ZEV-VEN-011",97],["ZEV-LCX-011",147],["ZEV-CMB-011",157],["ZEV-NGC-011",247]];
 for(const [sku,price] of expected)assert.match(worker,new RegExp('"'+sku+'":\\[[^\\]]+,'+price+'\\]'),sku);
 const combo=read("sales-public/combo-ia-vendas.html");
 const full=read("sales-public/negocio-completo.html");
 assert.match(combo,/Economia de R\$ 37/);
 assert.match(full,/Economia de R\$ 94/);
});

test("NC016-A3 no boleto in first-phase offer, terms or Hotmart copy",()=>{
 const policy=JSON.parse(read("data/politica-unica.json"));
 assert.match(policy.resumo_oferta.hotmart.pagamento,/Pix à vista ou cartão/);
 for(const file of ["termos/index.html","sales-public/termos.html","worker/sales-public-worker.mjs"]){
   assert.doesNotMatch(read(file),/boleto/i,file);
 }
});

test("NC016-A4 delivery 192h is explicit and held for legal review",()=>{
 const policy=JSON.parse(read("data/politica-unica.json"));
 assert.match(policy.nota_nc016_dec01_v3,/pendente de revisão/i);
 assert.match(policy.sol_text,/192 horas \(8 dias\) após a aprovação do pagamento/);
 assert.ok(policy.sol_text.includes(deadline));
 assert.match(policy.sol_text,/até cinco downloads/);
 for(const file of ["termos/index.html","sales-public/termos.html","reembolso/index.html",
 "sales-public/reembolso.html",...pricing.map(([slug])=>"sales-public/"+slug+".html")]){
   const body=read(file);
   assert.match(body,/192 horas \(8 dias\)/,file);
   assert.doesNotMatch(body,/72 horas|72 h|para um download/i,file);
 }
 assert.match(read("sales-public/termos.html"),/revisão jurídica/i);
 assert.match(read("termos/index.html"),/não publicar/i);
});

test("NC016-A2/A4 root catalog is synchronized and independent of CP",()=>{
 assert.equal(read("sales-public/index.html"),read("sales-public/solucoes.html"));
 const catalog=read("sales-public/index.html");
 assert.doesNotMatch(catalog,/conteudo-pronto|Conteúdo Pronto|72 horas|72 h/i);
 assert.match(catalog,/192 horas \(8 dias\)/);
});
