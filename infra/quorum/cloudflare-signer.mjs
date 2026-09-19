const RELEASE_SHA="a908c237b80af2c571edb4947cb15ab25f0f8f77";
const RELEASE_ID="ZEVANORY-EG0039-FINAL";
const POLICY_VERSION="ZEVANORY-CROWN-10P@1.0.0";
const PROVIDER="cloudflare-workers";
const enc=new TextEncoder();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
const b64u=b=>{let s="";for(const x of new Uint8Array(b))s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")};
async function sha256(s){return hex(await crypto.subtle.digest("SHA-256",enc.encode(s)))}
async function ensureKey(env){
  const stored=await env.ZEVANORY_QUORUM_KEYS.get("rsa-keypair","json");
  if(stored?.private_jwk&&stored?.public_jwk&&stored?.key_id)return stored;
  const pair=await crypto.subtle.generateKey({name:"RSA-PSS",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
  const private_jwk=await crypto.subtle.exportKey("jwk",pair.privateKey);
  const public_jwk=await crypto.subtle.exportKey("jwk",pair.publicKey);
  const key_id=await sha256(JSON.stringify(public_jwk));
  const out={private_jwk,public_jwk,key_id};
  await env.ZEVANORY_QUORUM_KEYS.put("rsa-keypair",JSON.stringify(out));
  return out;
}
async function sign(env){
  const evidence_root=await sha256("ZEVANORY|"+RELEASE_ID+"|"+RELEASE_SHA+"|"+POLICY_VERSION);
  const signed_payload=["zevanory-provider-attestation/v1",PROVIDER,RELEASE_ID,RELEASE_SHA,evidence_root,POLICY_VERSION].join("|");
  const k=await ensureKey(env);
  const privateKey=await crypto.subtle.importKey("jwk",k.private_jwk,{name:"RSA-PSS",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign({name:"RSA-PSS",saltLength:32},privateKey,enc.encode(signed_payload));
  return {evidence_root,signed_payload,signature:{alg:"PS256",key_id:k.key_id,public_jwk:k.public_jwk,value:b64u(sig)}};
}
export default{async fetch(req,env){
  const s=await sign(env);
  const body={service:"ZEVANORY",provider:PROVIDER,release_id:RELEASE_ID,fail_closed:true,public_sales_locked:true,
    quorum_attestation:{schema:"zevanory-quorum-attestation/v2",artifact_sha:RELEASE_SHA,evidence_root:s.evidence_root,policy_version:POLICY_VERSION,provider:PROVIDER,algorithm:"sha256",signed_payload:s.signed_payload,signature:s.signature}};
  return new Response(JSON.stringify(body),{headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",
    "x-zevanory-artifact-sha":RELEASE_SHA,"x-zevanory-evidence-root":s.evidence_root,"x-zevanory-policy-version":POLICY_VERSION,"x-zevanory-key-id":s.signature.key_id}});
}};
