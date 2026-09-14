import { readFileSync } from 'node:fs';
import { ZEVANORY_PRODUCTS, getZevanoryProduct, resolveCheckoutOffer } from '../src/offerCatalog.mjs';
import { digitalFulfillmentReadiness } from '../src/digitalFulfillment.mjs';
const handoff=readFileSync(new URL('../launch/ZEVANORY-PRODUCTS-V21-HANDOFF.md',import.meta.url),'utf8');
let pass=0;
for(let i=1;i<=20;i++){
  const product=getZevanoryProduct('ZEV-NGC-011');
  const checkout=resolveCheckoutOffer('ZEV-NGC-011');
  const blocked=digitalFulfillmentReadiness({order_status:'created',payment_confirmed:false});
  const ok=ZEVANORY_PRODUCTS.length===5&&product?.version==='2.1'&&product?.primary===false&&product?.portfolio_role==='content_bundle'&&product?.pilot_price_brl===347&&product?.artifact_materialized===true&&product?.content_quality_certified===true&&product?.quality_certified===false&&product?.sellable===false&&/^[0-9a-f]{64}$/i.test(product?.artifact_sha256||'')&&checkout===null&&blocked.ready===false&&blocked.public_download===false&&blocked.blockers.includes('payment_not_reconciled')&&handoff.includes('Produtos digitais v2.1 Master/Sênior')&&handoff.includes('sellable=false');
  if(!ok){console.error(`PRODUCT_DISTRIBUTION_AUDIT_${i}=FAIL`);process.exit(1);}
  pass++; console.log(`PRODUCT_DISTRIBUTION_AUDIT_${i}=PASS`);
}
console.log(`AUDIT_PRODUCT_DISTRIBUTION_20X_PASS=${pass}/20`);
