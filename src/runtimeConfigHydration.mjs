const FAIL_CLOSED_RUNTIME_FLAGS=Object.freeze(['CERTIFICATION_PILOT_ENABLED','SALE_GLOBALLY_ENABLED','PRE_SALE_GATES_APPROVED','CHECKOUT_ENABLED','WHATSAPP_SALES_ENABLED','FINANCIAL_EVENTS_ENABLED']);

export function hydrateRuntimeConfig(env=process.env,target=process.env) {
  for(const key of FAIL_CLOSED_RUNTIME_FLAGS) target[key]=String(env?.[key]??'false');
  if (env && typeof env === 'object') {
    for (const [key,value] of Object.entries(env)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') target[key]=String(value);
    }
  }
  const raw=env?.ZEVANORY_RUNTIME_CONFIG;
  if(raw){
    let config=raw;
    if(typeof raw==='string'){try{config=JSON.parse(raw);}catch{config=null;}}
    if(config&&typeof config==='object'&&!Array.isArray(config)) for(const [key,value] of Object.entries(config)){
      if(value===undefined||value===null||target[key]!==undefined)continue;
      target[key]=String(value);
    }
  }
  if(target.META_APP_SECRET===undefined&&target.META_APP_SECRET01)target.META_APP_SECRET=target.META_APP_SECRET01;
  if(target.OPERATOR_TOKEN===undefined&&target.ELITE_INTERNAL_TOKEN)target.OPERATOR_TOKEN=target.ELITE_INTERNAL_TOKEN;
  return target;
}
