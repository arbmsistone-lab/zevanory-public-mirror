#!/usr/bin/env python3
import json
c=json.load(open("wrangler.central-fix.jsonc",encoding="utf-8"))
v=c.get("vars",{})
assert str(v.get("SALE_GLOBALLY_ENABLED","")).lower()=="false"
assert str(v.get("PRE_SALE_GATES_APPROVED","")).lower()=="false"
assert str(v.get("ASAAS_ENV","")).lower()=="sandbox", "ASAAS_ENV_MUST_BE_SANDBOX"
assert str(v.get("CERTIFICATION_PILOT_ENV","")).lower()=="sandbox", "CERTIFICATION_PILOT_MUST_BE_SANDBOX"
assert str(v.get("MERCADOPAGO_ENV","")).lower()=="sandbox", "PRODUCTION_MERCADOPAGO_NOT_AUTHORIZED"
assert str(v.get("PAYMENT_PROVIDER","")).lower()=="mercadopago", "PRODUCTION_PROVIDER_CHANGED"
assert str(v.get("WHATSAPP_SALES_ENABLED","")).lower()=="false"
print("CORE_DEPLOY_FINANCIAL_BOUNDARY=PASS")
print("FINANCIAL_SECRETS_MUTATION=DECOUPLED")
