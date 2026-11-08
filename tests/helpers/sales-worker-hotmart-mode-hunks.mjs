// Modo Hotmart (roteiro v5.0, Nível 1): hunks exatos do Worker de vendas, revertidos pelo teste diferencial
// para reconstruir byte a byte o Worker anterior (blob pinado). O comportamento novo é provado em
// tests/sales-hotmart-mode.test.mjs.
export const HOTMART_MODE_WORKER_BLOB = "5e0b876c3f753645592d0381ef732a6449e10eaf";
export const HOTMART_MODE_BASE_BLOB = "6a497854832d63b2f255d4561aa06ca64d9f6848";
export const HOTMART_MODE_HUNKS = Object.freeze([
[
"export function openSalesHtml(html,slug){\n",
"export function openSalesHtml(html,slug,{subscriptions=true}={}){\n"
],
[
"  out=out.replace(/<a ([^>]*?)href=\"[^\"]*\" data-zev-sub=\"([a-z-]+)\" data-zev-open-text=\"([^\"]*)\">[^<]*<\\/a>/g,(m,pre,sub,label)=>Object.prototype.hasOwnProperty.call(SUBSCRIPTION_PATHS,sub)?`<a ${pre}href=\"${SUBSCRIPTION_PATHS[sub]}\">${label}</a>`:m);\n",
"  if(subscriptions)out=out.replace(/<a ([^>]*?)href=\"[^\"]*\" data-zev-sub=\"([a-z-]+)\" data-zev-open-text=\"([^\"]*)\">[^<]*<\\/a>/g,(m,pre,sub,label)=>Object.prototype.hasOwnProperty.call(SUBSCRIPTION_PATHS,sub)?`<a ${pre}href=\"${SUBSCRIPTION_PATHS[sub]}\">${label}</a>`:m);\n"
],
[
"async function salesOpenForPages(env){return salesOpen(env)}\n",
"// Modo Hotmart (roteiro v5.0, Nível 1): canal próprio, lido em /api/sales/hotmart-status (chave sales:hotmart:v1).\n// Abre só a compra pela Hotmart dos 5 produtos; o Conteúdo Pronto e o checkout próprio seguem o interruptor completo.\nasync function hotmartOpen(env){\n  try{const st=await env.CORE.fetch(\"https://zevanory.api.br/api/sales/hotmart-status\");if(!st.ok)return false;return (await st.json())?.open===true}catch{return false}\n}\nasync function purchaseOpen(env){return (await salesOpen(env))||(await hotmartOpen(env))}\n// Estado da página dependente do interruptor: {open, subs}. subs=false no modo Hotmart (assinatura fechada).\nasync function salesOpenForPages(env,page){\n  if(await salesOpen(env))return {open:true,subs:true};\n  if(page!==\"conteudo-pronto\"&&await hotmartOpen(env))return {open:true,subs:false};\n  return {open:false,subs:false};\n}\n"
],
[
"    if(!(await salesOpen(env)))return infoPage(200,\"Vendas abrem em breve\",`<p>O ${PRICES[sku][0]} ainda não está à venda. Para dúvidas, escreva para ${CONTACT_HTML}.</p>`);\n",
"    if(!(await purchaseOpen(env)))return infoPage(200,\"Vendas abrem em breve\",`<p>O ${PRICES[sku][0]} ainda não está à venda. Para dúvidas, escreva para ${CONTACT_HTML}.</p>`);\n"
],
[
"  if(!(await salesOpen(env)))return infoPage(200,\"Vendas pausadas\",SALES_PAUSED_HTML(HOTMART_NAMES[slug]||\"produto\",slug));\n",
"  if(!(await purchaseOpen(env)))return infoPage(200,\"Vendas pausadas\",SALES_PAUSED_HTML(HOTMART_NAMES[slug]||\"produto\",slug));\n"
],
[
"  const toggleOpen=response.status===200&&request.method===\"GET\"&&SALES_TOGGLE_PAGES.has(page)?await salesOpenForPages(env):null;\n",
"  const toggleState=response.status===200&&request.method===\"GET\"&&SALES_TOGGLE_PAGES.has(page)?await salesOpenForPages(env,page):null;\n  const toggleOpen=toggleState===null?null:toggleState.open===true;\n"
],
[
"    {const h=new Headers(response.headers);h.delete(\"content-length\");response=new Response(openSalesHtml(await response.text(),page),{status:200,statusText:response.statusText,headers:h});}\n",
"    {const h=new Headers(response.headers);h.delete(\"content-length\");response=new Response(openSalesHtml(await response.text(),page,{subscriptions:toggleState.subs===true}),{status:200,statusText:response.statusText,headers:h});}\n"
]
]);
export function reverseHotmartMode(src) {
  let out = src;
  for (const [before, after] of HOTMART_MODE_HUNKS) {
    if (out.split(after).length !== 2) throw new Error("hotmart_mode_hunk_not_unique");
    out = out.replace(after, () => before);
  }
  return out;
}
