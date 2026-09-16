export const ACTIVE_COMMERCIAL_FRONTS=Object.freeze([
  'zevanory','whatsapp','email','instagram','facebook','tiktok',
  'youtube','linkedin','google','affiliate','nuvemshop','mercado_livre',
]);
export const EXCLUDED_COMMERCIAL_FRONTS=Object.freeze({});
export const isActiveCommercialFront=(name)=>ACTIVE_COMMERCIAL_FRONTS.includes(String(name||''));