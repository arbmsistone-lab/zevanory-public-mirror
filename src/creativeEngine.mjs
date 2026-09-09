import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolveCheckoutOffer } from './offerCatalog.mjs';

const esc=(v)=>String(v??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
const cap=(v,n)=>esc(v).slice(0,n);
export const CREATIVE_FORMATS=Object.freeze({
  instagram:Object.freeze({feed_portrait:[1080,1350],square:[1080,1080],story:[1080,1920],reel:[1080,1920]}),
  facebook:Object.freeze({feed_portrait:[1200,1500],square:[1080,1080],story:[1080,1920]}),
  linkedin:Object.freeze({feed_landscape:[1200,627],square:[1200,1200],portrait:[1200,1500]}),
  tiktok:Object.freeze({in_feed:[1080,1920]}),youtube:Object.freeze({short:[1080,1920],thumbnail:[1280,720]}),
  whatsapp:Object.freeze({card:[1080,1080],status:[1080,1920]}),email:Object.freeze({hero:[1200,628],square:[1080,1080]})
});
const defaultPlacement=Object.freeze({instagram:'square',facebook:'square',linkedin:'square',tiktok:'in_feed',youtube:'short',whatsapp:'card',email:'hero'});
export const creativePlacements=(channel)=>Object.freeze(Object.keys(CREATIVE_FORMATS[String(channel).toLowerCase()]||{default:[1080,1080]}));
const resolveFormat=(channel,placement)=>{const key=String(channel).toLowerCase(),profiles=CREATIVE_FORMATS[key]||{default:[1080,1080]},place=profiles[String(placement)]?String(placement):(defaultPlacement[key]||Object.keys(profiles)[0]);return Object.freeze({placement:place,dims:profiles[place]});};
const digest=(v)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const boundedDimension=(value,fallback)=>Math.max(320,Math.min(2160,Math.trunc(Number(value)||fallback)));

export function createCreativeSpec({offerId='OFFER-0001',channel='instagram',hook='',body='',cta='',objective='awareness',width=null,height=null,layout='editorial',formatName='default',placement='',campaignId='',variantId=''}={}){
  const offer=resolveCheckoutOffer(offerId); if(!offer) throw new Error('creative_offer_unknown');
  const key=String(channel).toLowerCase(),resolved=resolveFormat(key,placement); const [defaultWidth,defaultHeight]=resolved.dims;
  const spec={version:3,brand:'ZEVANORY',channel:key,objective:cap(objective,60),
    width:boundedDimension(width,defaultWidth),height:boundedDimension(height,defaultHeight),
    layout:cap(layout||'editorial',32),format_name:cap(formatName||'default',32),placement:cap(resolved.placement,32),
    campaign_id:cap(campaignId,32),variant_id:cap(variantId,40),
    offer_id:offer.id,product:cap(offer.product||offer.commercial_name,100),price_brl:Number(offer.price_brl),
    hook:cap(hook||`Conheca ${offer.product}`,110),body:cap(body||'Tecnologia, automacao e IA aplicada com execucao segura.',260),
    cta:cap(cta||'Saiba mais',50),site:'zevanory.api.br'};
  return Object.freeze({...spec,creative_id:digest(spec).slice(0,24)});
}

export function creativeStoryboard(spec){
  return Object.freeze([
    Object.freeze({at_ms:0,end_ms:1300,text:spec.hook,role:'hook'}),
    Object.freeze({at_ms:1300,end_ms:3000,text:spec.body,role:'value'}),
    Object.freeze({at_ms:3000,end_ms:4200,text:spec.cta,role:'cta'})
  ]);
}

export function signCreativeSpec(spec,format='png',env=process.env){
  const key=String(env.CREATIVE_ASSET_SIGNING_KEY||''); if(key.length<32) throw new Error('creative_signing_key_missing');
  const normalizedFormat=String(format).toLowerCase(); if(!['png','webm'].includes(normalizedFormat)) throw new Error('creative_format_unsupported');
  const payload=Buffer.from(JSON.stringify({spec,format:normalizedFormat})).toString('base64url');
  const sig=createHmac('sha256',key).update(payload).digest('base64url');
  return Object.freeze({payload,sig});
}

export function verifyCreativeToken(payload,sig,env=process.env){
  const key=String(env.CREATIVE_ASSET_SIGNING_KEY||''); if(key.length<32) throw new Error('creative_signing_key_missing');
  const expected=createHmac('sha256',key).update(String(payload||'')).digest();
  let actual; try{actual=Buffer.from(String(sig||''),'base64url')}catch{return null}
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) return null;
  let parsed; try{parsed=JSON.parse(Buffer.from(String(payload),'base64url').toString('utf8'))}catch{return null}
  if(!parsed?.spec?.creative_id||!['png','webm'].includes(String(parsed.format))) return null;
  const s=parsed.spec;
  if(Number(s.version)===2){const legacy={...s};delete legacy.creative_id;if(s.brand!=='ZEVANORY'||s.site!=='zevanory.api.br'||digest(legacy).slice(0,24)!==s.creative_id)return null;return Object.freeze({spec:Object.freeze({...s}),format:String(parsed.format)});}
  const rebuilt=createCreativeSpec({offerId:s.offer_id,channel:s.channel,hook:s.hook,body:s.body,cta:s.cta,objective:s.objective,width:s.width,height:s.height,layout:s.layout,formatName:s.format_name,placement:s.placement,campaignId:s.campaign_id,variantId:s.variant_id});
  return rebuilt.creative_id===s.creative_id?Object.freeze({spec:rebuilt,format:String(parsed.format)}):null;
}

export function creativeAssetUrl(spec,format='png',env=process.env){
  const {payload,sig}=signCreativeSpec(spec,format,env); const base=String(env.PUBLIC_BASE_URL||'https://zevanory.api.br').replace(/\/$/,'');
  return `${base}/api/creative-asset?p=${encodeURIComponent(payload)}&s=${encodeURIComponent(sig)}`;
}
export function creativeAssetEtag(spec,format='png'){
  return `"ci-${digest({creative_id:spec?.creative_id||'',format:String(format).toLowerCase(),renderer:'v3'}).slice(0,32)}"`;
}
