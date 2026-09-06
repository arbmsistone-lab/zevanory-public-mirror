import { writeFile } from 'node:fs/promises';
import { ZEVANORY_PRODUCTS } from '../src/offerCatalog.mjs';
import { buildNuvemshopCsv } from '../src/nuvemshopCsvFallback.mjs';

const rows=ZEVANORY_PRODUCTS.map(item=>({
  name:item.commercial_name,
  sku:item.sku,
  price:item.pilot_price_brl,
  sale_price:null,
  stock:'-',
  visible:true,
  description:`Produto digital oficial ${item.brand}, versão ${item.version}. Entrega digital segura após pagamento confirmado.`,
}));
const csv=buildNuvemshopCsv(rows,{mode:'create'});
const target=new URL('../launch/NUVEMSHOP-CONTINGENCY-CREATE-v1.1.csv',import.meta.url);
await writeFile(target,csv,'utf8');
console.log(JSON.stringify({ok:true,file:'launch/NUVEMSHOP-CONTINGENCY-CREATE-v1.1.csv',rows:rows.length,mode:'create',identifier_url:'empty_by_design'}));
