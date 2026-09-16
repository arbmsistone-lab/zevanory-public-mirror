import { COMMERCIAL_MESSAGES } from './commercialMessaging.mjs';

export const PROFESSIONAL_EMAIL = Object.freeze({
  primary:'contato@zevanory.api.br',
  aliases:Object.freeze(['suporte@zevanory.api.br','vendas@zevanory.api.br','financeiro@zevanory.api.br']),
  domain:'zevanory.api.br',
  requiredDns:Object.freeze(['MX','SPF','DKIM','DMARC']),
});

export const BRAND_PROFILE = Object.freeze({
  name:'ZEVANORY',
  site:'https://zevanory.api.br',
  category:'Software / Tecnologia',
  profileImage:'/brand/social/zevanory-social-profile-1080.png',
  facebookCover:'/brand/social/zevanory-facebook-cover-1640x624.png',
  coreBio:COMMERCIAL_MESSAGES.zevanory.bio,
});

const brandLink=(source)=>`https://zevanory.api.br/?utm_source=${source}&utm_medium=organic&utm_campaign=zevanory_brand`;
const profile=(handle,source,extra={})=>Object.freeze({
  name:BRAND_PROFILE.name,handle,url:brandLink(source),category:BRAND_PROFILE.category,
  profileImage:BRAND_PROFILE.profileImage,...COMMERCIAL_MESSAGES[source],...extra,
});

export const CHANNEL_PROFILES = Object.freeze({
  instagram:profile('@zevanory_','instagram',{profileUrl:'https://www.instagram.com/zevanory_/',identityState:'provider_name_bio_site_confirmed_binding_pending'}),
  facebook:profile('ZEVANORY','facebook',{coverImage:BRAND_PROFILE.facebookCover,identityState:'provider_name_confirmed_profile_image_pending'}),
  tiktok:profile('@zevanory3','tiktok',{profileUrl:'https://www.tiktok.com/@zevanory3',identityState:'public_profile_known_provider_verification_pending'}),
  youtube:profile('@zevanory','youtube',{profileUrl:'https://youtube.com/@zevanory',identityState:'provider_identity_confirmed'}),
  linkedin:profile('ZEVANORY','linkedin',{identityState:'corporate_page_pending'}),
  google:profile('ZEVANORY','google',{identityState:'first_party_search_identity'}),
  whatsapp:profile('ZEVANORY','whatsapp',{identityState:'official_number_confirmed_display_name_pending'}),
  email:profile(PROFESSIONAL_EMAIL.primary,'email',{identityState:'first_party_domain'}),
  affiliate:profile('ZEVANORY','affiliate',{identityState:'first_party_partner_program'}),
  nuvemshop:profile('ZEVANORY','nuvemshop',{identityState:'storefront_exists_visual_proof_pending'}),
  mercado_livre:profile('ZEVANORY','mercado_livre',{identityState:'integration_exists_public_identity_proof_pending'}),
  zevanory:profile('ZEVANORY','zevanory',{profileUrl:BRAND_PROFILE.site,identityState:'first_party_assets_verified'}),
});
