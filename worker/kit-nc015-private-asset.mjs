// NC-015 private R2 only; NO r2.dev, public domain, pre-signed URL or KV fallback.
const enc=new TextEncoder();
const SHA=/^[a-f0-9]{64}$/;
const MAX_BYTES=64*1024*1024; // fail-closed until larger ZIPs are measured/reviewed
const VALID_ID=/^[0-9]{6,12}$/;
const TYPES=Object.freeze({"application/pdf":".pdf","application/zip":".zip"});
const hex=a=>[...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,"0")).join("");
export class KitAssetError extends Error{
 constructor(code,status=503){super(code);this.code=code;this.status=status}
}
export function kitAssetManifest(env,productId){
 if(!VALID_ID.test(String(productId)))throw new KitAssetError("product_id_invalid",400);
 let root;
 try{root=JSON.parse(String(env?.KIT_PRIVATE_FILES_JSON||""))}catch{throw new KitAssetError("private_manifest_unavailable")}
 const item=root?.[String(productId)],ext=TYPES[item?.mime_type];
 if(!ext||!SHA.test(item?.sha256)||!Number.isSafeInteger(item?.bytes)||item.bytes<1||
    item.bytes>MAX_BYTES||typeof item?.key!=="string"||
    !/^kit-private\/[0-9]{6,12}\/[a-f0-9]{64}\.(pdf|zip)$/.test(item.key)||
    !item.key.includes("/"+item.sha256+ext)||typeof item.filename!=="string"||
    !/^[A-Za-z0-9_-]{1,90}\.(pdf|zip)$/.test(item.filename)||!item.filename.endsWith(ext))
  throw new KitAssetError("private_manifest_invalid");
 return Object.freeze({...item});
}
export async function getVerifiedKitAsset(env,productId){
 const item=kitAssetManifest(env,productId);
 if(!env?.KIT_PRIVATE_R2?.get)throw new KitAssetError("private_r2_binding_missing");
 let object;
 try{object=await env.KIT_PRIVATE_R2.get(item.key)}catch{throw new KitAssetError("private_r2_unavailable")}
 if(!object||object.size!==item.bytes||!object.arrayBuffer)
  throw new KitAssetError("private_r2_missing_or_size_mismatch");
 const bytes=new Uint8Array(await object.arrayBuffer());
 if(bytes.byteLength!==item.bytes)throw new KitAssetError("private_r2_size_mismatch");
 const digest=hex(await crypto.subtle.digest("SHA-256",bytes));
 if(digest!==item.sha256)throw new KitAssetError("private_r2_sha256_mismatch");
 return {bytes,mime_type:item.mime_type,filename:item.filename,sha256:item.sha256};
}
