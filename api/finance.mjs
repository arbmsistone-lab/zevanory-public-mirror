import { safeBearerEqual } from '../src/security.mjs';
import { financialReadiness, readFinancialAccounts, ensureMercadoPagoReport } from '../src/financialAccountReadModel.mjs';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  return res.end(JSON.stringify(body));
}

function authorized(req) {
  const provided = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const primary = String(process.env.OPERATOR_TOKEN || '');
  const secondary = String(process.env.OPERATOR_TOKEN_SECONDARY || '');
  return safeBearerEqual(primary, provided) || (secondary && safeBearerEqual(secondary, provided));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  if (!authorized(req)) return json(res, 401, { error: 'operator_auth_required' });
  const url = new URL(req.url || '/api/finance', 'https://zevanory.api.br');
  if(req.method==='POST'&&url.searchParams.get('action')==='refresh_reports'){const end=new Date();const begin=new Date(end.getTime()-30*86400000);const result=await ensureMercadoPagoReport({env:process.env,beginDate:begin.toISOString(),endDate:end.toISOString()});return json(res,202,{mode:'read_only',movement_enabled:false,result});}
  if(req.method==='POST') return json(res,400,{error:'invalid_action'});
  if (url.searchParams.get('view') === 'readiness') {
    return json(res, 200, financialReadiness(process.env));
  }
  const limit = url.searchParams.get('limit');
  const offset = url.searchParams.get('offset');
  const body = await readFinancialAccounts({ env: process.env, limit, offset });
  return json(res, 200, body);
}
