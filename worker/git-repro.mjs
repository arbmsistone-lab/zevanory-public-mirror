const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const commercialLocked=(env)=>[
  env.VENDA_GLOBALMENTE_HABILITADA,
  env.PRE_VENDA_PORTOES_APROVADOS,
  env.VENDAS_PELO_WHATSAPP_HABILITADAS,
  env.CHECKOUT_ATIVADO,
  env.EVENTOS_FINANCEIROS_ATIVADOS,
  env.LIBERACAO_ABSOLUTA_APROVADA
].every(v=>String(v).toLowerCase()!=="true");

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/__git-repro/health"){
      return json({ok:true,mode:"git-repro-staging",commercial_locked:commercialLocked(env),assets:Boolean(env.ASSETS)});
    }
    if(url.pathname.startsWith("/api/")){
      if(!commercialLocked(env)) return json({ok:false,error:"commercial_gate_open_unexpectedly"},503);
      return json({ok:false,error:"api_binding_not_cut_over",message:"Production API remains on the existing Worker until service/KV/AI bindings are reconciled."},503);
    }
    if(!env.ASSETS||typeof env.ASSETS.fetch!=="function") return json({ok:false,error:"assets_binding_missing"},503);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller,env){
    if(!commercialLocked(env)) throw new Error("fail_closed: commercial gate unexpectedly open");
  }
};
