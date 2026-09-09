import { readFileSync } from 'node:fs';
import { ZEVANORY_PRODUCTS, getZevanoryProduct, resolveCheckoutOffer } from '../src/offerCatalog.mjs';
import { digitalFulfillmentReadiness } from '../src/digitalFulfillment.mjs';
const handoff=readFileSync(new URL('../launch/ZEVANORY-PRODUCTS-V11-HANDOFF.md',import.meta.url),'utf8');
let pass=0;
for(let i=1;i<=20;i++){
  const catalogProduct=getZevanoryProduct('ZEV-NGC-011');
  const checkoutOffer=resolveCheckoutOffer('ZEV-NGC-011');
  const blocked=digitalFulfillmentReadiness({order_status:'created',payment_confirmed:false});
  const ok=ZEVANORY_PRODUCTS.length===5&&
    catalogProduct?.sku==='ZEV-NGC-011'&&catalogProduct?.primary===true&&catalogProduct?.pilot_price_brl===347&&/^[0-9a-f]{64}$/i.test(catalogProduct?.artifact_sha256||'')&&
    checkoutOffer?.id==='ZEV-NGC-011'&&checkoutOffer?.price_brl===347&&checkoutOffer?.artifact_sha256===catalogProduct?.artifact_sha256&&
    blocked.ready===false&&blocked.public_download===false&&blocked.blockers.includes('payment_not_reconciled')&&
    handoff.includes('handoff comercial v2.1 certificado')&&handoff.includes('entrega exige pagamento autenticado e reconciliado');
  if(!ok){console.error(`PRODUCT_DISTRIBUTION_AUDIT_${i}=FAIL`);process.exit(1);}pass++;console.log(`PRODUCT_DISTRIBUTION_AUDIT_${i}=PASS`);
}
console.log(`AUDIT_PRODUCT_DISTRIBUTION_20X_PASS=${pass}/20`);
