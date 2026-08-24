import { asaasBaseUrl, parseExternalReference } from './asaas.mjs';

export function recoveryDiagnosticReady({env,apiKey,databaseUrl}={}) {
  return String(env||'').toLowerCase()==='sandbox' && Boolean(apiKey) && Boolean(databaseUrl);
}

export async function listAsaasPaymentsByExternalReference(externalReference,apiKey,fetchImpl=fetch) {
  const base=asaasBaseUrl('sandbox');
  const ref=String(externalReference||'');
  if(!base || !apiKey || !parseExternalReference(ref)) throw new Error('recovery_lookup_invalid');
  const url=new URL(`${base}/payments`);
  url.searchParams.set('externalReference',ref);
  url.searchParams.set('limit','10');
  const response=await fetchImpl(url,{method:'GET',headers:{accept:'application/json',access_token:apiKey}});
  if(!response.ok) throw new Error(`recovery_lookup_${response.status}`);
  const body=await response.json();
  if(!body || !Array.isArray(body.data)) throw new Error('recovery_lookup_shape_invalid');
  return body.data;
}
export function summarizeUncertainRecovery(order,payments) {
  const orderId=String(order?.order_id||'').toLowerCase();
  const externalReference=String(order?.external_reference||'');
  if(!orderId || parseExternalReference(externalReference)!==orderId || !Array.isArray(payments)) {
    return Object.freeze({order_id:orderId||null,result:'invalid_local_order'});
  }
  const matches=payments.filter((payment)=>String(payment?.externalReference||'')===externalReference);
  const statuses=[...new Set(matches.map((payment)=>String(payment?.status||'UNKNOWN')))];
  return Object.freeze({
    order_id:orderId,
    result:matches.length?'provider_records_found':'provider_record_not_found',
    provider_matches:matches.length,
    provider_statuses:Object.freeze(statuses),
  });
}
