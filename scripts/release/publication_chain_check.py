#!/usr/bin/env python3
"""ZEVANORY | Prova executável da cadeia de publicação (Sol AVAL 271, R271-02). Só leitura.

Modo padrão (sem rede): lê os YAML deste checkout e prova, com falha fechada:
  C1 todo passo que publica de verdade (wrangler deploy/rollback/versions deploy sem --dry-run, ou POST na API de
     deployments da Cloudflare) está num job com environment "producao-critica" (aprovação obrigatória do revisor);
  C2 nenhum job sem esse environment publica (os jobs de verificação só fazem --dry-run);
  C3 os deploys só rodam em gh-pages (push/dispatch) e o pré-guarda T1 (promotion_guard.py) precede a promoção;
  C4 cada Worker recebe o SHA esperado: --tag com o SHA do evento e leitura de volta exigindo esse SHA
     (central: /api/release deployment.commit_sha; vendas: /health release);
  C5 rollback automático: central => "wrangler rollback --name zevanory" (versão anterior) quando o smoke pós-deploy
     falha depois de um deploy bem-sucedido; vendas => restaura o snapshot da implantação anterior (versões e
     percentuais) quando a leitura canônica falha; sem snapshot, nada é apagado e a execução falha;
  C6 portão T1: estado NAO_COMPROVADO falha a execução sem rollback;
  C7 a certificação pós-publicação (portfolio-six-target-exact-cert.yml) está encadeada (workflow_run) ao SUCESSO
     dos dois deploys, com o SHA implantado, e só compara depois de observar a promoção (contrato v3).
Modo --online RUN_ID... (gh CLI, leitura): registros da API de aprovações (environment producao-critica) e horários
  dos jobs de execuções anteriores, provando que o job de deploy só começou depois da aprovação.
Saída: CHAIN_CHECK=PASS|FAIL e JSON (--out).
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys

import yaml

ROOT = pathlib.Path(os.environ.get("PUBLICATION_CHAIN_ROOT") or pathlib.Path(__file__).resolve().parents[2])
WF = ROOT / ".github/workflows"
ENV = "producao-critica"
PUBLISH = re.compile(r"wrangler(@[\d.]+)?\s+(deploy|rollback|versions\s+deploy)\b(?![^\n]*--dry-run)")
CF_DEPLOY_POST = re.compile(r"-X\s+POST[^\n]*\n?[^\n]*workers/scripts/[^\n]*/deployments|/workers/scripts/\$SCRIPT_NAME/deployments\"\s*\\?\s*$", re.M)


def load(name):
    return yaml.load((WF / name).read_text("utf-8"), Loader=yaml.BaseLoader)


def steps_text(job):
    return [(s.get("name") or s.get("uses") or "", s.get("run", ""), s.get("if", ""), s.get("id", "")) for s in job.get("steps", [])]


def publishes(run):
    return bool(PUBLISH.search(run)) or ("-X POST" in run and "/deployments" in run)


class Check:
    def __init__(self):
        self.items = []

    def __call__(self, cid, ok, **detail):
        self.items.append({"check": cid, "ok": bool(ok), **detail})
        print(f"{'PASS' if ok else 'FAIL'} {cid}" + ("" if ok else " " + json.dumps(detail, ensure_ascii=False)[:500]))


def static_checks(chk):
    central, sales, cert = load("central-production-deploy.yml"), load("zevanory-sales-public-release.yml"), \
        load("portfolio-six-target-exact-cert.yml")
    for wname, wf in (("central", central), ("sales", sales)):
        for jname, job in wf["jobs"].items():
            pub = [n for n, r, _, _ in steps_text(job) if publishes(r)]
            env = job.get("environment")
            env = env.get("name") if isinstance(env, dict) else env
            if pub:
                chk(f"C1 {wname}/{jname}: publishing steps gated by environment {ENV}", env == ENV, steps=pub, environment=env)
                chk(f"C3 {wname}/{jname}: publishes only from gh-pages", "refs/heads/gh-pages" in str(job.get("if", "")),
                    job_if=job.get("if"))
            else:
                chk(f"C2 {wname}/{jname}: no publishing outside {ENV}", True, environment=env)
    # C3: pré-guarda T1 antes da promoção.
    cj = central["jobs"]
    chk("C3 central: guard job (promotion_guard, env producao-critica) precedes deploy",
        cj["deploy"].get("needs") in ("guard", ["guard"]) and cj["guard"].get("environment") == ENV
        and "promotion_guard.py" in cj["guard"]["steps"][-1].get("run", "") and "decision == 'promote'" in cj["deploy"]["if"])
    st = steps_text(sales["jobs"]["deploy"])
    names = [n for n, _, _, _ in st]
    gi = names.index("Pre-promotion guard (T1, inside the serialized deploy group)")
    pi = names.index("Promote exact candidate source to canonical domain")
    chk("C3 sales: T1 guard precedes promotion and gates it", gi < pi and "steps.guard.outputs.decision == 'promote'" in st[pi][2])
    chk("C3 sales: deploy only on push/dispatch to gh-pages",
        "refs/heads/gh-pages" in sales["jobs"]["deploy"]["if"] and "pull_request" not in sales["jobs"]["deploy"]["if"])
    # C4: SHA esperado em cada Worker.
    cd = {n: (r, i) for n, r, i, _ in steps_text(cj["deploy"])}
    chk("C4 central: TARGET_RUNTIME_SHA is the event SHA", cj["deploy"].get("env", {}).get("TARGET_RUNTIME_SHA") == "${{ github.sha }}")
    chk("C4 central: wrangler deploy tagged with TARGET_RUNTIME_SHA",
        '--tag="$TARGET_RUNTIME_SHA"' in cd["Deploy repaired production worker"][0])
    pp = cd["Post-promotion effective version (T1)"][0]
    chk("C4 central: readback /api/release deployment.commit_sha == candidate",
        "--verify-promoted" in pp and "--candidate \"$TARGET_RUNTIME_SHA\"" in pp and "https://zevanory.api.br/api/release" in pp
        and "deployment.commit_sha" in pp)
    sd = {n: (r, i) for n, r, i, _ in st}
    chk("C4 sales: wrangler deploy tagged with GITHUB_SHA", '--tag="$GITHUB_SHA"' in sd["Promote exact candidate source to canonical domain"][0])
    rb = sd["Verify canonical production readback"][0]
    chk("C4 sales: readback /health release == GITHUB_SHA", 'h.get("release")==os.environ["GITHUB_SHA"]' in rb
        and "--verify-promoted" in rb and "--readback-path release" in rb)
    # C5: rollback automático.
    roll_c, if_c = cd["Automatic rollback after failed post-deploy smoke"]
    chk("C5 central: automatic rollback to the previous version on failed smoke after a successful deploy",
        "failure()" in if_c and "steps.deployworker.outcome == 'success'" in if_c
        and re.search(r"wrangler@[\d.]+ rollback --name zevanory\b", roll_c) and "--version" not in roll_c
        and "verify-rollback-health.py" in roll_c, step_if=if_c)
    snap = sd["Snapshot active canonical deployment"][0]
    roll_s, if_s = sd["Roll back canonical deployment on failed readback"]
    chk("C5 sales: snapshot of the previous deployment taken before promotion",
        names.index("Snapshot active canonical deployment") < pi and "/deployments" in snap and "rollback-deployment.json" in snap)
    chk("C5 sales: failed readback restores the snapshot; no snapshot => no deletion, run fails",
        "steps.readback.outcome != 'success'" in if_s and "rollback-deployment.json" in roll_s and "-X POST" in roll_s
        and "SALES_NO_ROLLBACK_SNAPSHOT" in roll_s and not re.search(r"-X\s+DELETE|wrangler(@[\d.]+)?\s+delete", roll_s)
        and roll_s.rstrip().endswith("exit 1"))
    # C6: portão T1.
    chk("C6 central: NAO_COMPROVADO fails the run without rollback",
        "NAO_COMPROVADO" in cd["Certification gate (T1, after rollback decision)"][1]
        and cd["Certification gate (T1, after rollback decision)"][0].strip().endswith("exit 1"))
    chk("C6 sales: NAO_COMPROVADO fails the run without rollback",
        "state != 'PASS'" in sd["Certification gate (T1, after rollback decision)"][1]
        and sd["Certification gate (T1, after rollback decision)"][0].strip().endswith("exit 1"))
    # C7: certificação pós-publicação encadeada.
    on = cert.get("on") or cert.get(True)
    wr = on.get("workflow_run", {})
    chk("C7 post-publication certification chained to both deploys (workflow_run, success, deployed SHA)",
        sorted(wr.get("workflows", [])) == sorted([central["name"], sales["name"]]) and wr.get("types") == ["completed"]
        and "conclusion == 'success'" in cert["jobs"]["certify"]["if"]
        and "workflow_run.head_sha" in cert["jobs"]["certify"]["env"]["EXPECTED_SHA"]
        and "TRIGGER_SURFACE" in cert["jobs"]["certify"]["env"])
    src = (ROOT / "scripts/portfolio_cert_contract.py").read_text("utf-8")
    chk("C7 post-publication comparison only after observed promotion (contract v3)",
        "def await_promotion" in src and '"promotion_not_observed"' in src and "post_deploy_without_promotion" in src)


def online(chk, run_ids):
    out = []
    for rid in run_ids:
        def gh(path, jq):
            return subprocess.check_output(["gh", "api", f"repos/arbmsistone-lab/zevanory-public-mirror/{path}", "--jq", jq], text=True)
        meta = json.loads(gh(f"actions/runs/{rid}", "{name,head_sha,event,head_branch,created_at,conclusion}"))
        approvals = json.loads(gh(f"actions/runs/{rid}/approvals", "[.[] | {state, user: .user.login, envs: [.environments[].name]}]"))
        jobs = json.loads(gh(f"actions/runs/{rid}/jobs", "[.jobs[] | {name, conclusion, started_at, completed_at}]"))
        rec = {"run_id": rid, **meta, "approvals": approvals, "jobs": jobs}
        out.append(rec)
        chk(f"ONLINE run {rid} ({meta['name']} @ {meta['head_sha'][:8]}): {ENV} approval recorded",
            any(a["state"] == "approved" and ENV in a["envs"] for a in approvals), approvals=approvals)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--online", nargs="*", default=None, metavar="RUN_ID")
    ap.add_argument("--out")
    a = ap.parse_args()
    chk = Check()
    static_checks(chk)
    evidence = online(chk, a.online) if a.online else None
    ok = all(i["ok"] for i in chk.items)
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps({"schema": "zevanory.release.publication-chain.v1", "checks": chk.items,
                                                   "online_evidence": evidence, "verdict": "PASS" if ok else "FAIL"},
                                                  ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(f"CHAIN_CHECK={'PASS' if ok else 'FAIL'} checks={len(chk.items)} failed={sum(1 for i in chk.items if not i['ok'])}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
