import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync} from "node:fs";
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

// NC-019: fontes públicas (canônicas e geradas) sem a cláusula que amarrava a entrega ao prazo de garantia.
const PUBLIC_DIRS=["sales-public","pages-mirror","worker"];
const PUBLIC_FILES=["data/politica-unica.json","data/products.json","data/p24/promise-map.json","sales-overlay/approved.json",
 "scripts/build_sales_public.py","scripts/sales_policy.py","termos/index.html","reembolso/index.html",
 ...pricing.map(([slug])=>slug+"/index.html")];
const LD=/<script type="application\/ld\+json">[\s\S]*?<\/script>/g;

test("NC019-1 no public source ties delivery to the end of the warranty period",()=>{
 const files=[...PUBLIC_FILES];
 for(const dir of PUBLIC_DIRS)for(const f of readdirSync(join(root,dir)))if(/\.(html|mjs|js|json|txt|xml)$/.test(f))files.push(dir+"/"+f);
 let scanned=0;
 for(const file of files){
   if(!existsSync(join(root,file)))continue;
   scanned++;
   assert.doesNotMatch(read(file),/fim do prazo de garantia/i,file);
 }
 assert.ok(scanned>100,"scan is not vacuous: "+scanned);
 const policy=JSON.parse(read("data/politica-unica.json"));
 assert.ok(policy.customer_wording.delivery.startsWith(deadline),"customer wording keeps the canonical delivery sentence");
 // The 7-day withdrawal (art. 49 CDC) sentence stays independent of the 192 h release.
 const withdrawal=policy.sol_text.slice(policy.sol_text.indexOf("Em contratação online"));
 assert.match(withdrawal,/^Em contratação online, o consumidor poderá desistir sem justificativa e sem ônus no prazo de 7 dias corridos contado da assinatura do contrato ou do recebimento do produto ou serviço/);
 assert.doesNotMatch(withdrawal.slice(0,withdrawal.indexOf(".")),/192|PDF|ZIP|garantia/);
});

test("NC019-2 base product pages: payment field and purchase wording name the Hotmart, never Mercado Pago (DEC-05)",()=>{
 const policy=JSON.parse(read("data/politica-unica.json"));
 assert.equal(policy.resumo_oferta.produto_digital.pagamento,"Pix à vista ou cartão, pela Hotmart. A compra só é confirmada após a aprovação do pagamento.");
 assert.match(policy.sol_text,/comunicará imediatamente a Hotmart/);
 assert.doesNotMatch(policy.sol_text,/comunicará imediatamente o Mercado Pago/);
 for(const [slug] of pricing){
   const page=read("sales-public/"+slug+".html");
   const field=page.match(/<div data-field="pagamento"><dt>[^<]*<\/dt><dd>([^<]*)<\/dd><\/div>/);
   assert.ok(field,slug+": Resumo da oferta payment field");
   assert.match(field[1],/Hotmart/,slug);
   assert.doesNotMatch(field[1],/Mercado Pago/,slug);
   const visible=page.replace(LD,"");
   assert.doesNotMatch(visible,/Mercado Pago|pedir-reembolso/,slug+": no own-checkout purchase or refund wording");
   assert.match(visible,/peça pela Hotmart, em Minhas compras, ou pelo e-mail suporte@zevanory\.api\.br/,slug+": refund instruction for new purchases");
   assert.match(visible,/Entrega: acesso online e planilhas logo após a aprovação do pagamento; PDFs e ZIP por e-mail 192 horas \(8 dias\) após a aprovação\./,slug+": policy summary");
 }
});
