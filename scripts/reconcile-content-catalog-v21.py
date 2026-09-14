from pathlib import Path
import json,re
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'products/releases/v2.1/build-manifest.json').read_text(encoding='utf-8'))['products']
path=root/'src/offerCatalog.mjs'; s=path.read_text(encoding='utf-8')
rows={
'ZEV-IA-011':('ZEVANORY IA na Prática','ZEVANORY_IA_na_Pratica_v2.1.zip',197,147),
'ZEV-VEN-011':('ZEVANORY Vendas na Prática','ZEVANORY_Vendas_na_Pratica_v2.1.zip',197,147),
'ZEV-LCX-011':('ZEVANORY Lucro & Caixa','ZEVANORY_Lucro_e_Caixa_v2.1.zip',247,197),
'ZEV-CMB-011':('ZEVANORY Combo IA + Vendas','ZEVANORY_Combo_IA_e_Vendas_v2.1.zip',297,247),
'ZEV-NGC-011':('ZEVANORY Negócio Completo','ZEVANORY_Negocio_Completo_v2.1.zip',397,347),
}
for sku,(name,artifact,table,pilot) in rows.items():
    role=",portfolio_role:'content_bundle'" if sku=='ZEV-NGC-011' else ''
    newline=f"  Object.freeze({{sku:'{sku}',product:'{name}',commercial_name:'{name} - by ARBM',brand:'ZEVANORY',endorsed_by:'ARBM',brand_signature:'by ARBM',version:'2.1',offer_type:'digital_product',delivery_mode:'digital',fulfillment_channel:'secure_download_after_payment',artifact_name:'{artifact}',artifact_sha256:'{manifest[sku]['sha256']}',table_price_brl:{table},pilot_price_brl:{pilot},price_status:'pilot_hypothesis_not_validated',primary:false{role},sellable:false,artifact_materialized:true,content_quality_certified:true,quality_certified:false,quality_standard:'excellence_100_confidence_99_evidence_required',content_quality_profile:'master_senior_v21',status:'content_quality_certified_global_sales_gate_blocked_not_published'}}),"
    s,n=re.subn(rf"^  Object\.freeze\(\{{sku:'{re.escape(sku)}'.*$",newline,s,count=1,flags=re.M)
    if n!=1: raise SystemExit(f'catalog row not found: {sku}')
path.write_text(s,encoding='utf-8',newline='\n')
print('CATALOG_RECONCILED_V21')
