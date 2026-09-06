const clean=(v,max=5000)=>String(v??'').trim().slice(0,max);
const yesNo=(v)=>v===true||String(v).toUpperCase()==='SIM'?'SIM':v===false||String(v).toUpperCase()==='NAO'||String(v).toUpperCase()==='NÃO'?'NÃO':null;
const money=(v)=>{const n=Number(v);if(!Number.isFinite(n)||n<0)throw new Error('nuvemshop_price_invalid');return n.toFixed(2);};
const esc=(v)=>{const s=String(v??'');return /[",\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`:s;};
export const NUVEMSHOP_CSV_MAX_ROWS=20000;
export const NUVEMSHOP_CSV_COLUMNS=Object.freeze([
  'Identificador URL','Nome','Preço','Preço promocional','Estoque','SKU','Exibir na loja','Descrição'
]);

export function normalizeNuvemshopCsvRow(input,{mode='create'}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('nuvemshop_row_invalid');
  const name=clean(input.name,300);if(!name)throw new Error('nuvemshop_name_required');
  const sku=clean(input.sku,200);if(!sku)throw new Error('nuvemshop_sku_required');
  const identifier=clean(input.identifier_url,500);
  if(mode==='create'&&identifier)throw new Error('nuvemshop_identifier_must_be_empty_for_create');
  if(mode==='update'&&!identifier)throw new Error('nuvemshop_identifier_required_for_update');
  const visible=yesNo(input.visible??true);if(!visible)throw new Error('nuvemshop_visible_invalid');
  const stock=input.stock==='-'?'-':String(Number.isInteger(Number(input.stock))&&Number(input.stock)>=0?Number(input.stock):'-');
  return Object.freeze({
    'Identificador URL':identifier,'Nome':name,'Preço':money(input.price),'Preço promocional':input.sale_price==null?'':money(input.sale_price),
    'Estoque':stock,'SKU':sku,'Exibir na loja':visible,'Descrição':clean(input.description,10000),
  });
}
export function buildNuvemshopCsv(rows,{mode='create'}={}){
  if(!Array.isArray(rows)||rows.length===0)throw new Error('nuvemshop_rows_required');
  if(rows.length>NUVEMSHOP_CSV_MAX_ROWS)throw new Error('nuvemshop_row_limit_exceeded');
  const normalized=rows.map(row=>normalizeNuvemshopCsvRow(row,{mode}));
  const skus=new Set();for(const row of normalized){if(skus.has(row.SKU))throw new Error('nuvemshop_sku_duplicate');skus.add(row.SKU);}
  const header=NUVEMSHOP_CSV_COLUMNS.map(esc).join(',');
  const body=normalized.map(row=>NUVEMSHOP_CSV_COLUMNS.map(key=>esc(row[key])).join(',')).join('\r\n');
  return `\uFEFF${header}\r\n${body}\r\n`;
}

export function nuvemshopCsvFallbackReadiness(env=process.env){
  const verified=String(env.NUVEMSHOP_CSV_FALLBACK_VERIFIED||'').toLowerCase()==='true';
  return Object.freeze({supported:true,ready:verified,mode:'admin_csv',provider:'nuvemshop_admin',blockers:Object.freeze(verified?[]:['NUVEMSHOP_CSV_FALLBACK_VERIFIED'])});
}
