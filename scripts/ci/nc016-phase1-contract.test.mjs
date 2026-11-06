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
// DEC-06 (Claude + GPT-6; conferência ao vivo na Hotmart): produto integral para download na área de compras da Hotmart,
// imediatamente após a aprovação. Substitui a liberação de 192 h da DEC-01 v3 (módulo preservado e inativo).
const deadline="Após a aprovação do pagamento pela Hotmart, você recebe acesso imediato ao conteúdo integral do produto para download na sua área de compras da Hotmart (Minhas compras): PDFs, planilhas XLSX, arquivos editáveis e pacote ZIP, conforme a oferta. Se houver erro de acesso ou arquivo indisponível, o suporte resolve sem custo: suporte@zevanory.api.br.";
const shortDelivery="Acesso imediato e integral para download na sua área de compras da Hotmart após a aprovação do pagamento.";
const guarantee="A garantia destas ofertas na Hotmart é de 7 dias.";
const refundNew="pela Hotmart (refund.hotmart.com ou Minhas compras) ou pelo e-mail suporte@zevanory.api.br";
// Promessas da DEC-01 v3 que não podem voltar ao texto público.
const DEFERRED=/192\s*(horas|h)\b|\(8 dias\)|cinco downloads|até 5 downloads|link (individual|pessoal)|e-mail 192|Hotmart Club|conteúdo online/i;

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

test("NC016-A4 / DEC-06 immediate full download at the Hotmart purchase area, owner-approved terms published",()=>{
 const policy=JSON.parse(read("data/politica-unica.json"));
 assert.match(policy.nota_nc016_dec01_v3,/aprovados pelo proprietário/i);
 assert.match(policy.nota_nc016_dec01_v3,/NÃO autoriza merge nem deploy/);
 assert.match(policy.nota_dec06,/DEC-06/);
 assert.ok(policy.sol_text.includes(deadline));
 assert.ok(policy.sol_text.includes(guarantee));
 assert.ok(policy.sol_text.includes(refundNew));
 assert.doesNotMatch(policy.sol_text,DEFERRED);
 assert.equal(policy.delivery_short,shortDelivery);
 assert.equal(policy.resumo_oferta.produto_digital.entrega,shortDelivery);
 assert.equal(policy.resumo_oferta.hotmart.entrega,shortDelivery);
 for(const file of ["termos/index.html","sales-public/termos.html","reembolso/index.html",
 "sales-public/reembolso.html",...pricing.map(([slug])=>"sales-public/"+slug+".html")]){
   const body=read(file);
   assert.ok(body.includes(deadline),file+": DEC-06 delivery sentence");
   assert.ok(body.includes(guarantee),file+": Hotmart 7-day guarantee line");
   assert.doesNotMatch(body,DEFERRED,file);
   assert.doesNotMatch(body,/72 horas|72 h|para um download/i,file);
 }
 // DEC-06: the owner approved the consolidated terms; the published pages carry no draft/hold marker.
 for(const file of ["termos/index.html","sales-public/termos.html","reembolso/index.html","sales-public/reembolso.html"]){
   assert.doesNotMatch(read(file),/não publicar|minuta|revisão jurídica/i,file);
 }
});

test("NC016-A2/A4 root catalog is synchronized and independent of CP",()=>{
 assert.equal(read("sales-public/index.html"),read("sales-public/solucoes.html"));
 const catalog=read("sales-public/index.html");
 assert.doesNotMatch(catalog,/conteudo-pronto|Conteúdo Pronto|72 horas|72 h/i);
 assert.ok(catalog.includes(deadline),"catalog states the DEC-06 delivery");
 assert.doesNotMatch(catalog,DEFERRED);
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
 // The 7-day withdrawal (art. 49 CDC) sentence stays independent of the delivery.
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
   assert.ok(visible.includes("peça "+refundNew+"."),slug+": refund instruction for new purchases");
   assert.ok(visible.includes("Entrega: acesso imediato e integral para download na sua área de compras da Hotmart após a aprovação do pagamento."),slug+": policy summary");
   assert.ok(visible.includes(guarantee),slug+": Hotmart guarantee line");
   const entrega=page.match(/<div data-field="entrega"><dt>Modo e prazo de entrega<\/dt><dd>([^<]*)<\/dd><\/div>/);
   assert.ok(entrega&&entrega[1]===shortDelivery,slug+": Resumo da oferta delivery field");
 }
});

// DEC-06: nenhuma fonte pública (canônica, gerada, overlay, Worker de vendas, espelho) promete entrega diferida, limite
// de downloads ou link externo; o texto de 192 h só vive no módulo inativo e nos seus testes.
test("DEC06-1 public sources carry the immediate download sentence and no deferred/external-link promise",()=>{
 const files=[...PUBLIC_FILES,"worker/politica-unica.mjs","worker/site-chat.mjs","worker/support-knowledge.mjs",
  "solucoes/index.html"];
 for(const dir of ["sales-public","pages-mirror"])for(const f of readdirSync(join(root,dir)))if(/\.(html|txt|xml|json)$/.test(f))files.push(dir+"/"+f);
 const INACTIVE=/^worker\/(kit-release-192h|kit-nc015-|kit-hotmart-identity|kit-deferred-192h-flag)/;
 let scanned=0;
 for(const file of files){
   if(!existsSync(join(root,file))||INACTIVE.test(file))continue;
   scanned++;
   let body=read(file);
   if(file==="data/politica-unica.json"){const d=JSON.parse(body);body=JSON.stringify([d.sol_text,d.delivery_72h,d.delivery_short,d.customer_wording,d.resumo_oferta]);}
   if(file==="scripts/sales_policy.py")body=body.replace(/^DEC06_FORBIDDEN_RE = .*$/m,"");
   assert.doesNotMatch(body,DEFERRED,file);
 }
 assert.ok(scanned>150,"scan is not vacuous: "+scanned);
 const policy=JSON.parse(read("data/politica-unica.json"));
 assert.equal(policy.customer_wording.delivery,deadline);
 assert.equal(policy.customer_wording.refund_channels_hotmart,refundNew);
 assert.equal(policy.hotmart_guarantee,guarantee);
 for(const f of ["termos/index.html","reembolso/index.html"])assert.doesNotMatch(read(f),/download imediato/i,f);
});

test("DEC06-2 support answers with the new delivery/refund sentences pass the site validator; purchase calls stay blocked",async()=>{
 const {validateSiteReply}=await import("../../worker/site-chat.mjs");
 const {answerSupportQuestion}=await import("../../worker/support-knowledge.mjs");
 const {hasCheckoutCta}=await import("../../worker/politica-unica.mjs");
 for(const q of ["como é a entrega?","como recebo o material?","quero reembolso","tem garantia?"]){
   const a=answerSupportQuestion({question:q,product:"ia-na-pratica"}).answer;
   assert.deepEqual(validateSiteReply(a).issues,[],q);
   assert.equal(hasCheckoutCta(a),false,q);
 }
 assert.ok(answerSupportQuestion({question:"como recebo o material?"}).answer.includes(deadline));
 for(const bad of ["compre no Hotmart Club","Compre agora na Hotmart (Minhas compras)","https://pay.hotmart.com/F107979716H",
  "Acesse /comprar/ZEV-IA-011","Finalize em go.hotmart.com/abc","Garanta já o seu na Hotmart"]){
   assert.ok(validateSiteReply(bad).issues.includes("checkout"),bad);
   assert.equal(hasCheckoutCta(bad),true,bad);
 }
});
