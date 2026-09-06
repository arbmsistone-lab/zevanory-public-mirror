import { timingSafeEqual } from 'node:crypto';

const MAX_PUBLIC_EVENT_BYTES = 4096;

export function safeBearerEqual(expected, provided) {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(provided || ''), 'utf8');
  if (a.length < 24 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function readJsonRequestBody(req, maxBytes = MAX_PUBLIC_EVENT_BYTES) {
  const body=req?.body;
  if(body && typeof body==='object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) return body;
  let raw='';
  if(typeof body==='string') raw=body;
  else if(Buffer.isBuffer(body) || body instanceof Uint8Array) raw=Buffer.from(body).toString('utf8');
  else if(req && typeof req[Symbol.asyncIterator]==='function'){
    const chunks=[]; let total=0;
    try{for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=b.length;if(total>maxBytes)return null;chunks.push(b);}}catch{return null;}
    raw=Buffer.concat(chunks).toString('utf8');
  }
  if(!raw || Buffer.byteLength(raw,'utf8')>maxBytes) return null;
  try{const parsed=JSON.parse(raw);return parsed && typeof parsed==='object'?parsed:null;}catch{return null;}
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

export function isPublicDeploymentRequest(req){const h=req?.headers||{};const raw=String(h['x-forwarded-host']||h.host||'').split(',')[0].trim().toLowerCase();const host=raw.split(':')[0];return host==='zevanory.api.br'||host.endsWith('.vercel.app');}
