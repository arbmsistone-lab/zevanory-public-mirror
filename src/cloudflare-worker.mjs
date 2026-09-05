import http from 'node:http';
import { handleAsNodeRequest } from 'cloudflare:node';
import configHandler from '../api/config.mjs';
import statusHandler from '../api/status.mjs';
import releaseHandler from '../api/release.mjs';
import assuranceHandler from '../api/assurance.mjs';
import eventsPublicHandler from '../api/events-public.mjs';
import eventsOperatorHandler from '../api/events-operator.mjs';
import agentRunHandler from '../api/agent-run.mjs';
import agentStatusHandler from '../api/agent-status.mjs';
import checkoutHandler from '../api/checkout.mjs';
import webhooksHandler from '../api/webhooks.mjs';
import robotControlHandler from '../api/robot-control.mjs';
import { handleArtifactIssue, handleArtifactDownload } from './cloudflareArtifactRoutes.mjs';

const PORT = 8788;

const directHandlers = new Map([
  ['/api/config', configHandler],
  ['/api/status', statusHandler],
  ['/api/release', releaseHandler],
  ['/api/assurance', assuranceHandler],
  ['/api/events/public', eventsPublicHandler],
  ['/api/events/operator', eventsOperatorHandler],
  ['/api/agent/run', agentRunHandler],
  ['/api/agent/status', agentStatusHandler],
  ['/api/checkout', checkoutHandler],
  ['/api/webhooks', webhooksHandler],
  ['/api/robot/control', robotControlHandler],
]);
function resolveHandler(req) {
  const url = new URL(req.url || '/', 'https://zevanory.api.br');
  if (url.pathname === '/api/live') { req.url = '/api/status?probe=live'; return statusHandler; }
  if (url.pathname === '/api/health') { req.url = '/api/status?probe=health'; return statusHandler; }
  if (url.pathname === '/api/activation/readiness') { req.url = '/api/config?view=activation'; return configHandler; }
  if (url.pathname === '/api/checkout/asaas') { req.url = '/api/checkout?provider=asaas'; return checkoutHandler; }
  if (url.pathname === '/api/checkout/mercadopago') { req.url = '/api/checkout?provider=mercadopago'; return checkoutHandler; }
  if (url.pathname === '/api/oauth/tiktok/start') { url.searchParams.set('provider', 'tiktok_oauth'); url.searchParams.set('action', 'start'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
  if (url.pathname === '/api/oauth/tiktok/callback') { url.searchParams.set('provider', 'tiktok_oauth'); req.url = `/api/webhooks?${url.searchParams.toString()}`; return webhooksHandler; }
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
  ['/', '/index.html'], ['/arbm-sist', '/arbm-sist.html'], ['/piloto', '/piloto.html'],
  ['/termos', '/termos.html'], ['/privacidade', '/privacidade.html'], ['/exclusao-dados', '/exclusao-dados.html'],
  ['/reembolso', '/reembolso.html'], ['/afiliados', '/afiliados.html'],
]);
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'");
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('x-frame-options', 'DENY');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('x-dns-prefetch-control', 'off');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/private/artifacts/issue') return handleArtifactIssue(request, env);
    if (url.pathname === '/private/artifacts/download') return handleArtifactDownload(request, env);
    if (url.pathname.startsWith('/api/')) {
      return handleAsNodeRequest(PORT, request);
    }
    const alias = staticAliases.get(url.pathname);
    const assetUrl = alias ? new URL(alias, url) : url;
    const assetRequest = new Request(assetUrl, request);
    const response = await env.ASSETS.fetch(assetRequest);
    return withSecurityHeaders(response);
  },
};
