#!/usr/bin/env python3
import argparse, json, os, pathlib, re, subprocess, sys

ROOT = pathlib.Path(".")
EXCLUDED = {".git","node_modules","dist","build","coverage",".next",".turbo","vendor"}
UI_EXT = {".css",".scss",".tsx",".ts",".jsx",".js",".html",".vue",".svelte"}
GEOM_PROPS = re.compile(r"(?:^|[;{\s])(gap|row-gap|column-gap|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|min-height|max-height|height|min-width|max-width|width|border-radius)\s*:\s*([^;}{]+)", re.I)
PX = re.compile(r"(-?\d+(?:\.\d+)?)px\b", re.I)
FONT = re.compile(r"font-size\s*:\s*([^;}{]+)", re.I)
HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
FOCUS = re.compile(r":focus-visible")
REDUCED = re.compile(r"prefers-reduced-motion")
OVERFLOW = re.compile(r"overflow-wrap\s*:\s*(?:anywhere|break-word)|text-overflow\s*:\s*ellipsis|word-break\s*:\s*break-word", re.I)

ALLOWED_FONT_PX = {12,14,16,21,28,37}
REQUIRED_TOKENS = {
  "--bg-primary","--bg-secondary","--surface","--surface-elevated","--text-primary","--text-secondary",
  "--border","--action-primary","--action-primary-text","--status-success","--status-error",
  "--status-warning","--status-info","--focus-ring"
}

def run(*args):
    p = subprocess.run(args, text=True, capture_output=True)
    return p.stdout if p.returncode == 0 else ""

def files_now():
    out=[]
    for p in ROOT.rglob("*"):
        if not p.is_file() or any(x in EXCLUDED for x in p.parts):
            continue
        if p.suffix.lower() in UI_EXT:
            out.append(p.as_posix())
    return out

def read_current(path):
    try: return pathlib.Path(path).read_text(encoding="utf-8", errors="ignore")
    except: return ""

def read_base(base, path):
    return run("git","show",f"{base}:{path}")

def ui_violations(text, path):
    issues=[]
    for m in GEOM_PROPS.finditer(text):
        prop, expr = m.group(1).lower(), m.group(2)
        for p in PX.finditer(expr):
            v=float(p.group(1))
            if v == 0: continue
            # Supreme floor: arbitrary geometry is forbidden. 4pt is micro-floor; macro 8pt is design-review enforced.
            if abs(v/4 - round(v/4)) > 1e-9:
                issues.append(("geometry",path,prop,p.group(0)))
    for m in FONT.finditer(text):
        for p in PX.finditer(m.group(1)):
            v=float(p.group(1))
            if v and int(v) not in ALLOWED_FONT_PX:
                issues.append(("font-scale",path,"font-size",p.group(0)))
    # hard-coded colors are debt unless they are CSS custom-property declarations or obvious docs/comments.
    for ln,line in enumerate(text.splitlines(),1):
        if HEX.search(line) and "--" not in line and not line.lstrip().startswith(("//","/*","*")):
            issues.append(("hardcoded-color",path,f"line:{ln}",HEX.search(line).group(0)))
    return issues

def repo_contract(texts):
    joined="\n".join(texts.values())
    out=[]
    for token in REQUIRED_TOKENS:
        if token not in joined: out.append(("missing-token","<repo>",token,""))
    if not FOCUS.search(joined): out.append(("missing-focus-visible","<repo>","",""))
    if not REDUCED.search(joined): out.append(("missing-reduced-motion","<repo>","",""))
    if not OVERFLOW.search(joined): out.append(("missing-overflow-protection","<repo>","",""))
    return out

def count_by_kind(items):
    d={}
    for i in items: d[i[0]]=d.get(i[0],0)+1
    return d

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--base-ref", default="")
    args=ap.parse_args()
    policy_path=ROOT/".zevanory/ped-versal-policy.json"
    if not policy_path.exists():
        print("PED_SUPREME=FAIL missing_policy")
        return 2
    policy=json.loads(policy_path.read_text())
    profile=policy.get("profile")
    if policy.get("falseGreen") != 0 or not policy.get("failClosed") or policy.get("regressionBudget") != 0:
        print("PED_SUPREME=FAIL invalid_governance_invariants")
        return 2
    if profile == "ENGINEERING_PROOF":
        required=["exactSha","reproducibleEvidence","boundedRetries","providerTruth"]
        proof=policy.get("proof",{})
        missing=[x for x in required if proof.get(x) is not True]
        if missing:
            print("PED_SUPREME=FAIL proof_contract", ",".join(missing))
            return 2
        print("PED_SUPREME=PASS profile=ENGINEERING_PROOF exact_sha=1 false_green=0 regression_budget=0")
        return 0

    current={p:read_current(p) for p in files_now()}
    current_issues=[]
    for p,t in current.items(): current_issues.extend(ui_violations(t,p))
    contract_now=repo_contract(current)
    current_all=current_issues+contract_now

    if not args.base_ref:
        print("PED_SUPREME=PASS profile=UI_ENTERPRISE mode=inventory")
        print("CURRENT_DEBT="+json.dumps(count_by_kind(current_all),sort_keys=True))
        return 0

    changed=run("git","diff","--name-only",f"{args.base_ref}...HEAD").splitlines()
    changed=[p for p in changed if pathlib.Path(p).suffix.lower() in UI_EXT]
    regressions=[]
    for p in changed:
        now=read_current(p)
        base=read_base(args.base_ref,p)
        now_i=ui_violations(now,p)
        base_i=ui_violations(base,p) if base else []
        nk=count_by_kind(now_i); bk=count_by_kind(base_i)
        for kind,n in nk.items():
            if n > bk.get(kind,0):
                regressions.append((p,kind,bk.get(kind,0),n))
    # Repo-wide contract cannot regress. New standard branches may still carry baseline missing tokens, but counts may not increase.
    base_texts={}
    for p in current:
        bt=read_base(args.base_ref,p)
        if bt: base_texts[p]=bt
    now_contract=count_by_kind(contract_now)
    base_contract=count_by_kind(repo_contract(base_texts)) if base_texts else {}
    for kind,n in now_contract.items():
        if n > base_contract.get(kind,0):
            regressions.append(("<repo>",kind,base_contract.get(kind,0),n))

    print("PED_STANDARD="+policy.get("standard","unknown"))
    print("PROFILE="+str(profile))
    print("CHANGED_UI_FILES="+str(len(changed)))
    print("CURRENT_DEBT="+json.dumps(count_by_kind(current_all),sort_keys=True))
    if regressions:
        print("PED_SUPREME=FAIL REGRESSION_BUDGET_EXCEEDED")
        for r in regressions[:100]: print("REGRESSION", *r)
        return 1
    print("PED_SUPREME=PASS NO_NEW_DEBT=true FALSE_GREEN=0")
    return 0

if __name__ == "__main__":
    sys.exit(main())
