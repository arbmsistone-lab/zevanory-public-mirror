import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { BRAND_SOURCE, BRAND_SIZES, pngDimensions, brandUrlFilename, validateOutboundBrandImage } from "../worker/brand-kit.mjs";
import { publishTelegram, publishPinterest } from "../worker/multichannel-autonomy.mjs";
const fakePng=(w,h)=>{
 const p=new Uint8Array(33);p.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
 new DataView(p.buffer).setUint32(16,w);new DataView(p.buffer).setUint32(20,h);p[24]=8;p[25]=6;return p;
};
const knownUrl="https://zevanory.api.br/brand/export/post-01.png";
test("official storefront logo path is immutable and palette anchored",()=>{
 assert.equal(BRAND_SOURCE.logo,"sales-public/brand/zevanory-logo-dark.svg");
 assert.ok(BRAND_SOURCE.palette.includes("#05070b"));
 assert.deepEqual(BRAND_SIZES["banner-youtube.png"],[2560,1440]);
});
test("image without official export gate is refused before network",async()=>{
 let calls=0;await assert.rejects(
  validateOutboundBrandImage({url:"https://zevanory.api.br/creative/unbranded.png",channel:"telegram",fetchImpl:async()=>{calls++;}}),
  /brand_untrusted_path/
 );assert.equal(calls,0);
});
test("off-domain and wrong network path rejected",()=>{
 for(const url of ["http://vendas.zevanory.api.br/brand/export/post-01.png","https://evil.example/brand/export/post-01.png","https://zevanory.api.br/brand/export/post-01.png?next=foo"])
 assert.throws(()=>brandUrlFilename(url),/brand_untrusted_url/);
});
test("avatar and banner cannot masquerade as a post",async()=>{
 await assert.rejects(validateOutboundBrandImage({url:"https://zevanory.api.br/brand/export/avatar-800.png",channel:"pinterest"}),/brand_channel_size_or_role/);
});
test("unsigned media blocked even if the URL and dimensions look right",async()=>{
 let requests=0;await assert.rejects(validateOutboundBrandImage({url:knownUrl,channel:"telegram",approved:{},fetchImpl:async()=>{requests++;}}),/brand_artifact_unapproved/);
 assert.equal(requests,0);
});
test("approved binary must match pinned bytes, dimensions and PNG magic",async()=>{
 const good=fakePng(1080,1080),digest=createHash("sha256").update(good).digest("hex");
 const approved={"post-01.png":digest};
 const fetchImpl=async()=>({status:200,redirected:false,arrayBuffer:async()=>good.buffer});
 const result=await validateOutboundBrandImage({url:knownUrl,channel:"telegram",fetchImpl,approved,cryptoImpl:webcrypto});
 assert.equal(result.ok,true);
 const wrong=fakePng(1000,1500);
 await assert.rejects(validateOutboundBrandImage({url:knownUrl,channel:"telegram",approved,cryptoImpl:webcrypto,fetchImpl:async()=>({status:200,arrayBuffer:async()=>wrong.buffer})}),/brand_image_dimensions/);
 const tampered=fakePng(1080,1080);tampered[26]=2;
 await assert.rejects(validateOutboundBrandImage({url:knownUrl,channel:"telegram",approved,cryptoImpl:webcrypto,fetchImpl:async()=>({status:200,arrayBuffer:async()=>tampered.buffer})}),/brand_logo_or_palette_unverified/);
 assert.deepEqual(pngDimensions(good),[1080,1080]);
});
test("never accept redirects or oversized images",async()=>{
 const good=fakePng(1080,1080),approved={"post-01.png":createHash("sha256").update(good).digest("hex")};
 await assert.rejects(validateOutboundBrandImage({url:knownUrl,channel:"telegram",approved,fetchImpl:async()=>({status:302})}),/brand_image_fetch_unverified/);
 await assert.rejects(validateOutboundBrandImage({url:knownUrl,channel:"telegram",approved,fetchImpl:async()=>({status:200,arrayBuffer:async()=>new Uint8Array(1000001).buffer})}),/brand_asset_size/);
});

test("Telegram media publication cannot bypass official logo validation or reach provider",async()=>{
 const writes=[],store=new Map();
 const env={TELEGRAM_BOT_TOKEN:"token",TELEGRAM_CHANNEL_ID:"@zevanory",
 ZEVANORY_PRIVATE_ARTIFACTS:{get:async k=>store.get(k)||null,put:async(k,v)=>store.set(k,String(v))}};
 await assert.rejects(publishTelegram({env,payload:{content:"teste",media_url:"https://zevanory.api.br/brand/export/fake-logo.png"},fetchImpl:async(url,init)=>{writes.push(url);throw Error("not_called")}}),/brand_channel_size_or_role/);
 assert.equal(writes.length,0);
 assert.ok([...store.keys()].some(k=>k.startsWith("zpc-activity:v1:event:")),"blocked image creates a privacy-safe audit event");
});
test("Pinterest media publication cannot bypass official logo gate or contact Pinterest",async()=>{
 const requests=[],env={PINTEREST_ACCESS_TOKEN:"token",PINTEREST_BOARD_ID:"board"};
 await assert.rejects(publishPinterest({env,payload:{title:"teste",content:"mensagem",landing_url:"https://zevanory.api.br",media_url:"https://zevanory.api.br/brand/export/post-01.png"},fetchImpl:async(url,init)=>{requests.push(url);throw Error("not_called")}}),/brand_channel_size_or_role/);
 assert.deepEqual(requests,[]);
});
