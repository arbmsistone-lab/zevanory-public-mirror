const TRANSIENT_STATUS=new Set([408,425,429,500,502,503,504]);
const IDEMPOTENT_DESTINATIONS=new Set(['channel:email','channel:affiliate']);

export class ProviderDeliveryError extends Error{
  constructor(code,{ambiguous=false,retryable=false,status=null}={}){
    super(code);this.name='ProviderDeliveryError';this.code=code;
    this.ambiguous=Boolean(ambiguous);this.retryable=Boolean(retryable);this.status=status;
  }
}

export function destinationAllowsAutomaticReplay(destination){
  return IDEMPOTENT_DESTINATIONS.has(String(destination||''));
}

function headerValue(headers,name){
  const target=String(name).toLowerCase();
  if(headers instanceof Headers)return headers.get(name)||'';
  for(const [key,value] of Object.entries(headers||{}))if(String(key).toLowerCase()===target)return String(value||'');
  return '';
}

export async function requestProviderJson(fetchImpl,url,options={},success=[200],{timeoutMs=15000}={}){
  const method=String(options.method||'GET').toUpperCase();
  const mutation=!['GET','HEAD','OPTIONS'].includes(method);
  const hasIdempotency=Boolean(headerValue(options.headers,'idempotency-key')||headerValue(options.headers,'x-idempotency-key'));
  let response;
  try{
    response=await fetchImpl(url,{...options,signal:options.signal||AbortSignal.timeout(timeoutMs)});
  }catch(error){
    const timeout=error?.name==='TimeoutError'||error?.name==='AbortError';
    throw new ProviderDeliveryError(timeout?'provider_timeout':'provider_network_uncertain',{
      ambiguous:mutation,retryable:!mutation||hasIdempotency,
    });
  }
  let body={};
  try{body=await response.json();}catch{}
  if(success.includes(response.status))return body;
  if(TRANSIENT_STATUS.has(response.status)){
    throw new ProviderDeliveryError(`provider_http_${response.status}`,{
      ambiguous:mutation,
      retryable:!mutation||hasIdempotency,
      status:response.status,
    });
  }
  throw new ProviderDeliveryError(`provider_http_${response.status}`,{
    ambiguous:false,retryable:false,status:response.status,
  });
}

export function providerAcceptanceMissing(code='provider_acceptance_missing'){
  return new ProviderDeliveryError(code,{ambiguous:true,retryable:false});
}

export function classifyDeliveryFailure(error,destination){
  if(error instanceof ProviderDeliveryError||String(error?.code||'').startsWith('provider_')){
    if(error.retryable)return Object.freeze({status:'retry',reason:String(error.code||error.message||'provider_retryable')});
    return Object.freeze({status:'dead_letter',reason:error.ambiguous?'provider_delivery_uncertain_manual_reconciliation':String(error.code||error.message||'provider_failed')});
  }
  if(!destinationAllowsAutomaticReplay(destination)){
    return Object.freeze({status:'dead_letter',reason:'provider_delivery_uncertain_manual_reconciliation'});
  }
  return Object.freeze({status:'retry',reason:String(error?.message||'delivery_failed').slice(0,500)});
}
