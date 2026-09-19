const CONTROL_PLANE_ENTRY = '/central';

function cloneForRuntime(request, url) {
  const headers = new Headers(request.headers);
  headers.set('x-zevanory-control-plane-proxy', '1');
  const init = { method: request.method, headers, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
  return new Request(url, init);
}

export default {
  async fetch(request, env) {
    if (!env?.ZEVANORY_RUNTIME || typeof env.ZEVANORY_RUNTIME.fetch !== 'function') {
      return new Response(JSON.stringify({
        error: 'zevanory_runtime_binding_unavailable',
        fail_closed: true,
      }), {
        status: 503,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    const url = new URL(request.url);
    if (url.pathname === '/') url.pathname = CONTROL_PLANE_ENTRY;

    const response = await env.ZEVANORY_RUNTIME.fetch(cloneForRuntime(request, url));
    const headers = new Headers(response.headers);
    headers.set('x-zevanory-control-plane-source', 'canonical-zevanory-worker');
    if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
