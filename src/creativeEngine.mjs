import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolveCheckoutOffer } from './offerCatalog.mjs';

const esc=(v)=>String(v??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
const cap=(v,n)=>esc(v).slice(0,n);
const dims=Object.freeze({
  instagram:[1080,1080], facebook:[1080,1080], linkedin:[1200,1200],
  tiktok:[1080,1920], youtube:[1080,1920], whatsapp:[1080,1080], email:[1200,628]
});
const digest=(v)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function createCreativeSpec({offerId='OFFER-0001',channel='instagram',hook='',body='',cta='',objective='awareness'}={}){
  const offer=resolveCheckoutOffer(offerId); if(!offer) throw new Error('creative_offer_unknown');
  const key=String(channel).toLowerCase(); const [width,height]=dims[key]||[1080,1080];
  const spec={version:1,brand:'ZEVANORY',channel:key,objective:cap(objective,60),width,height,
    offer_id:offer.id,product:cap(offer.product||offer.commercial_name,100),price_brl:Number(offer.price_brl),
    hook:cap(hook||`Conheça ${offer.product}`,110),body:cap(body||'Tecnologia, automação e IA aplicada com execução segura.',260),
    cta:cap(cta||'Saiba mais',50),site:'zevanory.api.br'};
  return Object.freeze({...spec,creative_id:digest(spec).slice(0,24)});
}

export function creativeStoryboard(spec){
  return Object.freeze([
    Object.freeze({at_ms:0,text:spec.hook,role:'hook'}),
    Object.freeze({at_ms:1400,text:spec.body,role:'value'}),
    Object.freeze({at_ms:3000,text:spec.cta,role:'cta'})
  ]);
}

export function signCreativeSpec(spec,format='png',env=process.env){
  const key=String(env.CREATIVE_ASSET_SIGNING_KEY||''); if(key.length<32) throw new Error('creative_signing_key_missing');
  const payload=Buffer.from(JSON.stringify({spec,format:String(format)})).toString('base64url');
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
  const rebuilt=createCreativeSpec({offerId:parsed.spec.offer_id,channel:parsed.spec.channel,hook:parsed.spec.hook,body:parsed.spec.body,cta:parsed.spec.cta,objective:parsed.spec.objective});
  return rebuilt.creative_id===parsed.spec.creative_id?Object.freeze({spec:rebuilt,format:String(parsed.format)}):null;
}

export function creativeAssetUrl(spec,format='png',env=process.env){
  const {payload,sig}=signCreativeSpec(spec,format,env); const base=String(env.PUBLIC_BASE_URL||'https://zevanory.api.br').replace(/\/$/,'');
  return `${base}/api/creative-asset?p=${encodeURIComponent(payload)}&s=${encodeURIComponent(sig)}`;
}
