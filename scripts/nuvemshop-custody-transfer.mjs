import { pathToFileURL } from 'node:url';

export const NUVEMSHOP_CUSTODY_ACCOUNT='1b26415802588185a86c1d4d3ebf5bdb';
export const NUVEMSHOP_CUSTODY_PROJECT='prj_phU0b7cWKwwH1IqJnQv0JjZ1Ehdm';
const keys=Object.freeze(['NUVEMSHOP_APP_ID','NUVEMSHOP_CLIENT_SECRET','COMMERCIAL_OAUTH_ENCRYPTION_KEY']);

// Maintenance only: no HTTP endpoint, public alias promotion, regenerated key, or secret output.
export async function transferNuvemshopCustody({env=process.env,fetchImpl=globalThis.fetch}={}) {
  if(env.VERCEL_ENV!=='production'||env.VERCEL_PROJECT_ID!==NUVEMSHOP_CUSTODY_PROJECT)throw new Error('nuvemshop_custody_identity_invalid');
  if(env.ZEVANORY_NUVEMSHOP_CUSTODY_TRANSFER!=='YES'||!env.ZEVANORY_CUSTODY_CF_TOKEN)throw new Error('nuvemshop_custody_transfer_env_missing');
  if(String(env.NUVEMSHOP_APP_ID)!=='41672')throw new Error('nuvemshop_custody_app_id_invalid');
  if(!env.NUVEMSHOP_CLIENT_SECRET)throw new Error('nuvemshop_custody_client_secret_missing');
  if(Buffer.from(String(env.COMMERCIAL_OAUTH_ENCRYPTION_KEY||''),'base64').length!==32)throw new Error('nuvemshop_custody_encryption_key_invalid');
  const base='https://api.cloudflare.com/client/v4/accounts/'+NUVEMSHOP_CUSTODY_ACCOUNT+'/workers/scripts/zevanory';
  const headers={authorization:'Bearer '+env.ZEVANORY_CUSTODY_CF_TOKEN,'content-type':'application/json'};
  const preflight=await fetchImpl(base+'/settings',{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  const settings=await preflight.json().catch(()=>({}));
  if(!preflight.ok||settings.success!==true)throw new Error('nuvemshop_custody_target_unverified');
  const bindings=settings.result?.bindings||[];
  for(const name of ['SALE_GLOBALLY_ENABLED','CHECKOUT_ENABLED','FINANCIAL_EVENTS_ENABLED'])if(!bindings.some(b=>b.name===name&&String(b.text)==='false'))throw new Error('nuvemshop_custody_sales_guard_invalid');
  for(const name of keys){
    const response=await fetchImpl(base+'/secrets',{method:'PUT',headers,redirect:'error',signal:AbortSignal.timeout(15000),body:JSON.stringify({name,type:'secret_text',text:env[name]})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.success!==true)throw new Error('nuvemshop_custody_write_'+name.toLowerCase()+'_http_'+response.status+'_code_'+(Number(result.errors?.[0]?.code)||0));
  }
  const verify=await fetchImpl(base+'/secrets',{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  const listed=await verify.json().catch(()=>({}));
  if(!verify.ok||listed.success!==true||!keys.every(name=>(listed.result||[]).some(s=>s.name===name&&s.type==='secret_text')))throw new Error('nuvemshop_custody_verification_failed');
  return Object.freeze({ok:true,worker:'zevanory',unchanged_key:true,transferred:[...keys],sales_enabled:false});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await transferNuvemshopCustody()));}
  catch(error){console.error(/^nuvemshop_custody_[a-z0-9_]+$/.test(String(error?.message))?error.message:'nuvemshop_custody_transfer_failed');process.exitCode=1;}
}
