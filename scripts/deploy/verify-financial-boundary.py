#!/usr/bin/env python3
"""No secret changes. Verify either closed-by-default or explicitly authorized launch config."""
import json
import os
import re

with open("wrangler.central-fix.jsonc", encoding="utf-8") as f:
    vars = json.load(f).get("vars", {})

assert str(vars.get("SALE_GLOBALLY_ENABLED", "")).lower() == "false", "DEPLOY_MUST_KEEP_SALES_CLOSED"
assert str(vars.get("CERTIFICATION_PILOT_PRODUCTION_ALLOWED", "")).lower() == "false", "NO_PRODUCTION_PILOT"
whatsapp_mode = str(vars.get("WHATSAPP_SALES_ENABLED", "")).lower()
assert whatsapp_mode in ("false", "true"), "WHATSAPP_SALES_MODE_INVALID"
assert str(vars.get("ASAAS_ENV", "")).lower() == "sandbox", "ASAAS_ENV_MUST_BE_SANDBOX"
assert str(vars.get("CERTIFICATION_PILOT_ENV", "")).lower() == "sandbox", "CERTIFICATION_PILOT_MUST_BE_SANDBOX"
assert str(vars.get("PAYMENT_PROVIDER", "")).lower() == "mercadopago", "PRODUCTION_PROVIDER_CHANGED"

authorized = os.getenv("ZEVANORY_LAUNCH_AUTHORIZATION", "") == "AUTORIZO COMPRA REAL"
# An enabled inbound WhatsApp responder is not authorization to bypass the sales
# switch. Only permit it with the independently verified owner launch order.
if whatsapp_mode == "true":
    assert authorized, "WHATSAPP_INBOUND_OWNER_AUTHORIZATION_REQUIRED"
    assert str(vars.get("SALE_GLOBALLY_ENABLED", "")).lower() == "false", "WHATSAPP_CANNOT_OPEN_KV_SWITCH"
    assert vars.get("PRE_SALE_GATES_APPROVED") == "true", "WHATSAPP_INBOUND_GATES_REQUIRED"
runtime = vars.get("ZEVANORY_RUNTIME_CONFIG", {})
assert isinstance(runtime, dict), "RUNTIME_CONFIG_INVALID"
if authorized:
    account_hash = os.getenv("MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16", "").lower()
    assert re.fullmatch(r"[a-f0-9]{16}", account_hash), "LAUNCH_COLLECTOR_PROOF_MISSING"
    assert os.getenv("MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED", "") == "true", "LAUNCH_PRODUCTION_WEBHOOK_UNVERIFIED"
    assert vars.get("MERCADOPAGO_ENV") == "production", "AUTHORIZED_PRODUCTION_ENV_MISSING"
    assert vars.get("ABSOLUTE_RELEASE_APPROVED") == "true", "AUTHORIZED_ABSOLUTE_GATE_MISSING"
    assert vars.get("PRE_SALE_GATES_APPROVED") == "true", "AUTHORIZED_PRE_SALE_GATE_MISSING"
    assert runtime.get("MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16") == account_hash, "COLLECTOR_HASH_RUNTIME_MISMATCH"
    assert "MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16" not in vars, "COLLECTOR_HASH_UNCOMPACTED"
else:
    assert vars.get("MERCADOPAGO_ENV") == "sandbox", "PRODUCTION_MERCADOPAGO_NOT_AUTHORIZED"
    assert vars.get("ABSOLUTE_RELEASE_APPROVED") == "false", "ABSOLUTE_GATE_MUST_BE_FALSE"
    assert vars.get("PRE_SALE_GATES_APPROVED") == "false", "PRE_SALE_GATE_MUST_BE_FALSE"
    assert "MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16" not in runtime, "PRODUCTION_HASH_WITHOUT_AUTH"

print("CORE_DEPLOY_FINANCIAL_BOUNDARY=PASS")
print("FINANCIAL_SECRETS_MUTATION=DECOUPLED")
print("SALES_DEPLOYED_CLOSED=PASS")
