#!/usr/bin/env python3
"""Static guard of an owner-gated, NOT-MERGED launch candidate."""
from pathlib import Path
import ast
s=Path("scripts/deploy/prepare-central-candidate.py").read_text(encoding="utf-8")
ast.parse(s)
required=[
  'ZEVANORY_LAUNCH_AUTHORIZATION',
  'AUTORIZO COMPRA REAL',
  'MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16',
  'LAUNCH_COLLECTOR_PROOF_MISSING',
  'MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED',
  'LAUNCH_PRODUCTION_WEBHOOK_UNVERIFIED',
  'c["vars"]["MERCADOPAGO_ENV"]="production"',
  'c["vars"]["MERCADOPAGO_ENV"]="sandbox"',
  'c["vars"]["CERTIFICATION_PILOT_PRODUCTION_ALLOWED"]="false"',
  'c["vars"]["ABSOLUTE_RELEASE_APPROVED"]="false"',
  'c["vars"]["SALE_GLOBALLY_ENABLED"]="false"',
  'c["vars"]["PRE_SALE_GATES_APPROVED"]="false"',
]
for needle in required:
    assert needle in s, "LAUNCH_GUARD_MISSING:"+needle[:35]
assert s.index('launch_authorized=')<s.index('c["vars"]["MERCADOPAGO_ENV"]="production"')
assert s.index('LAUNCH_COLLECTOR_PROOF_MISSING')<s.index('c["vars"]["MERCADOPAGO_ENV"]="production"')
assert s.index('LAUNCH_PRODUCTION_WEBHOOK_UNVERIFIED')<s.index('c["vars"]["MERCADOPAGO_ENV"]="production"')
# D: open sales require a complete owner authorization record; the release flag is derived.
sc=Path("worker/sales-control.mjs").read_text(encoding="utf-8")
for needle in ['OWNER_SALES_AUTHORIZATION = "LIBERAR VENDAS"','owner_authorization_incomplete','validOwnerAuthorization(parsed, now)']:
    assert needle in sc, "SALES_AUTH_GUARD_MISSING:"+needle[:35]
cm=Path("worker/commercial-metrics-projection.mjs").read_text(encoding="utf-8")
assert "commercial_release_allowed:releaseAllowed" in cm and "const releaseAllowed=verified&&salesRelease===true" in cm, "RELEASE_FLAG_NOT_DERIVED"
assert "coalesce(certification_pilot,false)=false and created_at >= $1" in cm, "CHECKOUTS_NOT_PRODUCTION_ONLY"
cp=Path("worker/cloudflare-worker.compat.mjs").read_text(encoding="utf-8")
assert "alertFinancialProofStale" in cp and "salesRelease: safeRelease" in cp, "STALE_PROOF_ALERT_OR_RELEASE_WIRING_MISSING"
q=Path(".github/workflows/zevanory-three-provider-quorum.yml").read_text(encoding="utf-8")
assert 'auth.get("state")=="open_authorized"' in q and 'auth.get("authorized_by_owner") is True' in q and "commercial_safe=locked or authorized_open" in q, "QUORUM_TRANSITION_MISSING"
print("STAGED_LAUNCH_CONFIG_FAIL_CLOSED_STATIC=PASS")
