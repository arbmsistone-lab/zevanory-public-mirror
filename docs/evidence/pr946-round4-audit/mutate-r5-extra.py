# r5 supplement to the auditor's mutate.py: mutants on the MED-1 validator and the MED-2 fingerprint (replace MA10).
import subprocess, sys, os
R = sys.argv[1]
LR="scripts/p23/legal_review.py"; TG="scripts/p23/trust_anchor_guard.py"; EG="scripts/p23/ecommerce_legal_gate.py"; CW="worker/cloudflare-worker.compat.mjs"
T=["tests/legal-publish-gate.test.mjs","tests/p23-ecommerce-legal.test.mjs"]
M = [
 ("X1 guarda: workflows de deploy não são âncora", TG, "           *DEPLOY_WORKFLOWS)", "           )", T),
 ("X2 guarda: workflow novo que publica não detectado", TG, "    new_deploy = [p for p in paths if p.startswith(\".github/workflows/\") and p not in hit", "    new_deploy = [p for p in paths if False and p not in hit", T),
 ("X3 validador: continue-on-error/if no passo aceitos", TG, "    extra = set(steps[g][\"keys\"]) - {\"name\", \"run\", \"id\"}", "    extra = set()", T),
 ("X4 validador: passos antes do portão aceitos", TG, "        if set(st[\"keys\"]) - {\"uses\", \"with\", \"name\", \"id\"} or not SETUP_USES.match(uses):", "        if False:", T),
 ("X5 validador: deploy sem integridade aceito", TG, "        if not ok:\n            errs.append(f\"{name}: passo que publica", "        if False:\n            errs.append(f\"{name}: passo que publica", T),
 ("X6 validador: always() em passo que publica aceito", TG, "        if STATUS_FN.search(cond):", "        if False:", T),
 ("X7 validador: defaults aceito", TG, "        if k == \"defaults\":", "        if False:", T),
 ("X8 validador: BASH_ENV aceito", TG, "FORBIDDEN_ENV = re.compile(r\"^(BASH_ENV|ENV|PATH|", "FORBIDDEN_ENV = re.compile(r\"^(NADA|", T),
 ("X9 validador: outro job publica aceito", TG, "        if jk != \"deploy\" and deploys(", "        if False and deploys(", T),
 ("X10 validação estrutural fora do PR (sem GATE_INVALID)", TG, "    invalid = validate_tree(lambda p: show(a.pr_repo, a.head_sha, p))", "    invalid = []", T),
 ("Y1 impressão digital só do <main>", LR, "    m = re.search(r\"<body\\b[^>]*>(.*)\", s, re.S | re.I)", "    m = re.search(r\"<main\\b[^>]*>(.*?)</main\", s, re.S | re.I)", T),
 ("Y2 comentários não removidos", LR, "    s = re.sub(r\"<!--.*?(?:-->|\\Z)\", \" \", raw, flags=re.S)", "    s = raw", T),
 ("Y3 dois <main> aceitos", LR, "    if opened != 1 or closed != 1:", "    if opened < 1:", T),
 ("Y4 privacidade/afiliados fora da impressão digital", LR, ",\n               \"sales-public/privacidade.html\", \"sales-public/afiliados.html\", \"privacidade/index.html\", \"afiliados/index.html\")", ")", T),
 ("Y5 P23 visible() sem remover comentários", EG, "    s = re.sub(r\"<!--.*?(?:-->|\\Z)\", \" \", raw, flags=re.S)\n", "    s = raw\n", T),
 ("Z1 lista desligada lê KV antes do 404", CW, "    if (!waitlistEnabled(normalized)) {\n      const off", "    if (false) {\n      const off", ["tests/waitlist-canonical-sales.test.mjs"]),
]
def run(tests):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    r = subprocess.run(["node","--test",*tests], cwd=R, capture_output=True, text=True, env=env, timeout=900)
    return r.returncode, [l.strip() for l in r.stdout.splitlines() if l.strip().startswith("not ok")]
for name, f, old, new, tests in M:
    p=os.path.join(R,f); s=open(p,encoding="utf-8").read()
    if s.count(old)!=1: print(f"{name}: ANCHOR_MISSING(count={s.count(old)})", flush=True); continue
    open(p,"w",encoding="utf-8").write(s.replace(old,new))
    try: rc, fails = run(tests)
    finally: open(p,"w",encoding="utf-8").write(s)
    print(f"{name}: {'KILLED' if rc!=0 else 'SURVIVED'} {'; '.join(x[:90] for x in fails[:2])}", flush=True)
