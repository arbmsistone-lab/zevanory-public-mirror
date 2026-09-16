import { ProviderDeliveryError } from './providerDelivery.mjs';
const clean=(v,max=8000)=>String(v??'').trim().slice(0,max);
const httpsUrl=(value)=>{try{const u=new URL(clean(value,3000));return u.protocol==='https:'?u.toString():'';}catch{return '';}};
const BUFFER_CHANNEL_KEYS=Object.freeze({facebook:'BUFFER_FACEBOOK_CHANNEL_ID',instagram:'BUFFER_INSTAGRAM_CHANNEL_ID',tiktok:'BUFFER_TIKTOK_CHANNEL_ID',youtube:'BUFFER_YOUTUBE_CHANNEL_ID',linkedin:'BUFFER_LINKEDIN_CHANNEL_ID'});
const channelKey=(channel)=>BUFFER_CHANNEL_KEYS[channel]||'';
const withLanding=(text,landing,max=5000)=>{const base=clean(text,max),url=httpsUrl(landing);return clean(url&&!base.includes(url)?`${base}\n\n${url}`:base,max);};
const inferAsset=(url,explicit='')=>{
  const kind=clean(explicit,20).toLowerCase();
  if(kind==='video'||kind==='image')return kind;
  const path=new URL(url).pathname.toLowerCase();
  if(/\.(mp4|mov|webm|m4v)$/.test(path))return 'video';
  if(/\.(jpg|jpeg|png|webp|gif)$/.test(path))return 'image';
  return '';
};

export async function publishViaBuffer({channel,event,env=process.env,fetchImpl=globalThis.fetch}={}){
  const key=channelKey(channel);if(!key)throw new Error('buffer_channel_unsupported');
  const token=clean(env.BUFFER_API_KEY,4000);if(!token)throw new Error('buffer_api_key_missing');
  const channelId=clean(env[key],300);if(!channelId)throw new Error(`buffer_${channel}_channel_id_missing`);
  const text=withLanding(event?.payload?.content||event?.payload?.text,event?.payload?.landing_url,5000);
  const media=httpsUrl(event?.payload?.media_url);
  if(['instagram','tiktok','youtube'].includes(channel)&&!media)throw new Error(`buffer_${channel}_media_required`);
  const input={text,channelId,schedulingType:'automatic',mode:'addToQueue'};
  if(media){const kind=inferAsset(media,event?.payload?.media_type);if(!kind)throw new Error('buffer_media_type_required');input.assets=[{[kind]:{url:media}}];}
  const query='mutation CreatePost($input: CreatePostInput!){createPost(input:$input){... on PostActionSuccess{post{id status dueAt}} ... on MutationError{message}}}';
  let response;
  try{response=await fetchImpl('https://api.buffer.com',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query,variables:{input}}),signal:AbortSignal.timeout(15000)});}
  catch{throw new ProviderDeliveryError('buffer_network_uncertain',{ambiguous:true,retryable:false});}
  const body=await response.json().catch(()=>({}));
  if(!response.ok){if(response.status>=500)throw new ProviderDeliveryError(`buffer_http_${response.status}`,{ambiguous:true,retryable:false,status:response.status});throw new Error(`buffer_http_${response.status}`);}
  const post=body?.data?.createPost?.post;
  if(!post?.id||!clean(post.status,80)||body?.errors?.length){
    // HTTP success is not proof that an effect did not occur. Never export provider text.
    throw new ProviderDeliveryError('buffer_acceptance_uncertain',{ambiguous:true,retryable:false});
  }
  return Object.freeze({provider:'buffer',accepted:true,provider_post_id:String(post.id),target_channel:channel,confirmation:'buffer_post_lifecycle',status:String(post.status)});
}
