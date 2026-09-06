const clean=(v,max=8000)=>String(v??'').trim().slice(0,max);
const httpsUrl=(value)=>{try{const u=new URL(clean(value,3000));return u.protocol==='https:'?u.toString():'';}catch{return '';}};
const channelKey=(channel)=>channel==='tiktok'?'BUFFER_TIKTOK_CHANNEL_ID':channel==='linkedin'?'BUFFER_LINKEDIN_CHANNEL_ID':'';
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
  const text=clean(event?.payload?.content||event?.payload?.text,5000);
  const media=httpsUrl(event?.payload?.media_url);
  if(channel==='tiktok'&&!media)throw new Error('buffer_tiktok_media_required');
  const input={text,channelId,schedulingType:'automatic',mode:'addToQueue'};
  if(media){const kind=inferAsset(media,event?.payload?.media_type);if(!kind)throw new Error('buffer_media_type_required');input.assets=[{[kind]:{url:media}}];}
  const query='mutation CreatePost($input: CreatePostInput!){createPost(input:$input){... on PostActionSuccess{post{id status dueAt}} ... on MutationError{message}}}';
  const response=await fetchImpl('https://api.buffer.com',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query,variables:{input}})});
  const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`buffer_http_${response.status}`);
  const post=body?.data?.createPost?.post;if(!post?.id){const msg=clean(body?.data?.createPost?.message||body?.errors?.[0]?.message,300);throw new Error(msg?`buffer_create_post_failed:${msg}`:'buffer_post_id_missing');}
  return Object.freeze({provider:'buffer',accepted:true,provider_post_id:String(post.id),target_channel:channel,confirmation:'buffer_post_lifecycle',status:String(post.status||'scheduled')});
}
