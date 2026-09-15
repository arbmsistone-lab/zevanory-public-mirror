import { PROJECT } from './config.mjs';
import { resolveYouTubeAccessToken } from './youtubeUpload.mjs';

const EXPECTED_YOUTUBE_CHANNEL_ID='UCMl8-SxMVv77S2tz2H63P3A';
const clean=(v,max=500)=>String(v||'').trim().slice(0,max);
const digits=(v)=>clean(v,100).replace(/\D/g,'');
const json=async(r)=>{try{return await r.json();}catch{return {};}};
const result=(attempted,verified,reason,identity={})=>Object.freeze({attempted,verified,reason,...identity});
const authHeaders=(token)=>({authorization:`Bearer ${token}`});

async function getJson(fetchImpl,url,token){
  const r=await fetchImpl(url,{headers:authHeaders(token)});const body=await json(r);
  if(!r.ok) return {ok:false,status:r.status,body};
  return {ok:true,status:r.status,body};
}

export function resolveMetaVerifyToken(env=process.env){
  return clean(env.META_VERIFY_TOKEN,4000)||clean(env.META_WEBHOOK_VERIFY_TOKEN,4000);
}

export async function verifyFacebookIdentity({env=process.env,fetchImpl=globalThis.fetch}={}){
  const token=clean(env.META_ACCESS_TOKEN,4000),id=clean(env.META_PAGE_ID),version=clean(env.META_GRAPH_VERSION,20);
  if(!token||!id||!version)return result(false,false,'credentials_missing');
  const x=await getJson(fetchImpl,`https://graph.facebook.com/${version}/${encodeURIComponent(id)}?fields=id,name`,token);
  if(!x.ok)return result(true,false,`provider_http_${x.status}`);
  const ok=clean(x.body?.id)===id&&clean(x.body?.name).toUpperCase()==='ZEVANORY';
  return result(true,ok,ok?'identity_match':'identity_mismatch',{provider_id:clean(x.body?.id),name:clean(x.body?.name)});
}

export async function verifyInstagramIdentity({env=process.env,fetchImpl=globalThis.fetch}={}){
  const token=clean(env.META_ACCESS_TOKEN,4000),id=clean(env.INSTAGRAM_BUSINESS_ACCOUNT_ID),version=clean(env.META_GRAPH_VERSION,20);
  if(!token||!id||!version)return result(false,false,'credentials_missing');
  const fields='id,username,biography,website';
  const x=await getJson(fetchImpl,`https://graph.facebook.com/${version}/${encodeURIComponent(id)}?fields=${fields}`,token);
  if(!x.ok)return result(true,false,`provider_http_${x.status}`);
  const biography=clean(x.body?.biography,500),website=clean(x.body?.website,1000);
  const whatsappVisible=digits(biography).includes(PROJECT.officialWhatsappE164)||website.replace(/\D/g,'').includes(PROJECT.officialWhatsappE164);
  let whatsappRouteReady=false,whatsappRouteMode='none';
  if(!whatsappVisible){try{const u=new URL(website);if(u.protocol==='https:'&&u.hostname==='zevanory.api.br'){const page=await fetchImpl(u.toString(),{signal:AbortSignal.timeout(10000)});const html=page.ok?await page.text():'';const direct=html.includes(PROJECT.officialWhatsappE164)&&/wa\.me/i.test(html);let script=false;if(page.ok&&/whatsapp-contact\.js/i.test(html)){const sr=await fetchImpl(new URL('/whatsapp-contact.js',u.origin).toString(),{signal:AbortSignal.timeout(10000)});const body=sr.ok?await sr.text():'';script=sr.ok&&body.includes(PROJECT.officialWhatsappE164)&&/wa\.me/i.test(body);}whatsappRouteReady=page.ok&&(direct||script);if(whatsappRouteReady)whatsappRouteMode=direct?'canonical_site_direct':'canonical_site_script';}}catch{}}
  const ok=clean(x.body?.id)===id&&clean(x.body?.username).toLowerCase()==='zevanory_';
  return result(true,ok,ok?'identity_match':'identity_mismatch',{provider_id:clean(x.body?.id),username:clean(x.body?.username),biography,website,whatsapp_contact_visible:whatsappVisible,whatsapp_route_ready:whatsappVisible||whatsappRouteReady,whatsapp_route_mode:whatsappVisible?'native_profile':whatsappRouteMode});
}

export async function verifyWhatsappIdentity({env=process.env,fetchImpl=globalThis.fetch}={}){
  const token=clean(env.WHATSAPP_ACCESS_TOKEN,4000),id=clean(env.WHATSAPP_PHONE_NUMBER_ID),version=clean(env.META_GRAPH_VERSION,20);
  if(!token||!id||!version)return result(false,false,'credentials_missing');
  const fields='id,display_phone_number,verified_name,name_status,quality_rating';
  const x=await getJson(fetchImpl,`https://graph.facebook.com/${version}/${encodeURIComponent(id)}?fields=${fields}`,token);
  if(!x.ok)return result(true,false,`provider_http_${x.status}`);
  const numberMatch=clean(x.body?.id)===id&&digits(x.body?.display_phone_number)===PROJECT.officialWhatsappE164;
  const verifiedName=clean(x.body?.verified_name),nameStatus=clean(x.body?.name_status).toUpperCase();
  const brandMatch=verifiedName.toUpperCase()==='ZEVANORY';
  const nameUsable=['APPROVED','AVAILABLE_WITHOUT_REVIEW'].includes(nameStatus);
  const ok=numberMatch&&brandMatch&&nameUsable;
  const reason=!numberMatch?'number_identity_mismatch':!brandMatch?'brand_display_name_mismatch':!nameUsable?'brand_display_name_not_ready':'identity_match';
  return result(true,ok,reason,{provider_id:clean(x.body?.id),display_phone_number:digits(x.body?.display_phone_number),number_verified:numberMatch,verified_name:verifiedName,brand_name_verified:brandMatch,name_status:nameStatus,quality_rating:clean(x.body?.quality_rating)});
}

export async function verifyYouTubeIdentity({env=process.env,fetchImpl=globalThis.fetch}={}){
  const hasDirect=clean(env.YOUTUBE_OAUTH_ACCESS_TOKEN,4000);const hasRefresh=clean(env.YOUTUBE_OAUTH_CLIENT_ID)&&clean(env.YOUTUBE_OAUTH_CLIENT_SECRET,4000)&&clean(env.YOUTUBE_OAUTH_REFRESH_TOKEN,4000);
  if(!hasDirect&&!hasRefresh){
    try{const r=await fetchImpl(`https://www.youtube.com/feeds/videos.xml?channel_id=${EXPECTED_YOUTUBE_CHANNEL_ID}`,{signal:AbortSignal.timeout(10000)});const body=r.ok?await r.text():'';const channelOk=r.ok&&body.includes(`<yt:channelId>${EXPECTED_YOUTUBE_CHANNEL_ID}</yt:channelId>`);const title=(body.match(/<author>\s*<name>([^<]+)<\/name>/i)||[])[1]||'';const ok=channelOk&&clean(title).toUpperCase()==='ZEVANORY';return result(true,ok,ok?'identity_match_public_feed':r.ok?'identity_mismatch':'provider_http_'+r.status,{channel_id:channelOk?EXPECTED_YOUTUBE_CHANNEL_ID:'',title:clean(title),verification_mode:'public_provider_feed'});}catch{return result(true,false,'public_feed_unavailable',{verification_mode:'public_provider_feed'});}
  }
  let token;try{token=await resolveYouTubeAccessToken({env,fetchImpl});}catch(e){return result(true,false,clean(e?.message)||'oauth_failed');}
  const x=await getJson(fetchImpl,'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true',token);
  if(!x.ok)return result(true,false,`provider_http_${x.status}`);
  const channels=Array.isArray(x.body?.items)?x.body.items:[];const match=channels.find((item)=>clean(item?.id)===EXPECTED_YOUTUBE_CHANNEL_ID);
  return result(true,Boolean(match),match?'identity_match':'identity_mismatch',{channel_id:clean(match?.id),title:clean(match?.snippet?.title),verification_mode:'oauth_provider_api'});
}
export async function verifyTikTokIdentity({env=process.env,fetchImpl=globalThis.fetch}={}){
  const token=clean(env.TIKTOK_ACCESS_TOKEN,4000),expected=clean(env.TIKTOK_EXPECTED_USERNAME,200).replace(/^@/,'').toLowerCase();
  if(!token)return result(false,false,'credentials_missing');if(!expected)return result(false,false,'expected_username_missing');
  const r=await fetchImpl('https://open.tiktokapis.com/v2/post/publish/creator_info/query/',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json; charset=UTF-8'}});
  const body=await json(r);if(!r.ok||body?.error?.code!=='ok')return result(true,false,`provider_http_${r.status}`);
  const username=clean(body?.data?.creator_username,200).replace(/^@/,'');const ok=username.toLowerCase()===expected;
  return result(true,ok,ok?'identity_match':'identity_mismatch',{username,nickname:clean(body?.data?.creator_nickname,200)});
}

export async function verifyExternalChannelIdentities({env=process.env,fetchImpl=globalThis.fetch}={}){
  const [facebook,instagram,whatsapp,youtube,tiktok]=await Promise.all([
    verifyFacebookIdentity({env,fetchImpl}),verifyInstagramIdentity({env,fetchImpl}),verifyWhatsappIdentity({env,fetchImpl}),verifyYouTubeIdentity({env,fetchImpl}),verifyTikTokIdentity({env,fetchImpl}),
  ]);
  return Object.freeze({facebook,instagram,whatsapp,youtube,tiktok});
}

export const CANONICAL_EXTERNAL_IDENTITIES=Object.freeze({
  facebook_name:'ZEVANORY',instagram_username:'zevanory_',whatsapp_e164:PROJECT.officialWhatsappE164,youtube_channel_id:EXPECTED_YOUTUBE_CHANNEL_ID,
});
