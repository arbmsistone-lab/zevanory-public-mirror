const clean=(v,max=500)=>String(v||'').trim().slice(0,max);
const required=(v,code,max=500)=>{const x=clean(v,max);if(!x)throw new Error(code);return x;};
const httpsUrl=(v,code)=>{const x=required(v,code,2048);let u;try{u=new URL(x);}catch{throw new Error(code);}if(u.protocol!=='https:')throw new Error(code);return x;};
const json=async r=>{try{return await r.json();}catch{return {};}};
const withLanding=(text,landing,max)=>{const base=clean(text,max);let url='';try{const candidate=String(landing||'').trim();if(candidate){const u=new URL(candidate);if(u.protocol==='https:')url=u.toString();}}catch{}const joined=url&&!base.includes(url)?`${base}\n\n${url}`:base;return clean(joined,max);};

export async function publishTikTok({event,env=process.env,fetchImpl=globalThis.fetch,accessToken}={}){
  const token=required(accessToken||env.TIKTOK_ACCESS_TOKEN,'tiktok_access_token_missing');
  if(env.TIKTOK_CONTENT_SOURCE_VERIFIED!=='true')throw new Error('tiktok_content_source_unverified');
  if(event?.payload?.user_consent!==true)throw new Error('tiktok_user_consent_required');
  const mediaUrl=httpsUrl(event?.payload?.media_url,'tiktok_media_url_required');
  const creator=await fetchImpl('https://open.tiktokapis.com/v2/post/publish/creator_info/query/',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json; charset=UTF-8'}});
  const creatorBody=await json(creator);if(creator.status!==200||creatorBody?.error?.code!=='ok')throw new Error(`tiktok_creator_http_${creator.status}`);
  const options=creatorBody?.data?.privacy_level_options||[];
  const audited=env.TIKTOK_CLIENT_AUDITED==='true';
  const requested=clean(event?.payload?.privacy_level,40)||'SELF_ONLY';
  const privacy=audited&&options.includes(requested)?requested:'SELF_ONLY';
  if(!options.includes(privacy))throw new Error('tiktok_privacy_unavailable');
  const body={post_info:{title:withLanding(event?.payload?.content||event?.payload?.title,event?.payload?.landing_url,2200),privacy_level:privacy,disable_duet:true,disable_comment:false,disable_stitch:true},source_info:{source:'PULL_FROM_URL',video_url:mediaUrl}};
  const init=await fetchImpl('https://open.tiktokapis.com/v2/post/publish/video/init/',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json; charset=UTF-8'},body:JSON.stringify(body)});
  const initBody=await json(init);if(init.status!==200||initBody?.error?.code!=='ok')throw new Error(`tiktok_publish_http_${init.status}`);
  const publishId=clean(initBody?.data?.publish_id,300);if(!publishId)throw new Error('tiktok_publish_id_missing');
  return Object.freeze({provider:'tiktok',accepted:true,provider_post_id:publishId,privacy_level:privacy,confirmation:'provider_lookup_required'});
}

export async function publishLinkedIn({event,env=process.env,fetchImpl=globalThis.fetch,accessToken,authorUrn}={}){
  const token=required(accessToken||env.LINKEDIN_ACCESS_TOKEN,'linkedin_access_token_missing');
  const author=required(authorUrn||env.LINKEDIN_AUTHOR_URN,'linkedin_author_urn_missing');
  if(!/^urn:li:(organization|person):/.test(author))throw new Error('linkedin_author_urn_invalid');
  const version=required(env.LINKEDIN_VERSION,'linkedin_version_missing',16);if(!/^20\d{4}$/.test(version))throw new Error('linkedin_version_invalid');
  const commentary=required(withLanding(event?.payload?.content,event?.payload?.landing_url,3000),'linkedin_content_missing',3000);
  const body={author,commentary,visibility:'PUBLIC',distribution:{feedDistribution:'MAIN_FEED',targetEntities:[],thirdPartyDistributionChannels:[]},lifecycleState:'PUBLISHED',isReshareDisabledByAuthor:false};
  const response=await fetchImpl('https://api.linkedin.com/rest/posts',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-restli-protocol-version':'2.0.0','linkedin-version':version},body:JSON.stringify(body)});
  if(response.status!==201){await json(response);throw new Error(`linkedin_post_http_${response.status}`);}
  const id=clean(response.headers?.get?.('x-restli-id'),300);if(!id)throw new Error('linkedin_post_id_missing');
  return Object.freeze({provider:'linkedin',accepted:true,provider_post_id:id,confirmation:'provider_lookup_required'});
}
