import { fetchRemoteMedia } from './remoteMedia.mjs';
import { ProviderDeliveryError, providerAcceptanceMissing } from './providerDelivery.mjs';
const clean=(v,max=500)=>String(v||'').trim().slice(0,max);
const required=(v,code,max=500)=>{const x=clean(v,max);if(!x)throw new Error(code);return x;};
const httpsUrl=(v,code)=>{const x=required(v,code,2048);let u;try{u=new URL(x);}catch{throw new Error(code);}if(u.protocol!=='https:')throw new Error(code);return x;};
const json=async r=>{try{return await r.json();}catch{return {};}};
const withLanding=(text,landing,max)=>{const base=clean(text,max);let url='';try{const candidate=String(landing||'').trim();if(candidate){const u=new URL(candidate);if(u.protocol==='https:')url=u.toString();}}catch{}const joined=url&&!base.includes(url)?`${base}\n\n${url}`:base;return clean(joined,max);};
const publishRequest=async(fetchImpl,url,options)=>{
  let response;
  try{response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(15000)});}
  catch{throw new ProviderDeliveryError('social_publication_uncertain',{ambiguous:true,retryable:false});}
  if([408,425,429].includes(response.status)||response.status>=500)throw new ProviderDeliveryError(`social_publication_http_${response.status}`,{ambiguous:true,retryable:false,status:response.status});
  return response;
};

export async function publishTikTok({event,env=process.env,fetchImpl=globalThis.fetch,accessToken}={}){
  const token=required(accessToken||env.TIKTOK_ACCESS_TOKEN,'tiktok_access_token_missing');
  if(env.TIKTOK_CONTENT_SOURCE_VERIFIED!=='true')throw new Error('tiktok_content_source_unverified');
  const payload=event?.payload||{};
  if(payload.user_consent!==true)throw new Error('tiktok_user_consent_required');
  if(payload.music_usage_confirmation!==true)throw new Error('tiktok_music_usage_confirmation_required');
  const mediaUrl=httpsUrl(payload.media_url,'tiktok_media_url_required');
  const creator=await fetchImpl('https://open.tiktokapis.com/v2/post/publish/creator_info/query/',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json; charset=UTF-8'}});
  const creatorBody=await json(creator);if(creator.status!==200||creatorBody?.error?.code!=='ok')throw new Error(`tiktok_creator_http_${creator.status}`);
  const data=creatorBody?.data||{},options=Array.isArray(data.privacy_level_options)?data.privacy_level_options:[];
  const requested=required(payload.privacy_level,'tiktok_privacy_required',40);if(!options.includes(requested))throw new Error('tiktok_privacy_unavailable');
  const audited=env.TIKTOK_CLIENT_AUDITED==='true';if(!audited&&requested!=='SELF_ONLY')throw new Error('tiktok_unaudited_privacy_must_be_self_only');
  const duration=Number(payload.video_duration_sec);if(!Number.isFinite(duration)||duration<=0)throw new Error('tiktok_video_duration_required');
  const maxDuration=Number(data.max_video_post_duration_sec)||0;if(maxDuration>0&&duration>maxDuration)throw new Error('tiktok_video_duration_exceeds_creator_limit');
  const allowComment=payload.allow_comment===true,allowDuet=payload.allow_duet===true,allowStitch=payload.allow_stitch===true;
  if(allowComment&&data.comment_disabled)throw new Error('tiktok_comments_disabled_by_creator');
  if(allowDuet&&data.duet_disabled)throw new Error('tiktok_duet_disabled_by_creator');
  if(allowStitch&&data.stitch_disabled)throw new Error('tiktok_stitch_disabled_by_creator');
  const disclosure=payload.commercial_disclosure===true,brandOrganic=payload.brand_organic_toggle===true,brandContent=payload.brand_content_toggle===true;
  if(disclosure&&!brandOrganic&&!brandContent)throw new Error('tiktok_commercial_disclosure_choice_required');
  if(!disclosure&&(brandOrganic||brandContent))throw new Error('tiktok_commercial_disclosure_toggle_required');
  if(brandContent&&requested==='SELF_ONLY')throw new Error('tiktok_branded_content_private_forbidden');
  const postInfo={title:withLanding(payload.content||payload.title,payload.landing_url,2200),privacy_level:requested,disable_duet:!allowDuet,disable_comment:!allowComment,disable_stitch:!allowStitch,brand_content_toggle:brandContent,brand_organic_toggle:brandOrganic,is_aigc:payload.is_aigc===true};
  const body={post_info:postInfo,source_info:{source:'PULL_FROM_URL',video_url:mediaUrl}};
  const init=await publishRequest(fetchImpl,'https://open.tiktokapis.com/v2/post/publish/video/init/',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json; charset=UTF-8'},body:JSON.stringify(body)});
  const initBody=await json(init);if(init.status!==200||initBody?.error?.code!=='ok')throw new Error(`tiktok_publish_http_${init.status}`);
  const publishId=clean(initBody?.data?.publish_id,300);if(!publishId)throw providerAcceptanceMissing('tiktok_publish_id_missing');
  return Object.freeze({provider:'tiktok',accepted:true,provider_post_id:publishId,privacy_level:requested,confirmation:'provider_lookup_required'});
}

export async function fetchTikTokPostStatus({publishId,accessToken,fetchImpl=globalThis.fetch}={}){
  const token=required(accessToken,'tiktok_access_token_missing'),id=required(publishId,'tiktok_publish_id_missing',300);
  const response=await fetchImpl('https://open.tiktokapis.com/v2/post/publish/status/fetch/',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json; charset=UTF-8'},body:JSON.stringify({publish_id:id}),signal:AbortSignal.timeout(15000)});
  const body=await json(response);if(response.status!==200||body?.error?.code!=='ok')throw new Error(`tiktok_status_http_${response.status}`);
  return Object.freeze({status:clean(body?.data?.status,80),fail_reason:clean(body?.data?.fail_reason,300)||null,post_ids:Array.isArray(body?.data?.publicaly_available_post_id)?body.data.publicaly_available_post_id.map(String):[]});
}

export async function publishLinkedIn({event,env=process.env,fetchImpl=globalThis.fetch,accessToken,authorUrn}={}){
  const token=required(accessToken||env.LINKEDIN_ACCESS_TOKEN,'linkedin_access_token_missing');
  const author=required(authorUrn||env.LINKEDIN_AUTHOR_URN,'linkedin_author_urn_missing');
  if(!/^urn:li:(organization|person):/.test(author))throw new Error('linkedin_author_urn_invalid');
  const version=required(env.LINKEDIN_VERSION,'linkedin_version_missing',16);if(!/^20\d{4}$/.test(version))throw new Error('linkedin_version_invalid');
  const commentary=required(withLanding(event?.payload?.content,event?.payload?.landing_url,3000),'linkedin_content_missing',3000);
  let content;const mediaUrl=clean(event?.payload?.media_url,3000);
  if(mediaUrl){const init=await fetchImpl('https://api.linkedin.com/rest/images?action=initializeUpload',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-restli-protocol-version':'2.0.0','linkedin-version':version},body:JSON.stringify({initializeUploadRequest:{owner:author}})});const initBody=await json(init);if(init.status!==200)throw new Error(`linkedin_image_init_http_${init.status}`);const uploadUrl=httpsUrl(initBody?.value?.uploadUrl,'linkedin_image_upload_url_missing');const imageUrn=required(initBody?.value?.image,'linkedin_image_urn_missing',500);const media=await fetchRemoteMedia({url:mediaUrl,fetchImpl,acceptedTypes:['image/']});const uploaded=await fetchImpl(uploadUrl,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':media.type},body:media.bytes});if(![200,201].includes(uploaded.status))throw new Error(`linkedin_image_upload_http_${uploaded.status}`);content={media:{id:imageUrn,altText:clean(event?.payload?.title||'ZEVANORY',200)}};}
  const body={author,commentary,visibility:'PUBLIC',distribution:{feedDistribution:'MAIN_FEED',targetEntities:[],thirdPartyDistributionChannels:[]},lifecycleState:'PUBLISHED',isReshareDisabledByAuthor:false,...(content?{content}:{})};
  const response=await publishRequest(fetchImpl,'https://api.linkedin.com/rest/posts',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-restli-protocol-version':'2.0.0','linkedin-version':version},body:JSON.stringify(body)});
  if(response.status!==201){await json(response);throw new Error(`linkedin_post_http_${response.status}`);}
  const id=clean(response.headers?.get?.('x-restli-id'),300);if(!id)throw providerAcceptanceMissing('linkedin_post_id_missing');
  return Object.freeze({provider:'linkedin',accepted:true,provider_post_id:id,confirmation:'provider_lookup_required'});
}
