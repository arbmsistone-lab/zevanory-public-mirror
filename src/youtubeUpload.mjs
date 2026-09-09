const GOOGLE_UPLOAD='https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const GOOGLE_TOKEN='https://oauth2.googleapis.com/token';
const CHUNK_BYTES=4*1024*1024;
const MAX_CHUNKS_PER_RUN=8;
const clean=(v,max=500)=>String(v||'').trim().slice(0,max);
const required=(v,code)=>{const s=clean(v);if(!s)throw new Error(code);return s;};
const httpsUrl=(v,code)=>{const s=required(v,code);let u;try{u=new URL(s);}catch{throw new Error(code);}if(u.protocol!=='https:')throw new Error(code);return s;};
const json=async r=>{try{return await r.json();}catch{return {};}};
const okStatus=(s,list)=>list.includes(Number(s));
const parseRangeEnd=(value)=>{const m=/bytes=0-(\d+)/i.exec(String(value||''));return m?Number(m[1]):null;};
const safePrivacy=(v)=>['private','unlisted','public'].includes(String(v||'').toLowerCase())?String(v).toLowerCase():'private';

export async function resolveYouTubeAccessToken({env=process.env,fetchImpl=globalThis.fetch}={}){
  const direct=clean(env.YOUTUBE_OAUTH_ACCESS_TOKEN,4000);if(direct)return direct;
  const clientId=required(env.YOUTUBE_OAUTH_CLIENT_ID,'youtube_oauth_client_id_missing');
  const clientSecret=required(env.YOUTUBE_OAUTH_CLIENT_SECRET,'youtube_oauth_client_secret_missing');
  const refreshToken=required(env.YOUTUBE_OAUTH_REFRESH_TOKEN,'youtube_oauth_refresh_token_missing');
  const body=new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'});
  const response=await fetchImpl(GOOGLE_TOKEN,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  const data=await json(response);if(!response.ok)throw new Error(`youtube_oauth_refresh_${response.status}`);
  return required(data.access_token,'youtube_access_token_missing');
}

export async function inspectRemoteVideo({url,fetchImpl=globalThis.fetch}={}){
  const mediaUrl=httpsUrl(url,'youtube_media_url_required');
  let response=await fetchImpl(mediaUrl,{method:'HEAD',redirect:'follow'});
  let size=Number(response.headers.get('content-length'));let mime=clean(response.headers.get('content-type'),120).split(';')[0].toLowerCase();
  if(!response.ok||!Number.isFinite(size)||size<=0||!(mime.startsWith('video/')||mime==='application/octet-stream')){
    response=await fetchImpl(mediaUrl,{method:'GET',headers:{range:'bytes=0-0'},redirect:'follow'});
    if(!response.ok)throw new Error(`youtube_media_probe_${response.status}`);
    mime=clean(response.headers.get('content-type'),120).split(';')[0].toLowerCase();if(!(mime.startsWith('video/')||mime==='application/octet-stream'))throw new Error('youtube_media_type_invalid');
    const contentRange=String(response.headers.get('content-range')||'');const match=/\/(\d+)$/.exec(contentRange);
    if(match)size=Number(match[1]);else{const bytes=Buffer.from(await response.arrayBuffer());size=bytes.length;}
  }
  if(!Number.isFinite(size)||size<=0)throw new Error('youtube_media_size_missing');
  return Object.freeze({url:mediaUrl,size,mime});
}
export async function createYouTubeUploadSession({accessToken,video,title,description='',privacyStatus='private',madeForKids=false,fetchImpl=globalThis.fetch}={}){
  const metadata={snippet:{title:required(title,'youtube_title_missing').slice(0,100),description:clean(description,5000),categoryId:'28'},status:{privacyStatus:safePrivacy(privacyStatus),selfDeclaredMadeForKids:Boolean(madeForKids)}};
  const response=await fetchImpl(GOOGLE_UPLOAD,{method:'POST',headers:{authorization:`Bearer ${required(accessToken,'youtube_access_token_missing')}`,'content-type':'application/json; charset=UTF-8','x-upload-content-length':String(video.size),'x-upload-content-type':video.mime},body:JSON.stringify(metadata)});
  if(!okStatus(response.status,[200]))throw new Error(`youtube_session_${response.status}`);
  const location=httpsUrl(response.headers.get('location'),'youtube_session_location_missing');
  return Object.freeze({session_url:location,uploaded_bytes:0,total_bytes:video.size,mime:video.mime,media_url:video.url,privacy_status:metadata.status.privacyStatus,title:metadata.snippet.title});
}

export async function queryYouTubeUploadProgress({sessionUrl,totalBytes,accessToken,fetchImpl=globalThis.fetch}={}){
  const response=await fetchImpl(httpsUrl(sessionUrl,'youtube_session_url_invalid'),{method:'PUT',headers:{authorization:`Bearer ${required(accessToken,'youtube_access_token_missing')}`,'content-length':'0','content-range':`bytes */${Number(totalBytes)}`}});
  if(response.status===308){const end=parseRangeEnd(response.headers.get('range'));return Object.freeze({complete:false,uploaded_bytes:end===null?0:end+1});}
  if(okStatus(response.status,[200,201])){const data=await json(response);return Object.freeze({complete:true,uploaded_bytes:Number(totalBytes),video_id:clean(data.id,200)});}
  if(response.status===404)throw new Error('youtube_session_expired_manual_reconcile');
  throw new Error(`youtube_progress_${response.status}`);
}

async function persistUploadState(sql,eventId,state){
  if(!sql?.query)return;
  const payload=JSON.stringify({youtube_upload:state});
  await sql.query("update integration_outbox set headers=coalesce(headers,'{}'::jsonb)||$2::jsonb where event_id=$1",[eventId,payload]);
}
export async function uploadYouTubeFromRemote({event,sql,env=process.env,fetchImpl=globalThis.fetch}={}){
  const accessToken=await resolveYouTubeAccessToken({env,fetchImpl});
  let state=event?.headers?.youtube_upload||null;
  if(!state){
    const video=await inspectRemoteVideo({url:event?.payload?.media_url,fetchImpl});
    state=await createYouTubeUploadSession({accessToken,video,title:event?.payload?.title||event?.payload?.content,description:event?.payload?.description||event?.payload?.content,privacyStatus:event?.payload?.privacy_status||env.YOUTUBE_PRIVACY_STATUS||'private',madeForKids:event?.payload?.made_for_kids===true,fetchImpl});
    await persistUploadState(sql,event.event_id,state);
  }else{
    const progress=await queryYouTubeUploadProgress({sessionUrl:state.session_url,totalBytes:state.total_bytes,accessToken,fetchImpl});
    if(progress.complete)return Object.freeze({provider:'youtube',accepted:true,provider_media_id:required(progress.video_id,'youtube_video_id_missing'),confirmation:'provider_lookup_required'});
    state={...state,uploaded_bytes:progress.uploaded_bytes};
  }
  let chunks=0;
  while(Number(state.uploaded_bytes)<Number(state.total_bytes)&&chunks<MAX_CHUNKS_PER_RUN){
    const start=Number(state.uploaded_bytes),end=Math.min(start+CHUNK_BYTES,Number(state.total_bytes))-1;
    const source=await fetchImpl(httpsUrl(state.media_url,'youtube_media_url_required'),{headers:{range:`bytes=${start}-${end}`},redirect:'follow'});
    const expected=end-start+1;
    if(!(source.status===206||(start===0&&expected===Number(state.total_bytes)&&source.status===200)))throw new Error(`youtube_media_range_${source.status}`);
    const bytes=Buffer.from(await source.arrayBuffer());if(bytes.length!==expected)throw new Error('youtube_media_range_length_mismatch');
    const upload=await fetchImpl(state.session_url,{method:'PUT',headers:{authorization:`Bearer ${accessToken}`,'content-type':state.mime,'content-length':String(bytes.length),'content-range':`bytes ${start}-${end}/${state.total_bytes}`},body:bytes});
    if(upload.status===308){const remoteEnd=parseRangeEnd(upload.headers.get('range'));state={...state,uploaded_bytes:remoteEnd===null?end+1:remoteEnd+1};await persistUploadState(sql,event.event_id,state);chunks+=1;continue;}
    if(okStatus(upload.status,[200,201])){const data=await json(upload);const id=required(data.id,'youtube_video_id_missing');await persistUploadState(sql,event.event_id,{...state,uploaded_bytes:state.total_bytes,complete:true,video_id:id});return Object.freeze({provider:'youtube',accepted:true,provider_media_id:id,privacy_status:state.privacy_status,confirmation:'provider_lookup_required'});}
    if(upload.status===404)throw new Error('youtube_session_expired_manual_reconcile');
    throw new Error(`youtube_upload_${upload.status}`);
  }
  throw new Error('youtube_upload_incomplete_resume_required');
}
