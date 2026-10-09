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
  'c["vars"]["ABSOLUTE_RELEASE_APPROVED"]="true"',
  'c["vars"]["PRE_SALE_GATES_APPROVED"]="true"',
]
for needle in required:
    assert needle in s, "LAUNCH_GUARD_MISSING:"+needle[:35]
assert s.index('launch_authorized=')<s.index('c["vars"]["MERCADOPAGO_ENV"]="production"')
assert s.index('LAUNCH_COLLECTOR_PROOF_MISSING')<s.index('c["vars"]["MERCADOPAGO_ENV"]="production"')
assert s.index('LAUNCH_PRODUCTION_WEBHOOK_UNVERIFIED')<s.index('c["vars"]["MERCADOPAGO_ENV"]="production"')
# Require false-by-default flags BEFORE owner-gated overrides.
for field in ('ABSOLUTE_RELEASE_APPROVED','PRE_SALE_GATES_APPROVED'):
    off=f'c["vars"]["{field}"]="false"'
    on=f'c["vars"]["{field}"]="true"'
    assert s.index(off)<s.index(on), "LAUNCH_FLAG_OVERRIDE_ORDER_INVALID:"+field
    assert s.index('if launch_authorized:',s.index(off))<s.index(on), "LAUNCH_OVERRIDE_NOT_GATED:"+field
assert 'c["vars"]["SALE_GLOBALLY_ENABLED"]="true"' not in s, "DEPLOY_MUST_NOT_OPEN_SALES"
wf=Path(".github/workflows/central-production-deploy.yml").read_text(encoding="utf-8")
reconstruct=wf.split('- name: Reconstruct exact production candidate',1)[1].split('run: |',1)[0]
for var in ('ZEVANORY_LAUNCH_AUTHORIZATION','MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16','MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED'):
    assert var+': ${{ vars.'+var+' }}' in reconstruct, "LAUNCH_ENV_BINDING_MISSING:"+var
guard=Path("worker/commercial-checkout-guard.mjs").read_text(encoding="utf-8")
assert 'sw?.authorized===true' in guard and 'sw?.enabled===true' in guard, "KV_OWNER_AUTHORIZATION_REQUIRED"
status=Path("worker/cloudflare-worker.compat.mjs").read_text(encoding="utf-8")
assert "salesSwitch.authorized === true" in status, "COMMERCIAL_STATUS_OWNER_SWITCH_REQUIRED"
# Hash16 shares the existing compact runtime binding instead of exceeding Workers Free budget.
assert 'c["vars"].setdefault("ZEVANORY_RUNTIME_CONFIG",{})["MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16"]=collector_hash' in s, "COLLECTOR_HASH_MUST_USE_COMPACT_RUNTIME"
assert 'c["vars"]["MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16"]=collector_hash' not in s, "COLLECTOR_HASH_NEW_BINDING_FORBIDDEN"
# The downstream financial-boundary step must receive the same authorization as the preparer.
verify=wf.split('- name: Verify financial safety boundary without mutating secrets',1)[1].split('run: |',1)[0]
for var in ('ZEVANORY_LAUNCH_AUTHORIZATION','MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16','MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED'):
    assert var+': ${{ vars.'+var+' }}' in verify, "FINANCIAL_BOUNDARY_AUTH_ENV_MISSING:"+var
boundary=Path("scripts/deploy/verify-financial-boundary.py").read_text(encoding="utf-8")
for invariant in ('DEPLOY_MUST_KEEP_SALES_CLOSED','AUTHORIZED_PRODUCTION_ENV_MISSING','PRODUCTION_MERCADOPAGO_NOT_AUTHORIZED','LAUNCH_COLLECTOR_PROOF_MISSING','LAUNCH_PRODUCTION_WEBHOOK_UNVERIFIED'):
    assert invariant in boundary, "BOUNDARY_GUARD_MISSING:"+invariant
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
