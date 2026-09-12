import {safeBearerEqual} from '../src/security.mjs';
import {createOperatorSessionCookie} from '../src/operatorSession.mjs';
export default async function handler(req,res){
  res.setHeader('cache-control','no-store');
  res.setHeader('referrer-policy','no-referrer');
  if(req.method!=='GET'){res.statusCode=405;return res.end('method_not_allowed');}
  const expected=String(process.env.OPERATOR_BOOTSTRAP_TOKEN||'');
  const url=new URL(req.url||'/api/operator-session/bootstrap','https://zevanory.api.br');
  const provided=String(url.searchParams.get('code')||'');
  if(!expected||!safeBearerEqual(expected,provided)){res.statusCode=401;return res.end('operator_bootstrap_required');}
  const cookie=createOperatorSessionCookie(process.env);
  if(!cookie){res.statusCode=503;return res.end('operator_session_unavailable');}
  res.setHeader('set-cookie',cookie);res.setHeader('location','/');res.statusCode=302;return res.end();
}