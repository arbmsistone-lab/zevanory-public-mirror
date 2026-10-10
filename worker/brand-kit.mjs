// The only acceptance point for raster images leaving ZEVANORY official publishers.
// SHA256 digests come from the deterministic SVG -> PNG brand build, not from user input.
import { BRAND_APPROVED_MEDIA } from "./brand-approved.mjs";
export const BRAND_SOURCE = Object.freeze({
  logo: "sales-public/brand/zevanory-logo-dark.svg",
  mark: "sales-public/brand/zevanory-mark.svg",
  tagline: "Menos improviso. Mais execução.",
  url: "vendas.zevanory.api.br",
  palette: Object.freeze(["#05070b", "#0b0f16", "#101722", "#202a38", "#f5f7fb", "#8fb8ff", "#a8f0d0", "#1578ff", "#00b8ff", "#21e6f3"]),
});
export const BRAND_SIZES = Object.freeze({
  "avatar-400.png": [400,400], "avatar-800.png": [800,800],
  "banner-bluesky.png": [1500,500], "banner-youtube.png": [2560,1440],
  "banner-facebook.png": [1640,624],
  "post-01.png": [1080,1080], "post-02.png": [1080,1080], "post-03.png": [1080,1080],
  "pin.png": [1000,1500], "short.png": [1080,1920],
  "link-card.png": [1200,630], "blog-card.png": [1200,630], "email-card.png": [1200,630],
});
export const BRAND_CHANNEL_FILES = Object.freeze({
  telegram: ["post-01.png","post-02.png","post-03.png"],
  bluesky: ["post-01.png","post-02.png","post-03.png"],
  pinterest: ["pin.png"], youtube: ["short.png"],
  instagram: ["post-01.png","post-02.png","post-03.png"],
  facebook: ["post-01.png","post-02.png","post-03.png"],
  blog: ["blog-card.png"], email: ["email-card.png"], link: ["link-card.png"],
});
export const BRAND_PROFILE_FILES = Object.freeze({
 bluesky:["avatar-800.png","banner-bluesky.png"],
 telegram:["avatar-800.png"],
 youtube:["avatar-800.png","banner-youtube.png"],
 facebook:["avatar-800.png","banner-facebook.png"],
 instagram:["avatar-800.png"],
 pinterest:["avatar-800.png"],
 whatsapp:["avatar-800.png"],
 google:["avatar-800.png"],
});
export const PNG_SIGNATURE = new Uint8Array([137,80,78,71,13,10,26,10]);
export function pngDimensions(value) {
  const bytes=value instanceof Uint8Array?value:new Uint8Array(value);
  if(bytes.length<33 || PNG_SIGNATURE.some((n,i)=>bytes[i]!==n))throw new Error("brand_invalid_png");
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(8)!==13 || String.fromCharCode(...bytes.slice(12,16))!=="IHDR")throw new Error("brand_invalid_ihdr");
  return [view.getUint32(16),view.getUint32(20)];
}
export function brandUrlFilename(value) {
  let url;
  try{url=new URL(value);}catch{throw new Error("brand_untrusted_url");}
  if(url.protocol!=="https:" || url.hostname!=="zevanory.api.br" || url.port || url.username || url.password || url.search || url.hash)throw new Error("brand_untrusted_url");
  if(!/^\/brand\/export\/[a-z0-9-]+\.png$/.test(url.pathname))throw new Error("brand_untrusted_path");
  return url.pathname.split("/").pop();
}
const hex=bytes=>Array.from(bytes,x=>x.toString(16).padStart(2,"0")).join("");
export async function validateOutboundBrandImage({url,channel,fetchImpl=fetch,approved=BRAND_APPROVED_MEDIA,cryptoImpl=crypto,role="publication",includeBytes=false}={}) {
  const name=brandUrlFilename(url);
  if(!(role==="profile"?BRAND_PROFILE_FILES:BRAND_CHANNEL_FILES)[channel]?.includes(name))throw new Error("brand_channel_size_or_role");
  const expected=approved[name];
  if(!expected || !/^[0-9a-f]{64}$/.test(expected))throw new Error("brand_artifact_unapproved");
  const response=await fetchImpl(url,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(10000)});
  if(response.status!==200 || response.redirected)throw new Error("brand_image_fetch_unverified");
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length===0 || bytes.length>1000000)throw new Error("brand_asset_size");
  const actual=pngDimensions(bytes),need=BRAND_SIZES[name];
  if(actual[0]!==need[0]||actual[1]!==need[1])throw new Error("brand_image_dimensions");
  const digest=hex(new Uint8Array(await cryptoImpl.subtle.digest("SHA-256",bytes)));
  if(digest!==expected)throw new Error("brand_logo_or_palette_unverified");
  return Object.freeze({ok:true,channel,name,sha256:digest,width:actual[0],height:actual[1],...(includeBytes?{bytes}:{})});
}
// Images not in the signed-off brand build are never forwarded; do not silently
// replace a missing image or send it unbranded.
export const requireBrandedPublication = validateOutboundBrandImage;

export const validateBrandProfileAsset=options=>validateOutboundBrandImage({...options,role:"profile"});
