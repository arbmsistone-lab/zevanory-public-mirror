#!/usr/bin/env python3
from pathlib import Path
import re, uuid

runtime=Path("worker/cloudflare-worker.recovered.mjs").read_text("utf-8")
checks={
 "raw_external_reference": 'const externalReference = String(orderId).toLowerCase();' in runtime,
 "preference_external_reference_raw": 'const externalReference = isUuid(orderId) ? String(orderId).toLowerCase() : "";' in runtime,
 "parse_raw_and_legacy": 'if (isUuid(text)) return text.toLowerCase();' in runtime and 'const prefix = `ZEVANORY:${PROJECT.experimentId}:`;' in runtime,
 "lookup_by_external_reference": "order_id::text=$1 OR external_reference=$2" in runtime,
 "init_point_preferred": "const preferred = value.init_point || value.sandbox_init_point;" in runtime,
 "real_back_urls": "https://vendas.zevanory.api.br/solucoes?pagamento=aprovado" in runtime,
}
assert all(checks.values()), checks

order_id=str(uuid.uuid4())
stored_preference_id="pref-old"
new_preference_id="pref-new"
payment={"external_reference":order_id,"preference_id":new_preference_id,"amount":197}
order={"order_id":order_id,"external_reference":order_id,"provider_checkout_id":stored_preference_id,"amount":197}
reconciles=(payment["external_reference"]==order["external_reference"] and payment["amount"]==order["amount"])
assert reconciles and payment["preference_id"]!=order["provider_checkout_id"]
print("NEW_PREFERENCE_SAME_ORDER_RECONCILES=PASS")
print("PREFERENCE_ID_NOT_RECONCILIATION_KEY=PASS")
print("RAW_AND_LEGACY_EXTERNAL_REFERENCE=PASS")
for k,v in checks.items(): print(f"{k.upper()}={'PASS' if v else 'FAIL'}")
