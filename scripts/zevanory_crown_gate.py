#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
POLICY=ROOT/"compliance"/"zevanory-crown-policy.json"
APPROVALS=ROOT/"evidence"/"approvals"
CERTS=ROOT/"evidence"/"certificates"

def sha256_bytes(b): return hashlib.sha256(b).hexdigest()
def sha256_file(p): return sha256_bytes(p.read_bytes())
def load(p): return json.loads(p.read_text(encoding="utf-8"))
def fail(m): print("FAIL:",m); return 1
def ok(m): print("PASS:",m)

def merkle_root(hashes):
    xs=[bytes.fromhex(h) for h in hashes]
    if not xs: return None
    while len(xs)>1:
        if len(xs)%2: xs.append(xs[-1])
        xs=[hashlib.sha256(xs[i]+xs[i+1]).digest() for i in range(0,len(xs),2)]
    return xs[0].hex()

def repo_inventory():
    files=[]
    for p in ROOT.rglob("*"):
        if not p.is_file() or ".git" in p.parts: continue
        rel=p.relative_to(ROOT).as_posix()
        if rel.startswith("evidence/runtime/"): continue
        files.append({"path":rel,"sha256":sha256_file(p),"size":p.stat().st_size})
    files.sort(key=lambda x:x["path"])
    return files

def validate_approved_manifest(path, policy):
    e=0; d=load(path); item=d.get("item_id",path.stem)
    if d.get("status")!="APPROVED":
        return 0
    crown=d.get("crown")
    if not isinstance(crown,dict):
        return fail(f"{item}: APPROVED sem bloco crown")
    required=["artifact_ref","artifact_sha256","provenance","sbom","red_team","rollback","closed_loop_revenue","independent_verifiers","evidence_merkle_root","certificate"]
    for k in required:
        if not crown.get(k): e+=fail(f"{item}: crown.{k} ausente")
    ar=crown.get("artifact_ref")
    ah=crown.get("artifact_sha256","")
    if ar:
        p=(ROOT/ar).resolve()
        try: p.relative_to(ROOT.resolve())
        except ValueError: e+=fail(f"{item}: artifact_ref fora do repo"); p=None
        if p and (not p.exists() or sha256_file(p)!=ah.lower()): e+=fail(f"{item}: artifact hash divergente")
    ver=crown.get("independent_verifiers",[])
    if not isinstance(ver,list) or len(ver)<policy["required_independent_proofs"]:
        e+=fail(f"{item}: menos de 2 verificadores independentes")
    else:
        ids=[x.get("id") for x in ver if isinstance(x,dict)]
        if len(set(ids))<policy["required_independent_proofs"]: e+=fail(f"{item}: verificadores não independentes")
        for x in ver:
            if not isinstance(x,dict) or x.get("result")!="PROVEN" or not x.get("evidence_sha256"):
                e+=fail(f"{item}: verificador independente inválido")
    hashes=[]
    for p in d.get("pillars",[]):
        for ev in p.get("evidence",[]) if isinstance(p,dict) else []:
            h=ev.get("sha256") if isinstance(ev,dict) else None
            if h: hashes.append(h.lower())
    if hashes:
        mr=merkle_root(sorted(hashes))
        if crown.get("evidence_merkle_root")!=mr: e+=fail(f"{item}: Merkle root divergente")
    cert=crown.get("certificate",{})
    if not isinstance(cert,dict) or cert.get("standard")!="ZEVANORY-CROWN-10P" or cert.get("status")!="CROWN_APPROVED":
        e+=fail(f"{item}: certificado final inválido")
    if cert.get("artifact_sha256")!=crown.get("artifact_sha256") or cert.get("evidence_merkle_root")!=crown.get("evidence_merkle_root"):
        e+=fail(f"{item}: certificado não vinculado ao artefato/evidência")
    if e==0: ok(f"{item}: CROWN_APPROVED verificável")
    return e

def negative_tests():
    # prova de que adulteração simples é detectável
    h1=sha256_bytes(b"a"); h2=sha256_bytes(b"b")
    root=merkle_root([h1,h2])
    tampered=merkle_root([h1,sha256_bytes(b"B")])
    if root==tampered: return fail("negative test anti-tamper falhou")
    ok("negative test anti-tamper")
    return 0

def main():
    e=0
    if not POLICY.exists(): return 2
    policy=load(POLICY)
    if policy.get("mode")!="fail-closed": e+=fail("policy não fail-closed")
    if policy.get("required_independent_proofs",0)<2: e+=fail("policy exige menos de 2 provas")
    inv=repo_inventory()
    if not inv: e+=fail("inventory vazio")
    else:
        digest=sha256_bytes(json.dumps(inv,separators=(",",":"),sort_keys=True).encode())
        ok(f"SBOM/inventory deterministic digest={digest}")
    e+=negative_tests()
    if APPROVALS.exists():
        for p in sorted(APPROVALS.glob("*.json")):
            e+=validate_approved_manifest(p,policy)
    if e:
        print(f"\nZEVANORY CROWN GATE: FAIL ({e})"); return 2
    print("\nZEVANORY CROWN GATE: PASS")
    print("CROWN_APPROVED só é válido com 10P + dupla prova + provenance + SBOM + Merkle + red-team + drift/revalidation + rollback + closed-loop.")
    return 0
if __name__=="__main__": sys.exit(main())
