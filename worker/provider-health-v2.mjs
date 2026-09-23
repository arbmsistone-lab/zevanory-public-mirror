const json=(body,status=200)=>new Response(JSON.stringify(body,null,2),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});

async function callRaw(worker,request,env,ctx,path){
  const u=new URL(path,new URL(request.url).origin);
  try{
    const r=await worker.fetch(new Request(u,request),env,ctx);
    let body=null; try{body=await r.clone().json()}catch{}
    return {ok:r.ok,status:r.status,body};
  }catch(error){return {ok:false,status:0,body:null,error:String(error?.message||error)}}
}

export async function buildProviderHealthV2(request,env,ctx,worker){
  const [payment,status,closure]=await Promise.all([
    callRaw(worker,request,env,ctx,"/api/provider-health"),
    callRaw(worker,request,env,ctx,"/api/status"),
    callRaw(worker,request,env,ctx,"/api/config?view=closure_status")
  ]);
  const continuity=status.body?.continuity||{};
  const paymentReady=payment.ok && payment.body?.authenticated===true && payment.body?.pre_sale_ready===true;
  const channels=closure.body?.channels||{};
  const channelSummary={};
  for(const name of ["zevanory","whatsapp","email","instagram","facebook","youtube","google","affiliate","mercado_livre"]){
    const x=channels[name]||{};
    channelSummary[name]={
      operational_ready:x.operational_ready===true,
      operational_mode:x.operational_mode||"unknown",
      scope_status:x.scope_status||"unknown"
    };
  }
  const technicalReady=status.ok && continuity.quorum_ok===true;
  return {
    schema:"zevanory-provider-health/v2",
    service:"ZEVANORY",
    overall_state:technicalReady?"OPERATIONAL":"DEGRADED",
    technical_continuity:{
      ready:technicalReady,
      mode:continuity.mode||null,
      quorum_ok:continuity.quorum_ok===true,
      min_quorum:Number(continuity.min_quorum||0),
      available_channels:Array.isArray(continuity.available_channels)?continuity.available_channels:[]
    },
    payment:{
      ready:paymentReady,
      diagnostic_http:payment.status,
      provider:payment.body?.payment_provider||null,
      configured:payment.body?.configured===true,
      authenticated:payment.body?.authenticated===true,
      pre_sale_ready:payment.body?.pre_sale_ready===true,
      blockers:Array.isArray(payment.body?.pre_sale_blockers)?payment.body.pre_sale_blockers:[],
      movement_enabled:false
    },
    channels:channelSummary,
    commercial_release_allowed:false,
    note:"HTTP 200 means provider fabric is operational; payment readiness remains an independent fail-closed field."
  };
}

export async function handleProviderHealthV2(request,env,ctx,worker){
  if(request.method!=="GET") return json({error:"method_not_allowed"},405);
  const body=await buildProviderHealthV2(request,env,ctx,worker);
  return json(body,body.technical_continuity.ready?200:503);
}
