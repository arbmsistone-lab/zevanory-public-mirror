import { timingSafeEqual } from 'node:crypto';

const MAX_PUBLIC_EVENT_BYTES = 4096;

export function safeBearerEqual(expected, provided) {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(provided || ''), 'utf8');
  if (a.length < 24 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function validatePublicApiRequest(req, env = process.env) {
  const contentType = String(req?.headers?.['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) return Object.freeze({ ok: false, status: 415, error: 'json_required' });
  const length = Number(req?.headers?.['content-length'] || 0);
  if (!Number.isFinite(length) || length < 0 || length > MAX_PUBLIC_EVENT_BYTES) return Object.freeze({ ok: false, status: 413, error: 'payload_too_large' });
  const origin = String(req?.headers?.origin || '').trim();
  if (origin) {
    let allowedOrigin = '';
    try { allowedOrigin = new URL(String(env.PUBLIC_BASE_URL || '')).origin; } catch {}
    if (!allowedOrigin || origin !== allowedOrigin) return Object.freeze({ ok: false, status: 403, error: 'origin_not_allowed' });
  }
  return Object.freeze({ ok: true });
}
