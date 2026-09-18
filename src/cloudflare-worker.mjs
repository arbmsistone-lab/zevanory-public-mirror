import http from 'node:http';
import { handleAsNodeRequest } from 'cloudflare:node';
import configHandler from '../api/config.mjs';
import statusHandler from '../api/status.mjs';
import releaseHandler from './http/release.mjs';
import assuranceHandler from './http/assurance.mjs';
import financeHandler from './http/finance.mjs';
import providerHealthHandler from './http/providerHealth.mjs';
import eventsPublicHandler from '../api/events-public.mjs';
import eventsOperatorHandler from '../api/events-operator.mjs';
import agentRunHandler from '../api/agent-run.mjs';
import agentStatusHandler from '../api/agent-status.mjs';
import checkoutHandler from '../api/checkout.mjs';
import arbmContadorSubscriptionHandler from './http/arbmContadorSubscription.mjs';
import webhooksHandler from '../api/webhooks.mjs';
import robotControlHandler from '../api/robot-control.mjs';
import intelligenceHandler from '../api/intelligence.mjs';
import autopilotHandler from '../api/autopilot.mjs';
import aiVaultHandler from './http/aiVault.mjs';
import aiServiceIdentityHandler from './http/aiServiceIdentity.mjs';
import aiGatewaySelftestHandler from './http/aiGatewaySelftest.mjs';
import { handleArtifactIssue, handleArtifactDownload } from './cloudflareArtifactRoutes.mjs';
import { handleCloudflareJournalAppend } from './durableOperationJournal.mjs';
import { publicCommercialChannelReadinessSummary } from './publicChannelStatus.mjs';
import { runtimeReleaseModes } from './release.mjs';
import { runNonCommercialAutopilot } from './nonCommercialAutopilot.mjs';
import { handleInternalAuthMailer } from './internalAuthMailer.mjs';
import { hydrateRuntimeConfig } from './runtimeConfigHydration.mjs';
import { verifyOwnerCredential, setOwnerCredential, ownerSetupKey, createOwnerSession, verifyOwnerSession, ownerCookie, clearOwnerCookie, readOwnerCookie } from './ownerAccess.mjs';

const PORT = 8788;

const directHandlers = new Map([
  ['/api/config', configHandler],
  ['/api/status', statusHandler],
  ['/api/release', releaseHandler],
  ['/api/assurance', assuranceHandler],
  ['/api/finance', financeHandler],
  ['/api/provider-health', providerHealthHandler],
  ['/api/events/public', eventsPublicHandler],
  ['/api/events/operator', eventsOperatorHandler],
  ['/api/agent/run', agentRunHandler],
  ['/api/agent/status', agentStatusHandler],
  ['/api/agent-status', agentStatusHandler],
  ['/api/checkout', checkoutHandler],
  ['/api/subscriptions/arbm-contador', arbmContadorSubscriptionHandler],
  ['/api/webhooks', webhooksHandler],
  ['/api/robot/control', robotControlHandler],
  ['/api/robot-control', robotControlHandler],
  ['/api/intelligence', intelligenceHandler],
  ['/api/autopilot/run', autopilotHandler],
  ['/api/internal/ai-vault', aiVaultHandler],
  ['/api/internal/ai-service-identity', aiServiceIdentityHandler],
  ['/api/internal/ai-gateway-selftest', aiGatewaySelftestHandler],
]);
function resolveHandler(req) {
  const url = new URL(req.url || '/', 'https://zevanory.api.br');
  if (url.pathname === '/api/live') { req.url = '/api/status?probe=live'; return statusHandler; }
  if (url.pathname === '/api/health') { req.url = '/api/status?probe=health'; return statusHandler; }
  if (url.pathname === '/api/activation/readiness') { req.url = '/api/config?view=activation'; return configHandler; }
  if (url.pathname === '/api/creative-asset') { req.url = `/api/config?view=creative_asset&${url.searchParams.toString()}`; return configHandler; }
  if (url.pathname === '/api/checkout/asaas') { req.url = '/api/checkout?provider=asaas'; return checkoutHandler; }
  if (url.pathname === '/api/checkout/mercadopago') { req.url = '/api/checkout?provider=mercadopago'; return checkoutHandler; }
  if (url.pathname === '/api/oauth/meta/start') { url.searchParams.set('provider', 'meta_oauth'); url.searchParams.set('action', 'start'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/oauth/meta/callback') { url.searchParams.set('provider', 'meta_oauth'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/oauth/mercadolivre/start') { url.searchParams.set('provider', 'mercadolivre_oauth'); url.searchParams.set('action', 'start'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/oauth/mercadolivre/callback') { url.searchParams.set('provider', 'mercadolivre_oauth'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/oauth/tiktok/start') { url.searchParams.set('provider', 'tiktok_oauth'); url.searchParams.set('action', 'start'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/oauth/tiktok/callback') { url.searchParams.set('provider', 'tiktok_oauth'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/tiktok-review') { url.searchParams.set('provider', 'tiktok_review'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/oauth/linkedin/start') { url.searchParams.set('provider', 'linkedin_oauth'); url.searchParams.set('action', 'start'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/oauth/linkedin/callback') { url.searchParams.set('provider', 'linkedin_oauth'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/oauth/nuvemshop/start') { url.searchParams.set('provider', 'nuvemshop_oauth'); url.searchParams.set('action', 'start'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/oauth/nuvemshop/callback') { url.searchParams.set('provider', 'nuvemshop_oauth'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (['/api/oauth/nuvemshop/status','/api/oauth/nuvemshop/reconcile'].includes(url.pathname)) { url.searchParams.set('provider','nuvemshop_oauth'); url.searchParams.set('action',url.pathname.split('/').pop()); req.url='/api/webhooks?'+url.searchParams.toString(); return webhooksHandler; }
  const privacyEvents={'store-redact':'app/store_redact','customer-redact':'customer/redact','data-request':'customers/data_request'};
  const privacyMatch=url.pathname.match(/^\/api\/webhooks\/nuvemshop\/privacy\/([a-z-]+)$/);
  if(privacyMatch&&privacyEvents[privacyMatch[1]]){req.url='/api/webhooks?provider=nuvemshop&privacy_event='+encodeURIComponent(privacyEvents[privacyMatch[1]]);return webhooksHandler;}
  if (url.pathname.startsWith('/api/webhooks/')) {
    const provider = url.pathname.split('/').pop();
    req.url = `/api/webhooks?provider=${encodeURIComponent(provider)}`;
    return webhooksHandler;
  }
  return directHandlers.get(url.pathname) || null;
}

const server = http.createServer(async (req, res) => {
  try {
    const handler = resolveHandler(req);
    if (!handler) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'not_found' }));
    }
    await handler(req, res);
  } catch (error) {
    console.error('cloudflare_worker_handler_error', error);
    if (!res.headersSent) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = 500;
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'internal_error' }));
  }
});
server.listen(PORT);

const staticAliases = new Map([
  ['/', '/solucoes.html'], ['/favicon.ico', '/brand/favicon.svg'], ['/acesso', '/owner-login.html'], ['/configurar-acesso', '/owner-setup.html'], ['/central', '/index.html'], ['/solucoes', '/solucoes.html'], ['/arbm-sist', '/arbm-sist.html'], ['/arbm-one', '/arbm-one.html'], ['/arbm-contador-saloes', '/arbm-contador-saloes.html'],
  ['/ia-na-pratica', '/ia-na-pratica.html'], ['/vendas-na-pratica', '/vendas-na-pratica.html'],
  ['/lucro-e-caixa', '/lucro-e-caixa.html'], ['/combo-ia-vendas', '/combo-ia-vendas.html'], ['/negocio-completo', '/negocio-completo.html'],
  ['/piloto', '/piloto.html'], ['/confianca', '/confianca.html'], ['/termos', '/termos.html'], ['/privacidade', '/privacidade.html'], ['/exclusao-dados', '/exclusao-dados.html'],
  ['/reembolso', '/reembolso.html'], ['/afiliados', '/afiliados.html'], ['/criativos', '/criativos.html'], ['/zevanory-robot-control', '/zevanory-robot-control.html'], ['/financeiro', '/financeiro.html'], ['/tiktok-review', '/tiktok-review.html'],
]);
function delegatedPaymentOrigin(env,requestUrl){
  if(String(env.PAYMENT_RUNTIME_MODE||'').toLowerCase()!=='delegated')return null;
  try{
    const origin=new URL(String(env.PAYMENT_RUNTIME_ORIGIN||''));
    const allowed=String(env.PAYMENT_RUNTIME_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
    const requestOrigin=new URL(requestUrl).origin;
    if(origin.protocol!=='https:'||origin.origin===requestOrigin||!allowed.includes(origin.origin))return null;
    if(String(env.PAYMENT_RUNTIME_ORIGIN_VERIFIED||'').toLowerCase()!=='true')return null;
    if(String(env.PAYMENT_RUNTIME_ORIGIN_RELEASE_ID||'')!=='ZEVANORY-EG0039-FINAL')return null;
    return origin.origin;
  }catch{return null;}
}
function isPaymentMutation(pathname){
  return pathname.startsWith('/api/checkout')||/^\/api\/webhooks\/(asaas|mercadopago)$/.test(pathname);
}
async function delegatePaymentRequest(request,env){
  const url=new URL(request.url),origin=delegatedPaymentOrigin(env,request.url);
  if(!origin||!isPaymentMutation(url.pathname))return null;
  if(request.headers.get('x-zevanory-payment-delegated')==='1')return new Response(JSON.stringify({error:'payment_delegation_loop_blocked'}),{status:508,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
  const target=new URL(url.pathname+url.search,origin),headers=new Headers(request.headers);headers.set('x-zevanory-payment-delegated','1');
  const init={method:request.method,headers,redirect:'manual'};if(!['GET','HEAD'].includes(request.method))init.body=request.body;
  try{return await fetch(new Request(target,init));}catch{return new Response(JSON.stringify({error:'payment_runtime_unavailable',preserved:true}),{status:503,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
}
function withSecurityHeaders(response, env) {
  const headers = new Headers(response.headers);
  const contentType=String(headers.get('content-type')||'').toLowerCase();
  if(contentType.startsWith('text/html'))headers.set('content-type','text/html; charset=utf-8');
  else if(contentType.startsWith('text/javascript')||contentType.startsWith('application/javascript'))headers.set('content-type','text/javascript; charset=utf-8');
  else if(contentType.startsWith('text/css'))headers.set('content-type','text/css; charset=utf-8');
  headers.set('content-security-policy', "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'");
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('x-frame-options', 'DENY');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('x-dns-prefetch-control', 'off');
  headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
  if (env?.PUBLIC_RELEASE_SHA) headers.set('x-deployment-sha', String(env.PUBLIC_RELEASE_SHA));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async scheduled(controller, env, ctx) {
    hydrateRuntimeConfig(env);
    globalThis.__ZEVANORY_EDGE_AI__ = { AI: env.AI || null };
    ctx.waitUntil(runNonCommercialAutopilot({env,scheduledTime:controller.scheduledTime}).catch(error=>console.error('noncommercial_autopilot_failed',String(error?.message||error))));
  },
  async fetch(request, env) {
    globalThis.__ZEVANORY_EDGE_AI__ = { AI: env.AI || null };
    globalThis.__ZEVANORY_PRIVATE_KV__ = env.ZEVANORY_PRIVATE_ARTIFACTS || null;
    hydrateRuntimeConfig(env);
    const url = new URL(request.url);
    if(request.headers.get('x-zevanory-owner-authenticated')){const h=new Headers(request.headers);h.delete('x-zevanory-owner-authenticated');request=new Request(request,{headers:h});}
    if(url.pathname==='/auth/owner/session'&&request.method==='POST'){
      const origin=String(request.headers.get('origin')||'');if(origin&&origin!==url.origin)return new Response(JSON.stringify({error:'origin_not_allowed'}),{status:403,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
      const ip=String(request.headers.get('cf-connecting-ip')||'unknown').slice(0,80),rateKey='owner-auth-fail:'+ip,kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
      const failures=kv?Number(await kv.get(rateKey)||0):0;if(failures>=8)return new Response(JSON.stringify({error:'temporarily_locked'}),{status:429,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','retry-after':'900'}});
      let body={};try{body=await request.json();}catch{return new Response(JSON.stringify({error:'invalid_json'}),{status:400,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
      if(!await verifyOwnerCredential(env,body?.password,kv)){if(kv)await kv.put(rateKey,String(failures+1),{expirationTtl:900});return new Response(JSON.stringify({error:'invalid_credentials'}),{status:401,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
      if(kv)await kv.delete(rateKey);
      const token=await createOwnerSession(env);return new Response(JSON.stringify({authenticated:true}),{status:200,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','set-cookie':ownerCookie(token)}});
    }
    if(url.pathname==='/auth/owner/setup'&&request.method==='POST'){
      const origin=String(request.headers.get('origin')||'');if(origin&&origin!==url.origin)return new Response(JSON.stringify({error:'origin_not_allowed'}),{status:403,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
      const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;if(!kv)return new Response(JSON.stringify({error:'setup_unavailable'}),{status:503,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
      let body={};try{body=await request.json();}catch{return new Response(JSON.stringify({error:'invalid_json'}),{status:400,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
      const token=String(body?.token||''),password=String(body?.password||'');if(token.length<32||password.length<8)return new Response(JSON.stringify({error:'invalid_setup'}),{status:400,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
      const key=await ownerSetupKey(token),allowed=await kv.get(key);if(allowed!=='1')return new Response(JSON.stringify({error:'setup_token_invalid'}),{status:403,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
      await setOwnerCredential(env,kv,password);await kv.delete(key);const session=await createOwnerSession(env);return new Response(JSON.stringify({configured:true}),{status:200,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','set-cookie':ownerCookie(session)}});
    }
    if(url.pathname==='/auth/owner/logout'&&request.method==='POST')return new Response(null,{status:204,headers:{'cache-control':'no-store','set-cookie':clearOwnerCookie()}});
    const privatePage=new Set(['/central','/index.html','/criativos','/criativos.html','/zevanory-robot-control','/zevanory-robot-control.html','/financeiro','/financeiro.html']).has(url.pathname);
    const privateApi=url.pathname.startsWith('/private-api/');
    const owner=(privatePage||privateApi)?await verifyOwnerSession(env,readOwnerCookie(request)):null;
    if(privatePage&&!owner)return Response.redirect(new URL('/acesso',url),302);
    if(privateApi){
      if(!owner)return new Response(JSON.stringify({error:'owner_auth_required'}),{status:401,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
      const mapped='/api/'+url.pathname.slice('/private-api/'.length);const target=new URL(mapped+url.search,url);const headers=new Headers(request.headers);headers.delete('x-zevanory-owner-authenticated');headers.set('x-zevanory-owner-authenticated','1');
      return handleAsNodeRequest(PORT,new Request(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'}));
    }
    if (url.hostname === 'zevanory.internal') return handleInternalAuthMailer(request, env);
    const delegatedPayment=await delegatePaymentRequest(request,env);if(delegatedPayment)return delegatedPayment;
    if (url.pathname === '/private/artifacts/issue') return handleArtifactIssue(request, env);
    if (url.pathname === '/private/artifacts/download') return handleArtifactDownload(request, env);
    if (url.pathname === '/private/journal/append') return handleCloudflareJournalAppend(request, env);
    if (url.pathname === '/api/status') {
      const response = await handleAsNodeRequest(PORT, request);
      if (!response.ok) return response;
      try {
        const body = await response.clone().json();
        const modes = runtimeReleaseModes(env);
        body.runtime = { telemetry:body.runtime?.telemetry||'active', checkout:modes.checkoutMode, financial:modes.financialMode, sales:modes.salesMode, whatsapp:modes.whatsappMode };
        body.channel_readiness = publicCommercialChannelReadinessSummary(env);
        const headers = new Headers(response.headers);
        headers.set('content-type','application/json; charset=utf-8');
        return new Response(JSON.stringify(body),{status:response.status,statusText:response.statusText,headers});
      } catch { return response; }
    }
    if (url.pathname.startsWith('/api/')) return handleAsNodeRequest(PORT, request);
    const alias = staticAliases.get(url.pathname);
    const assetUrl = alias ? new URL(alias, url) : url;
    const assetRequest = new Request(assetUrl, request);
    const response = await env.ASSETS.fetch(assetRequest);
    return withSecurityHeaders(response, env);
  },
};





