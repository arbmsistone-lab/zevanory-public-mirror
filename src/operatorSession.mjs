import { createHmac } from 'node:crypto';
import { safeBearerEqual } from './security.mjs';
const COOKIE='zv_op_session';
const TTL_SECONDS=60*60*12;
const secret=(env)=>String(env.OPERATOR_SESSION_SECRET||env.OPERATOR_TOKEN_SECONDARY||env.OPERATOR_TOKEN||'');
const sign=(value,key)=>createHmac('sha256',key).update(value).digest('hex');
export function createOperatorSessionCookie(env=process.env,now=Date.now()){
  const key=secret(env); if(!key)return '';
  const exp=Math.floor(now/1000)+TTL_SECONDS; const payload=String(exp); const sig=sign(payload,key);
  return `${COOKIE}=${payload}.${sig}; Path=/api/robot-control; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}
export function hasValidOperatorSession(req,env=process.env,now=Date.now()){
  const key=secret(env); if(!key)return false;
  const raw=String(req?.headers?.cookie||req?.headers?.Cookie||'');
  const pair=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'=')); if(!pair)return false;
  const value=pair.slice(COOKIE.length+1); const m=/^(\d{10})\.([0-9a-f]{64})$/i.exec(value); if(!m)return false;
  const exp=Number(m[1]); if(!Number.isFinite(exp)||exp<Math.floor(now/1000))return false;
  return safeBearerEqual(sign(m[1],key),m[2]);
}