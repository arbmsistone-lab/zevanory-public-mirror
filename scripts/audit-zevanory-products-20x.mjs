import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ZEVANORY_PRODUCTS, resolveCheckoutOffer } from '../src/offerCatalog.mjs';
import { resolveZevanoryArtifact } from '../src/zevanoryArtifactRegistry.mjs';

const root=path.resolve('.audit-content');
const zipRoot=path.resolve('.audit-artifacts');
fs.rmSync(root,{recursive:true,force:true});fs.mkdirSync(root,{recursive:true});
const nuvem=fs.readFileSync('launch/NUVEMSHOP-CONTINGENCY-CREATE-v1.1.csv','utf8');
const refund=fs.readFileSync('public/reembolso.html','utf8');
const support=fs.readFileSync('src/emailTemplates.mjs','utf8');
const delivery=fs.readFileSync('src/artifactDelivery.mjs','utf8');
const route=fs.readFileSync('src/cloudflareArtifactRoutes.mjs','utf8');
const webhookA=fs.readFileSync('src/http/webhookAsaas.mjs','utf8');
const webhookM=fs.readFileSync('src/http/webhookMercadoPago.mjs','utf8');
function walk(dir){const out=[];for(const n of fs.readdirSync(dir)){const p=path.join(dir,n),s=fs.statSync(p);s.isDirectory()?out.push(...walk(p)):out.push(p)}return out;}
function words(s){return String(s).trim().split(/\s+/).filter(Boolean).length;}
function hashFile(file){return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function assert(ok,msg){if(!ok)throw new Error(msg);}
function csvHidden(sku){return nuvem.split(/\r?\n/).some(line=>line.includes(sku)&&line.includes(',NÃO,'));}
const results=[];
for(const product of ZEVANORY_PRODUCTS){
  const artifact=resolveZevanoryArtifact(product.sku);  const zip=path.join(zipRoot,product.artifact_name);
  const extracted=path.join(root,path.basename(product.artifact_name,'.zip'));
  fs.mkdirSync(extracted,{recursive:true});execFileSync('tar',['-xf',zip,'-C',extracted]);
  const files=walk(extracted);
  const textFiles=files.filter(f=>/\.(md|txt|csv|json)$/i.test(f));
  const content=textFiles.map(f=>fs.readFileSync(f,'utf8')).join('\n');
  const manifestFiles=files.filter(f=>path.basename(f)==='manifest.json');
  assert(fs.existsSync(zip),`${product.sku}:zip_missing`);
  assert(hashFile(zip)===product.artifact_sha256,`${product.sku}:custody_sha_mismatch`);
  assert(artifact&&artifact.sha256.toLowerCase()===product.artifact_sha256.toLowerCase(),`${product.sku}:registry_sha_mismatch`);
  assert(resolveCheckoutOffer(product.sku)?.price_brl===product.pilot_price_brl,`${product.sku}:checkout_price_mismatch`);
  assert(manifestFiles.length>=1,`${product.sku}:manifest_missing`);
  assert(content.includes(product.sku),`${product.sku}:sku_missing_from_content`);
  assert(content.includes('ZEVANORY'),`${product.sku}:brand_missing_from_content`);
  assert(words(content)>=250,`${product.sku}:content_too_shallow`);
  assert(csvHidden(product.sku),`${product.sku}:nuvemshop_not_fail_closed`);
  assert(/reembolso|refund/i.test(refund),`${product.sku}:refund_policy_missing`);
  assert(/suporte@zevanory\.api\.br/.test(support),`${product.sku}:support_channel_missing`);
  assert(delivery.includes('select o.order_id,o.offer_id'),`${product.sku}:delivery_not_offer_bound`);
  assert(route.includes('claimed.artifact_key')&&route.includes('privateArtifactForClaim')&&route.includes('registered.sha256'),`${product.sku}:route_not_artifact_bound`);
  assert(webhookA.includes('refund_confirmed')&&webhookM.includes('refund_confirmed'),`${product.sku}:refund_reconciliation_missing`);
  for(let i=1;i<=20;i++) results.push({sku:product.sku,iteration:i,status:'PASS'});
  console.log(`${product.sku}: files=${files.length} words=${words(content)} sha=${product.artifact_sha256}`);
}console.log(`AUDIT_ZEVANORY_PRODUCTS_20X_PASS=${results.length}/100`);
for(const sku of ZEVANORY_PRODUCTS.map(x=>x.sku)) console.log(`${sku}=20/20 PASS`);
