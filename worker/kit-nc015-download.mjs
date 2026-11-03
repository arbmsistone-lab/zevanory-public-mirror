// NC-015 N1: candidate HTTP download. The public wrapper is hard-disabled until
// separate owner-approved activation, not unlockable by changing an env var.
// No public R2 URL and no token or raw transaction in logs.
import {verifySignedKitToken} from "./kit-nc015-token.mjs";
import {readHotmartOrderNc015} from "./kit-nc015-readback.mjs";
import {getVerifiedKitAsset,KitAssetError} from "./kit-nc015-private-asset.mjs";
import {KitReadbackError} from "./kit-nc015-readback.mjs";
export const KIT_DOWNLOAD_ENABLED=false;
const headers=Object.freeze({"cache-control":"no-store, private, max-age=0","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});
function deny(status=503){return new Response("Download indisponível",{status,headers})}
export async function downloadVerifiedKitCandidate({
 request,env,now=Date.now(),enabled=false,fetcher=fetch
}={}){
 if(!enabled)return deny(503);
 if(request?.method!=="GET")return deny(405);
 const u=new URL(request.url);
 if(u.pathname!=="/kit/baixar")return deny(404);
 const claim=await verifySignedKitToken(u.searchParams.get("t"),env?.KIT_DOWNLOAD_SIGNING_KEY);
 if(!claim)return deny(404);
 if(!env?.PURCHASE_RELEASE_DO?.idFromName||!env?.PURCHASE_RELEASE_DO?.get||
    typeof env.INTERNAL_DO_SIGNING_KEY!=="string"||
    env.INTERNAL_DO_SIGNING_KEY.length<24)return deny(503);
 const stub=env.PURCHASE_RELEASE_DO.get(env.PURCHASE_RELEASE_DO.idFromName("kit-verified:"+claim.orderOpaque.slice(3)));
 const internalHeaders={"x-internal-do-key":env.INTERNAL_DO_SIGNING_KEY};
 let meta,proof,asset;
 try{
  const res=await stub.fetch("https://internal.kit.example/internal/reference",{method:"GET",headers:internalHeaders});
  if(!res.ok)return deny(503);
  meta=await res.json();
  if(!meta?.state||meta.state.state!=="ready"||!meta.reference||now<meta.state.release_at_ms||
     now>meta.state.token_expires_at_ms)return deny(403);
  proof=await readHotmartOrderNc015({
   transaction:meta.reference.transaction,productId:meta.reference.product_id,
   approvedAtMs:meta.state.approved_at_ms,orderOpaque:claim.orderOpaque,
   accessToken:env.HOTMART_ACCESS_TOKEN,fetcher,now
  });
  asset=await getVerifiedKitAsset(env,meta.reference.product_id);
 }catch(e){
  if(e instanceof KitReadbackError&&e.status===403)return deny(403);
  if(e instanceof KitAssetError||e instanceof KitReadbackError)return deny(503);
  return deny(503);
 }
 // Object retrieved and SHA verified BEFORE consuming the scarce download slot.
 const consume=await stub.fetch("https://internal.kit.example/internal/download-claim",{
  method:"POST",headers:{...internalHeaders,"content-type":"application/json"},
  body:JSON.stringify({now_ms:now,raw_token:claim.rawToken,proof})
 });
 if(!consume.ok)return deny(403);
 const received=await consume.json();
 if(received?.ok!==true)return deny(403);
 return new Response(asset.bytes,{status:200,headers:{
  ...headers,"content-type":asset.mime_type,"content-length":String(asset.bytes.byteLength),
  "content-disposition":'attachment; filename="'+asset.filename+'"',
  "x-robots-tag":"noindex, nofollow"
 }});
}
export function handleKitDownloadNc015(request,env){
 return downloadVerifiedKitCandidate({request,env,enabled:KIT_DOWNLOAD_ENABLED});
}
