export const ACTIVE_COMMERCIAL_FRONTS=Object.freeze([
  'zevanory','whatsapp','email','instagram','facebook',
  'youtube','google','affiliate','mercado_livre',
]);
export const EXCLUDED_COMMERCIAL_FRONTS=Object.freeze({
  tiktok:Object.freeze({status:'standby',reason:'deferred_by_owner',counts_toward_total:false}),
  linkedin:Object.freeze({status:'standby',reason:'deferred_by_owner',counts_toward_total:false}),
  nuvemshop:Object.freeze({status:'standby',reason:'deferred_by_owner',counts_toward_total:false}),
});
export const isActiveCommercialFront=(name)=>ACTIVE_COMMERCIAL_FRONTS.includes(String(name||''));