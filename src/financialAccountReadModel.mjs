const ASAAS_PROD = 'https://api.asaas.com/v3';
const ASAAS_SANDBOX = 'https://api-sandbox.asaas.com/v3';
const MP_API = 'https://api.mercadopago.com';
const MP_IDENTITY_API = 'https://api.mercadolibre.com/users/me';

function integer(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function asaasBase(env) {
  return String(env.ASAAS_ENV || 'production').toLowerCase() === 'sandbox'
    ? ASAAS_SANDBOX
    : ASAAS_PROD;
}

async function fetchJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
  if (!response.ok) {
    const error = new Error(`provider_http_${response.status}`);
    error.statusCode = response.status;
    error.providerBody = body;
    throw error;
  }
  return body;
}
async function fetchJsonOptional404(fetchImpl,url,options) {
  const response=await fetchImpl(url,options);
  const text=await response.text();
  let body=null;try{body=text?JSON.parse(text):null;}catch{body={raw:text.slice(0,400)};}
  if(response.status===404)return null;
  if(!response.ok){const error=new Error(`provider_http_${response.status}`);error.statusCode=response.status;error.providerBody=body;throw error;}
  return body;
}
export function financialReadiness(env = process.env) {
  return Object.freeze({
    mode: 'read_only',
    movement_enabled: false,
    sales_gate_independent: true,
    asaas: Boolean(String(env.ASAAS_API_KEY || '').trim()),
    mercadopago: Boolean(String(env.MERCADOPAGO_ACCESS_TOKEN || '').trim()),
  });
}

export async function probeMercadoPagoCredential({ env = process.env, fetchImpl = fetch } = {}) {
  const token=String(env.MERCADOPAGO_ACCESS_TOKEN||'').trim();
  if(!token) return {provider:'mercadopago',configured:false,authenticated:false,status:null};
  try{
    const response=await fetchImpl(MP_IDENTITY_API,{method:'GET',headers:{authorization:`Bearer ${token}`,accept:'application/json'}});
    return {provider:'mercadopago',configured:true,authenticated:response.ok,status:response.status};
  }catch{
    return {provider:'mercadopago',configured:true,authenticated:false,status:null};
  }
}

export async function readAsaasAccount({ env = process.env, fetchImpl = fetch, limit = 25, offset = 0 } = {}) {
  const token = String(env.ASAAS_API_KEY || '').trim();
  if (!token) return { provider: 'asaas', configured: false, available: false };
  const headers = { access_token: token, accept: 'application/json', 'user-agent': 'ZEVANORY/financial-read' };
  const base = asaasBase(env);
  const pageLimit = integer(limit, 25, 1, 100);
  const pageOffset = integer(offset, 0, 0, 1000000);
  const [balance, statement] = await Promise.all([
    fetchJson(fetchImpl, `${base}/finance/balance`, { method: 'GET', headers }),
    fetchJson(fetchImpl, `${base}/financialTransactions?offset=${pageOffset}&limit=${pageLimit}`, { method: 'GET', headers }),
  ]);
  return {
    provider: 'asaas', configured: true, available: true, currency: 'BRL',
    balance: Number(balance?.balance ?? 0),
    statement: Array.isArray(statement?.data) ? statement.data : [],
    pagination: { offset: pageOffset, limit: pageLimit, has_more: Boolean(statement?.hasMore) },
    observed_at: new Date().toISOString(),
  };
}
export async function readMercadoPagoAccount({ env = process.env, fetchImpl = fetch } = {}) {
  const token = String(env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
  if (!token) return { provider: 'mercadopago', configured: false, available: false };
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const [config, reports] = await Promise.all([
    fetchJsonOptional404(fetchImpl, `${MP_API}/v1/account/settlement_report/config`, { method: 'GET', headers }),
    fetchJson(fetchImpl, `${MP_API}/v1/account/settlement_report/list`, { method: 'GET', headers }),
  ]);
  const normalizedReports = Array.isArray(reports) ? reports.slice(0, 25).map((report) => ({
    id: report?.id ?? null,
    begin_date: report?.begin_date ?? null,
    end_date: report?.end_date ?? null,
    file_name: report?.file_name ?? null,
    date_created: report?.date_created ?? null,
    created_from: report?.created_from ?? null,
  })) : [];
  return {
    provider: 'mercadopago', configured: true, available: true,
    account_money_report_configured: Boolean(config),
    latest_reports: normalizedReports,
    direct_balance_supported: false,
    balance_source: 'account_money_report',
    observed_at: new Date().toISOString(),
  };
}

export async function readFinancialAccounts(options = {}) {
  const settled = await Promise.allSettled([
    readAsaasAccount(options),
    readMercadoPagoAccount(options),
  ]);
  const providers = settled.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : { provider: index === 0 ? 'asaas' : 'mercadopago', configured: true, available: false, error: result.reason?.message || 'provider_unavailable' });
  return { mode: 'read_only', movement_enabled: false, providers, observed_at: new Date().toISOString() };
}

export async function ensureMercadoPagoReport({env=process.env,fetchImpl=fetch,beginDate,endDate}={}) {
  const token=String(env.MERCADOPAGO_ACCESS_TOKEN||'').trim();
  if(!token) return {provider:'mercadopago',configured:false,generated:false};
  const headers={authorization:`Bearer ${token}`,accept:'application/json','content-type':'application/json'};
  let config=await fetchJsonOptional404(fetchImpl,`${MP_API}/v1/account/settlement_report/config`,{method:'GET',headers});
  if(!config){
    const body={file_name_prefix:'zevanory-account-money',show_fee_prevision:false,show_chargeback_cancel:true,coupon_detailed:true,include_withdraw:true,shipping_detail:true,refund_detailed:true,display_timezone:'GMT-03',header_language:'pt',frequency:{hour:0,type:'monthly',value:1},columns:['TRANSACTION_DATE','SOURCE_ID','EXTERNAL_REFERENCE','TRANSACTION_TYPE','TRANSACTION_AMOUNT','TRANSACTION_CURRENCY','FEE_AMOUNT','SETTLEMENT_NET_AMOUNT','SETTLEMENT_CURRENCY','SETTLEMENT_DATE','REAL_AMOUNT','PAYMENT_METHOD_TYPE'].map(key=>({key}))};
    config=await fetchJson(fetchImpl,`${MP_API}/v1/account/settlement_report/config`,{method:'POST',headers,body:JSON.stringify(body)});
  }
  const report=await fetchJson(fetchImpl,`${MP_API}/v1/account/settlement_report`,{method:'POST',headers,body:JSON.stringify({begin_date:beginDate,end_date:endDate})});
  return {provider:'mercadopago',configured:true,generated:true,task_id:report?.task_id??report?.id??null,begin_date:beginDate,end_date:endDate};
}
