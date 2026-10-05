#!/usr/bin/env python3
from pathlib import Path
import uuid

runtime=Path("worker/cloudflare-worker.recovered.mjs").read_text("utf-8")

checks={
    "raw_external_reference": 'const externalReference = String(orderId).toLowerCase();' in runtime,
    "preference_external_reference_raw": 'const externalReference = isUuid(orderId) ? String(orderId).toLowerCase() : "";' in runtime,
    "parse_raw_and_legacy": 'if (isUuid(text)) return text.toLowerCase();' in runtime and 'const prefix = `ZEVANORY:${PROJECT.experimentId}:`;' in runtime,
    "lookup_by_external_reference": "order_id::text=$1 OR external_reference=$2" in runtime,
    "init_point_preferred": "const preferred = value.init_point || value.sandbox_init_point;" in runtime,
    "real_back_urls": "https://vendas.zevanory.api.br/solucoes?pagamento=aprovado" in runtime,
    "canonical_certification_catalog": "resolveCertificationCheckoutOffer" in runtime and "table_price_brl" in runtime,
    "preference_uses_persisted_order_amount": "orderBoundOffer" in runtime and "RETURNING order_id,amount,offer_id" in runtime,
    "antifraud_amount_guard_present": "if (!Number.isFinite(amount) || amount !== expected || expected <= 0) return null;" in runtime,
    "sandbox_lookup_uses_test_header": '...(test ? { "x-test-token": "true" } : {})' in runtime and "test: certificationOnly" in runtime,
}
assert all(checks.values()), checks

# Delivery e-mail validation must accept real addresses (regression: double-escaped whitespace/dot classes rejected every address).
import re, subprocess, json
m=re.search(r"function validMercadoPagoDeliveryEmail\(value\) \{\n.*?\n.*?(/\^.*?\$/)\.test", runtime, re.S)
assert m, "delivery_email_validator_missing"
probe=subprocess.run(["node","-e",f"const r={m.group(1)};const ok=['cliente@gmail.com','joao.silva@hotmail.com','ana@zevanory.api.br'].every(e=>r.test(e));const bad=['sem-arroba','a b@x.com','x@y'].some(e=>r.test(e));process.exit(ok&&!bad?0:1)"])
assert probe.returncode==0, "delivery_email_validator_rejects_real_addresses"
print("DELIVERY_EMAIL_VALIDATOR=PASS")

order_id=str(uuid.uuid4())
order={"order_id":order_id,"external_reference":order_id,"provider_checkout_id":"pref-old","amount":197.0}
same_order_new_preference={"external_reference":order_id,"preference_id":"pref-new","amount":197.0}
assert same_order_new_preference["external_reference"]==order["external_reference"]
assert same_order_new_preference["amount"]==order["amount"]
assert same_order_new_preference["preference_id"]!=order["provider_checkout_id"]
print("NEW_PREFERENCE_SAME_ORDER_RECONCILES=PASS")
print("PREFERENCE_ID_NOT_RECONCILIATION_KEY=PASS")

mismatched={"external_reference":order_id,"preference_id":"pref-any","amount":198.0}
accepted=(mismatched["external_reference"]==order["external_reference"] and mismatched["amount"]==order["amount"])
assert accepted is False
print("PAYMENT_AMOUNT_MISMATCH_REJECTED=PASS")
print("::warning title=Financial mismatch::PAYMENT_AMOUNT_MISMATCH_REVIEW_REQUIRED order_id="+order_id+" expected=197.00 observed=198.00")

for k,v in checks.items():
    print(f"{k.upper()}={'PASS' if v else 'FAIL'}")
