// Funil (contra-auditoria GPT-6, 15/11/2026): rota /hotmart/<produto>/ir ("clicou para ir ao checkout") e botões da
// oferta passando por ela. Hunks exatos revertidos pelo teste diferencial para reconstruir o Worker do modo Hotmart
// (blob pinado). O comportamento novo é provado em tests/funil-clique-diagnostico.test.mjs.
export const FUNIL_CLIQUE_WORKER_BLOB = "5162b0b5841b6f9bc8c1edb50ba7b9fdf1e8287c";
export const FUNIL_CLIQUE_BASE_BLOB = "5e0b876c3f753645592d0381ef732a6449e10eaf";
export const FUNIL_CLIQUE_HUNKS = Object.freeze([
[
"async function handleHotmart(request,env,slug,ctx){\n",
"export const clickHref=(slug,src)=>\"/hotmart/\"+slug+\"/ir?utm_source=\"+encodeURIComponent(src||\"direto\");\n// Clique para o checkout: mede (sem bloquear) e redireciona à oferta Hotmart cadastrada do produto, com a origem\n// preservada. Falha de medição nunca impede o checkout; vendas pausadas mostram a mesma página de pausa.\nexport async function handleHotmartClick(request,env,slug,ctx){\n  if(!Object.prototype.hasOwnProperty.call(HOTMART_CHECKOUT,slug))return infoPage(404,\"Produto não encontrado\",\"<p>Esse produto não existe.</p>\");\n  const aberto=await purchaseOpen(env);  // mesmo interruptor da página da oferta (fail-closed)\n  if(!aberto)return infoPage(200,\"Vendas pausadas\",SALES_PAUSED_HTML(HOTMART_NAMES[slug]||\"produto\",slug));\n  const {src}=attribution(request,new URL(request.url));\n  try{countView(request,env,ctx,slug,\"hotmart_click\")}catch{}\n  const checkout=HOTMART_CHECKOUT[slug]+\"&src=\"+src;\n  if(!/^https:\\/\\/pay\\.hotmart\\.com\\/[A-Za-z0-9]+(\\?[A-Za-z0-9=&_-]*)?$/.test(checkout))\n    return new Response(null,{status:302,headers:applySecurityHeaders(new Headers({location:\"/\"+slug,\"cache-control\":\"no-store\"}))});\n  return new Response(null,{status:302,headers:applySecurityHeaders(new Headers({location:checkout,\"cache-control\":\"no-store\",\"x-robots-tag\":\"noindex, nofollow\"}))});\n}\nasync function handleHotmart(request,env,slug,ctx){\n"
],
[
"  try{return new Response(hotmartPage(await page.text(),slug,checkout),{status:200,headers})}\n",
"  // Funil (GPT-6, 15/11): os botões passam pela rota própria de clique, que mede \"clicou para ir ao checkout\" e\n  // redireciona à oferta cadastrada; a origem do visitante segue no link para chegar à Hotmart.\n  try{return new Response(hotmartPage(await page.text(),slug,clickHref(slug,src)),{status:200,headers})}\n"
],
[
"  const hm=url.pathname.match(/^\\/hotmart\\/([a-z-]{3,40})\\/?$/);\n",
"  const hc=url.pathname.match(/^\\/hotmart\\/([a-z-]{3,40})\\/ir\\/?$/);\n  if(hc&&(request.method===\"GET\"||request.method===\"HEAD\")) return handleHotmartClick(request,env,hc[1],ctx);\n  const hm=url.pathname.match(/^\\/hotmart\\/([a-z-]{3,40})\\/?$/);\n"
]
]);
export function reverseFunilClique(src) {
  let out = src;
  for (const [before, after] of FUNIL_CLIQUE_HUNKS) {
    if (out.split(after).length !== 2) throw new Error("funil_clique_hunk_not_unique");
    out = out.replace(after, () => before);
  }
  return out;
}
