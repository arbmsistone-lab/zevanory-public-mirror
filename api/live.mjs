import { RELEASE } from '../src/release.mjs';
import { attachRequestContext, operationalLog } from '../src/observability.mjs';

export default function handler(req, res) {
  const context = attachRequestContext(req, res, '/api/live');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    operationalLog(context, 405, 'method_not_allowed');
    return res.end(JSON.stringify({ error: 'method_not_allowed', request_id: context.requestId }));
  }
  res.statusCode = 200;
  operationalLog(context, 200, 'liveness_ok');
  return res.end(JSON.stringify({ service: 'ZEVANORY', live: true, release_id: RELEASE.id, request_id: context.requestId }));
}
