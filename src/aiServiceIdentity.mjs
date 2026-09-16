import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';

const PKCS8_ED25519_PREFIX=Buffer.from('302e020100300506032b657004220420','hex');
const PATH='/functions/v1/arbm-ai-three-provider-probe-20260908';
const CONTEXT='zevanory-ai-gateway-ed25519-v1';
const b64url=(value)=>Buffer.from(value).toString('base64url');
const sha256=(value)=>createHash('sha256').update(value).digest();
function privateKey(secret){
  if(!String(secret||'').trim())throw new Error('ai_service_identity_secret_required');
  const seed=sha256(`${CONTEXT}\0${secret}`);
  return createPrivateKey({key:Buffer.concat([PKCS8_ED25519_PREFIX,seed]),format:'der',type:'pkcs8'});
}
export function aiServicePublicIdentity(secret){
  const spki=createPublicKey(privateKey(secret)).export({format:'der',type:'spki'});
  const fingerprint=b64url(sha256(spki));
  return Object.freeze({algorithm:'Ed25519',version:1,key_id:`zev-ai-${fingerprint.slice(0,16)}`,public_key_spki:b64url(spki),fingerprint});
}
export function signAiGatewayRequest({secret,body,path=PATH,timestamp=Math.floor(Date.now()/1000),nonce=b64url(randomBytes(18))}){
  const raw=typeof body==='string'?body:JSON.stringify(body);
  const identity=aiServicePublicIdentity(secret);
  const bodyHash=b64url(sha256(raw));
  const canonical=`v1\n${timestamp}\n${nonce}\n${bodyHash}\n${path}`;
  const signature=b64url(sign(null,Buffer.from(canonical),privateKey(secret)));
  return Object.freeze({body:raw,headers:{
    'content-type':'application/json','x-zevanory-key-id':identity.key_id,
    'x-zevanory-timestamp':String(timestamp),'x-zevanory-nonce':nonce,
    'x-zevanory-body-sha256':bodyHash,'x-zevanory-signature':signature,
  }});
}

export const AI_GATEWAY_PATH=PATH;

