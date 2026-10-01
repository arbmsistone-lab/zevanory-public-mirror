const retired=["/arbm-sist","/zevanory-one","/arbm-one"];
export default{async fetch(request){
  const url=new URL(request.url);
  const p=url.pathname.replace(/\/$/,"")||"/";
  if(retired.some(x=>p===x||p.startsWith(x+"/"))) return new Response("Produto retirado da superficie publica ZEVANORY.",{status:410,headers:{"cache-control":"no-store","content-type":"text/plain; charset=utf-8"}});
  if(p==="/") return Response.redirect("https://controle.zevanory.api.br/"+url.search,308);
  return Response.redirect("https://vendas.zevanory.api.br"+url.pathname+url.search,308);
}};