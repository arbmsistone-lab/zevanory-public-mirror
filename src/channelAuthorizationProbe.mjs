import { loadTikTokCredential } from './tiktokOAuth.mjs';
import { loadLinkedInCredential } from './linkedinOAuth.mjs';
import { loadNuvemshopCredential } from './nuvemshopOAuth.mjs';

const scopes=value=>String(value||'').split(/[\s,]+/).filter(Boolean);
const host=value=>{try{return new URL(String(value)).hostname.toLowerCase();}catch{return '';}};
const headers=token=>({authorization:`Bearer ${token}`,'content-type':'application/json','user-agent':'ZEVANORY https://zevanory.api.br'});
const safeCode=(error)=>/^(tiktok|linkedin|nuvemshop)_[a-z0-9_]+$/.test(String(error?.message))?error.message:'authorization_probe_unavailable';

// Read-only requests only. Authorization/capability evidence is not execution evidence.
export async function probeChannelAuthorizations(sql,{env=process.env,fetchImpl=globalThis.fetch,now=Date.now()}={}){
  const result={schema:'zevanory-channel-authorization-probe-v1',observed_at:new Date(now).toISOString(),read_only:true,fronts:{}};
  async function get(url,options={}){
    const response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(10000),redirect:'error'});
    if(response.status!==200)throw new Error(`authorization_probe_http_${response.status}`);
    const body=await response.json();return body;
  }
  for(const provider of ['tiktok','linkedin','nuvemshop']){
    const row={authorization_ready:false,identity_ready:false,capability_ready:false,automation_proven:false,execution_proof:'not_performed_read_only_probe',blockers:[]};
    result.fronts[provider]=row;
    try{
      if(provider==='tiktok'){
        const c=await loadTikTokCredential(sql,env,{mode:'production'});
        if(!Number.isFinite(new Date(c.expires_at).getTime())||new Date(c.expires_at).getTime()<=now)throw new Error('tiktok_token_expired');
        if(!scopes(c.scope).includes('video.publish'))throw new Error('tiktok_video_publish_scope_missing');
        const body=await get('https://open.tiktokapis.com/v2/post/publish/creator_info/query/',{method:'POST',headers:headers(c.access_token)});
        if(body?.error?.code!=='ok')throw new Error('tiktok_provider_authorization_rejected');
        row.authorization_ready=true;
        const expected=String(env.TIKTOK_EXPECTED_USERNAME||'').replace(/^@/,'').toLowerCase();
        row.identity_ready=Boolean(expected)&&String(body.data?.creator_username||'').toLowerCase()===expected;
        row.capability_ready=row.identity_ready&&Array.isArray(body.data?.privacy_level_options)&&body.data.privacy_level_options.length>0;
      }else if(provider==='linkedin'){
        const c=await loadLinkedInCredential(sql,env);
        if(!env.LINKEDIN_CLIENT_ID||!env.LINKEDIN_CLIENT_SECRET)throw new Error('linkedin_oauth_config_missing');
        const token=await get('https://www.linkedin.com/oauth/v2/introspectToken',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.LINKEDIN_CLIENT_ID,client_secret:env.LINKEDIN_CLIENT_SECRET,token:c.access_token})});
        if(token.active!==true||token.client_id!==env.LINKEDIN_CLIENT_ID||Number(token.expires_at)*1000<=now||!Number.isFinite(Number(token.expires_at)))throw new Error('linkedin_token_not_active');
        row.authorization_ready=true;
        const profile=await get('https://api.linkedin.com/v2/userinfo',{headers:headers(c.access_token)});
        row.identity_ready=String(profile.sub||'')===String(c.account_id)&&Boolean(env.LINKEDIN_EXPECTED_AUTHOR_URN)&&c.author_urn===env.LINKEDIN_EXPECTED_AUTHOR_URN;
        row.capability_ready=row.identity_ready&&scopes(token.scope).includes('w_member_social');
      }else{
        const c=await loadNuvemshopCredential(sql,env);
        if(!/^\d+$/.test(c.store_id))throw new Error('nuvemshop_store_id_invalid');
        const base=`https://api.nuvemshop.com.br/v1/${c.store_id}`;
        const store=await get(base+'/store',{headers:headers(c.access_token)});
        row.authorization_ready=String(store.id)===c.store_id;
        const expected=host(env.NUVEMSHOP_STOREFRONT_URL);
        const domains=Array.isArray(store.domains)?store.domains:[];
        row.identity_ready=row.authorization_ready&&Boolean(expected)&&domains.some(d=>host(/^https?:/.test(String(d))?d:`https://${d}`)===expected);
        const products=await get(base+'/products?per_page=1',{headers:headers(c.access_token)});
        row.capability_ready=row.identity_ready&&Array.isArray(products)&&scopes(c.scope).includes('write_products');
        const hooks=await get(base+'/webhooks?per_page=200',{headers:headers(c.access_token)});
        const expectedHook='https://zevanory.api.br/api/webhooks?provider=nuvemshop';
        row.webhook_registration_verified=Array.isArray(hooks)&&hooks.some(h=>h.url===expectedHook&&h.event==='product/created');
        row.webhook_delivery_proven=false;
        row.nubesdk_live_proven=false;
        row.blockers.push('webhook_delivery_not_proven','nubesdk_execution_not_proven');
      }
      if(!row.identity_ready)row.blockers.push('expected_identity_not_verified');
      if(!row.capability_ready)row.blockers.push('required_capability_not_verified');
    }catch(error){row.blockers.push(safeCode(error));}
    row.blockers.push('real_execution_not_proven');
  }
  return result;
}
