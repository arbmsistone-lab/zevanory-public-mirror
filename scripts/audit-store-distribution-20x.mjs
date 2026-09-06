import { readFileSync } from 'node:fs';
import { ZEVANORY_PRODUCTS, publicOffer } from '../src/offerCatalog.mjs';
import { digitalFulfillmentReadiness } from '../src/digitalFulfillment.mjs';
const handoff=readFileSync(new URL('../launch/ZEVANORY-PRODUCTS-V11-HANDOFF.md',import.meta.url),'utf8');
let pass=0;
for(let i=1;i<=20;i++){
  const offer=publicOffer({ZEVANORY_PRODUCT_HANDOFF_V21_VERIFIED:'true',ZEVANORY_SECURE_ARTIFACT_DELIVERY_READY:'true'});
  const blocked=digitalFulfillmentReadiness({order_status:'created',payment_confirmed:false});
  const ok=ZEVANORY_PRODUCTS.length===5&&
    offer.id==='ZEV-NGC-011'&&offer.price_brl===347&&offer.integrity_verified===true&&offer.secure_delivery_ready===true&&offer.artifact_commercially_releasable===true&&
    blocked.ready===false&&blocked.public_download===false&&blocked.blockers.includes('payment_not_reconciled')&&
    handoff.includes('handoff comercial v2.1 certificado')&&handoff.includes('entrega exige pagamento autenticado e reconciliado');
  if(!ok){console.error(`PRODUCT_DISTRIBUTION_AUDIT_${i}=FAIL`);process.exit(1);}pass++;console.log(`PRODUCT_DISTRIBUTION_AUDIT_${i}=PASS`);
}
console.log(`AUDIT_PRODUCT_DISTRIBUTION_20X_PASS=${pass}/20`);
