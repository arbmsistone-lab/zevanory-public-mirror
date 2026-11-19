// D12 (19/11/2026, VC-H): interruptor Hotmart POR PRODUTO no site de vendas, independente do checkout próprio.
// Hunks exatos revertidos pelo teste diferencial para reconstruir o Worker anterior (blob pinado = gh-pages 282b0474).
// O comportamento novo é provado em tests/hotmart-paused.test.mjs, tests/sales-hotmart-mode.test.mjs e
// tests/d12-hotmart-por-produto.test.mjs.
export const D12_PREVIOUS_WORKER_BLOB = "5162b0b5841b6f9bc8c1edb50ba7b9fdf1e8287c";
export const D12_HUNKS = Object.freeze([
[
"// Abre só a compra pela Hotmart dos 5 produtos; o Conteúdo Pronto e o checkout próprio seguem o interruptor completo.\nasync function hotmartOpen(env){\n  try{const st=await env.CORE.fetch(\"https://zevanory.api.br/api/sales/hotmart-status\");if(!st.ok)return false;return (await st.json())?.open===true}catch{return false}\n",
"// Abre só a compra pela Hotmart dos 5 produtos; o Conteúdo Pronto e o checkout próprio seguem o interruptor completo.\n// D12 (19/11/2026, VC-H): o modo Hotmart abre POR PRODUTO (lista `products` do status). As rotas /hotmart/<kit> e\n// /hotmart/<kit>/ir dependem SÓ desse interruptor, nunca do checkout próprio (sales:open:v1): cada canal tem a sua chave.\n// Leitura indisponível, status não-200, JSON inválido ou lista ausente = fechado.\nasync function hotmartStatus(env){\n  try{const st=await env.CORE.fetch(\"https://zevanory.api.br/api/sales/hotmart-status\");if(!st.ok)return null;const v=await st.json();return v?.open===true&&Array.isArray(v.products)?v:null}catch{return null}\n"
],
[
"}\nasync function purchaseOpen(env){return (await salesOpen(env))||(await hotmartOpen(env))}\n",
"}\nconst HOTMART_KIT_PAGES=[\"ia-na-pratica\",\"vendas-na-pratica\",\"lucro-e-caixa\",\"combo-ia-vendas\",\"negocio-completo\"];\nasync function hotmartOpenFor(env,slug){const v=await hotmartStatus(env);return v!==null&&v.products.includes(slug)}\nasync function hotmartAllOpen(env){const v=await hotmartStatus(env);return v!==null&&HOTMART_KIT_PAGES.every(s=>v.products.includes(s))}\nasync function purchaseOpen(env,slug){return hotmartOpenFor(env,slug)}\n"
],
[
"// Estado da página dependente do interruptor: {open, subs}. subs=false no modo Hotmart (assinatura fechada).\n",
"// Estado da página dependente do interruptor: {open, subs}. subs=false no modo Hotmart (assinatura fechada).\n// Modo Hotmart: a página de um kit abre só com ESSE kit liberado; o catálogo (/solucoes) só com os 5 liberados.\n"
],
[
"  if(await salesOpen(env))return {open:true,subs:true};\n  if(page!==\"conteudo-pronto\"&&await hotmartOpen(env))return {open:true,subs:false};\n",
"  if(await salesOpen(env))return {open:true,subs:true};\n  if(page===\"solucoes\"&&await hotmartAllOpen(env))return {open:true,subs:false};\n  if(HOTMART_KIT_PAGES.includes(page)&&await hotmartOpenFor(env,page))return {open:true,subs:false};\n"
],
[
"    if(request.method!==\"GET\"&&request.method!==\"HEAD\")return infoPage(503,\"Checkout próprio indisponível\",\"<p>Na primeira fase, os guias e kits usam somente a Hotmart.</p>\");\n    if(!(await purchaseOpen(env)))return infoPage(200,\"Vendas abrem em breve\",`<p>O ${PRICES[sku][0]} ainda não está à venda. Para dúvidas, escreva para ${CONTACT_HTML}.</p>`);\n",
"    if(request.method!==\"GET\"&&request.method!==\"HEAD\")return infoPage(503,\"Checkout próprio indisponível\",\"<p>Na primeira fase, os guias e kits usam somente a Hotmart.</p>\");\n    if(!(await purchaseOpen(env,slug)))return infoPage(200,\"Vendas abrem em breve\",`<p>O ${PRICES[sku][0]} ainda não está à venda. Para dúvidas, escreva para ${CONTACT_HTML}.</p>`);\n"
],
[
"  if(!Object.prototype.hasOwnProperty.call(HOTMART_CHECKOUT,slug))return infoPage(404,\"Produto não encontrado\",\"<p>Esse produto não existe.</p>\");\n  const aberto=await purchaseOpen(env);  // mesmo interruptor da página da oferta (fail-closed)\n",
"  if(!Object.prototype.hasOwnProperty.call(HOTMART_CHECKOUT,slug))return infoPage(404,\"Produto não encontrado\",\"<p>Esse produto não existe.</p>\");\n  const aberto=await purchaseOpen(env,slug);  // mesmo interruptor da página da oferta, por produto (fail-closed)\n"
],
[
"  if(!Object.prototype.hasOwnProperty.call(HOTMART_CHECKOUT,slug))return infoPage(404,\"Produto não encontrado\",\"<p>Esse produto não existe.</p>\");\n  if(!(await purchaseOpen(env)))return infoPage(200,\"Vendas pausadas\",SALES_PAUSED_HTML(HOTMART_NAMES[slug]||\"produto\",slug));\n",
"  if(!Object.prototype.hasOwnProperty.call(HOTMART_CHECKOUT,slug))return infoPage(404,\"Produto não encontrado\",\"<p>Esse produto não existe.</p>\");\n  if(!(await purchaseOpen(env,slug)))return infoPage(200,\"Vendas pausadas\",SALES_PAUSED_HTML(HOTMART_NAMES[slug]||\"produto\",slug));\n"
]
]);
export function reverseD12(src) {
  let out = src;
  for (const [before, after] of D12_HUNKS) {
    if (out.split(after).length !== 2) throw new Error("d12_hunk_not_unique");
    out = out.replace(after, () => before);
  }
  return out;
}
