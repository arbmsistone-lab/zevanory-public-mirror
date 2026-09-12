export const ACTIVE_COMMERCIAL_FRONTS=Object.freeze([
  'zevanory','whatsapp','email','instagram','facebook',
  'youtube','google','affiliate','mercado_livre',
]);
export const EXCLUDED_COMMERCIAL_FRONTS=Object.freeze({
  tiktok:Object.freeze({state:'backlog_excluded',reason:'production_publish_authorization_unavailable_and_no_independent_api_route'}),
  linkedin:Object.freeze({state:'backlog_excluded',reason:'external_oauth_not_viable_without_owner_setup'}),
  nuvemshop:Object.freeze({state:'backlog_excluded',reason:'external_oauth_authorization_unreliable'}),
});
export const isActiveCommercialFront=(name)=>ACTIVE_COMMERCIAL_FRONTS.includes(String(name||''));