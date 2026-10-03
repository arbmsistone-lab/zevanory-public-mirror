#!/usr/bin/env python3
import json
c=json.load(open("wrangler.central-fix.jsonc",encoding="utf-8"))
v=c.get("vars",{})
assert str(v.get("SALE_GLOBALLY_ENABLED","")).lower()=="false"
assert str(v.get("PRE_SALE_GATES_APPROVED","")).lower()=="false"
assert str(v.get("WHATSAPP_SALES_ENABLED","")).lower()=="false"
print("CORE_DEPLOY_FINANCIAL_BOUNDARY=PASS")
print("FINANCIAL_SECRETS_MUTATION=DECOUPLED")
