import { randomUUID } from 'node:crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function attachRequestContext(req, res, route) {
  const incoming = String(req?.headers?.['x-request-id'] || '').trim();
  const requestId = SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  return Object.freeze({ requestId, route: String(route), startedAt: Date.now() });
}

export function operationalLog(context, status, event = 'request_completed', details = {}) {
  const record = Object.freeze({
    timestamp: new Date().toISOString(),
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    event,
    request_id: context.requestId,
    route: context.route,
    status: Number(status),
    duration_ms: Math.max(0, Date.now() - context.startedAt),
    ...details,
  });
  const line = JSON.stringify(record);
  if (record.level === 'error') console.error(line);
  else if (record.level === 'warn') console.warn(line);
  else console.log(line);
  return record;
}
