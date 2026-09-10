const flag=(env,key)=>String(env[key]||'').trim()==='true';
const front=(verified,source,blocker=null)=>Object.freeze({verified,source,blocker:verified?null:blocker});
export const BRAND_IDENTITY_FRONTS=Object.freeze(['zevanory','whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','google','affiliate','nuvemshop','mercado_livre']);
export function brandIdentityReadiness(env=process.env){
  const fronts={
    zevanory:front(true,'first_party_assets'),
    whatsapp:front(flag(env,'WHATSAPP_BRAND_IDENTITY_VERIFIED'),'provider_profile','WHATSAPP_BRAND_IDENTITY_NOT_VERIFIED'),
    email:front(true,'first_party_domain'),
    instagram:front(flag(env,'INSTAGRAM_BRAND_IDENTITY_VERIFIED'),'provider_profile','INSTAGRAM_BRAND_IDENTITY_NOT_VERIFIED'),
    facebook:front(flag(env,'FACEBOOK_BRAND_IDENTITY_VERIFIED'),'provider_profile','FACEBOOK_BRAND_IDENTITY_NOT_VERIFIED'),
    tiktok:front(flag(env,'TIKTOK_BRAND_IDENTITY_VERIFIED'),'provider_profile','TIKTOK_BRAND_IDENTITY_NOT_VERIFIED'),
    youtube:front(flag(env,'YOUTUBE_BRAND_IDENTITY_VERIFIED'),'provider_profile','YOUTUBE_BRAND_IDENTITY_NOT_VERIFIED'),
    linkedin:(()=>{const corporate=flag(env,'LINKEDIN_BRAND_IDENTITY_VERIFIED');const founder=flag(env,'LINKEDIN_FOUNDER_PROFILE_VERIFIED')&&flag(env,'LINKEDIN_OPERATOR_ASSISTED_PUBLISHING');return front(corporate||founder,corporate?'provider_profile':'verified_founder_profile','LINKEDIN_IDENTITY_ROUTE_NOT_VERIFIED')})(),
    google:front(true,'first_party_search_identity'),
    affiliate:front(true,'first_party_partner_program'),
    nuvemshop:front(flag(env,'NUVEMSHOP_BRAND_IDENTITY_VERIFIED'),'provider_storefront','NUVEMSHOP_BRAND_IDENTITY_NOT_VERIFIED'),
    mercado_livre:front(flag(env,'MERCADOLIVRE_BRAND_IDENTITY_VERIFIED'),'provider_marketplace','MERCADOLIVRE_BRAND_IDENTITY_NOT_VERIFIED'),
  };
  const values=Object.values(fronts),verified=values.filter(x=>x.verified).length;
  return Object.freeze({version:'brand-identity-v2',ready:verified===values.length,verified_fronts:verified,total_fronts:values.length,fronts:Object.freeze(fronts),blockers:Object.freeze(values.filter(x=>!x.verified).map(x=>x.blocker))});
}