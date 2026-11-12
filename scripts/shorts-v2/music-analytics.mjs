// Only GET requests to Analytics; never create groups, change video metadata or scopes.
export async function retentionWindow(token,start,end,publications,{fetchImpl=fetch}={}){
 if(!token)return {status:'sem_dados',reason:'analytics_token_missing',start,end,rows:[]};
 const all=[];try{for(let index=1;index<=5000;index+=200){
  const u=new URL('https://youtubeanalytics.googleapis.com/v2/reports');for(const [k,v] of Object.entries({ids:'channel==MINE',startDate:start,endDate:end,metrics:'views,averageViewPercentage',dimensions:'video',maxResults:'200',startIndex:String(index)}))u.searchParams.set(k,v);
  const r=await fetchImpl(u.href,{method:'GET',headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('http_'+r.status);
  const b=await r.json(),names=b.columnHeaders?.map(x=>x.name);if(!names||!['video','views','averageViewPercentage'].every(x=>names.includes(x))||!Array.isArray(b.rows||[]))throw Error('response_shape');
  for(const row of b.rows||[]){const video_id=row[names.indexOf('video')],views=row[names.indexOf('views')],retention=row[names.indexOf('averageViewPercentage')];if(typeof video_id!=='string'||!Number.isFinite(views)||views<0||!Number.isFinite(retention)||retention<0)throw Error('metric_invalid');if(views>0)all.push({video_id,views,retention,arquivo:publications.find(p=>p.video_id===video_id)?.arquivo});}
  if((b.rows||[]).length<200)return {status:all.length?'verified':'sem_dados',start,end,rows:all};
 }throw Error('pagination_incomplete');}catch(e){return {status:'sem_dados',reason:'analytics_'+String(e.message).replace(/[^a-z0-9_]/gi,'_').slice(0,70),start,end,rows:[]};}
}
