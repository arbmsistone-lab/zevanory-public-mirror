# EG-0069 — G3 supplier-to-offer linkage

Date: 2026-09-08
Status: G3 LINKAGE CERTIFIED / NO COMMERCIAL UNLOCK

## Canonical linkage
The protected Production supplier identity configured by EG-0039 is the legal supplier identity for every SKU in the certified ZEVANORY v2.1 handoff.

Covered offers/SKUs:
- OFFER-0001 — ARBM SIST 10.0.0 — canonical primary ZEVANORY paid offer.
- ZEV-IA-011 — ZEVANORY IA na Prática v1.1 — legacy/catalogued secondary offer.
- ZEV-VEN-011 — ZEVANORY Vendas na Prática v1.1 — legacy/catalogued secondary offer.
- ZEV-LCX-011 — ZEVANORY Lucro & Caixa v1.1 — legacy/catalogued secondary offer.
- ZEV-CMB-011 — ZEVANORY Combo IA + Vendas v1.1 — legacy/catalogued secondary offer.
- ZEV-NGC-011 — ZEVANORY Negócio Completo v1.1 — legacy/catalogued secondary offer.

## Evidence chain
- `evidence/EG-0039-pf-identity-configured.md` proves the real PF supplier identity is stored only in protected Production secrets.
- `launch/ZEVANORY-PRODUCTS-V11-HANDOFF.md` defines the same supplier class for the five certified SKUs and preserves their immutable artifact hashes.
- Production keeps `SUPPLIER_LEGAL_NAME`, `SUPPLIER_TAX_ID`, and `SUPPLIER_ADDRESS` protected; no PII is copied into this repository.
- This linkage does not prove payment, delivery, refund, support receipt, measurement, or commercial readiness.

## Gate result
G3 supplier identity / offer linkage: PASS.
G4-G8 remain independent fail-closed gates.
`SALE_GLOBALLY_ENABLED` must remain false until every remaining gate has observed evidence.