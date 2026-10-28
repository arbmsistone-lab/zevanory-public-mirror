#!/usr/bin/env python3
"""ZEVANORY | Kit da aprovação INTERNA do proprietário (Sol ORDEM 312; reauditoria rodada 12, MED-3b).

Só ESCREVE arquivos na árvore de trabalho; quem decide, revisa, faz o commit e o merge é o proprietário. Não aprova
nada sozinho: as respostas do checklist P23 são do proprietário (arquivo preenchido por ele) e a auditoria
independente é um relatório que ele versiona. A aprovação interna é um controle temporário e NÃO constitui parecer
jurídico.

PR 1 (cadastro + relatório de auditoria):
  internal_approval.py register --name "Nome Sobrenome" --github-login <login> --audit-report <arquivo.md>
    -> acrescenta o revisor interno em data/p23/legal-reviewers.json (type internal_owner, sem OAB, sem
       authorization_commit) e copia o relatório para docs/legal/audits/<nome do arquivo>.
PR 2 (aprovação), depois do merge do PR 1:
  internal_approval.py approve --checklist <checklist preenchido.json> --audit-report docs/legal/audits/<arquivo.md>
                               --auditor "<quem auditou>" --auditor-kind independent_ai_auditor|human
                               [--approved-at AAAA-MM-DD] [--anchors-ref refs/remotes/origin/gh-pages]
    -> calcula a impressão digital do texto no gh-pages (reviewed_commit = ponta do gh-pages), acha o
       authorization_commit (o commit do gh-pages que cadastrou o revisor), grava legal_review (APPROVED_INTERNAL) em
       data/politica-unica.json e o registro docs/legal/reviews/<sha256>.json com o checklist e a auditoria, e confere
       tudo com a mesma validação do portão.
O modelo do checklist é docs/legal/internal-approval/checklist-p23.json (todas as respostas em branco).
"""
from __future__ import annotations

import argparse, datetime as dt, hashlib, json, shutil, subprocess, sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import legal_review as lr  # noqa: E402


def _dump(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def register(root: Path, a) -> int:
    reg_p = root / lr.REVIEWERS
    reg = json.loads(reg_p.read_text(encoding="utf-8"))
    rid = "int-" + lr._norm(a.name).replace(" ", "-")
    if any(r.get("id") == rid for r in reg.get("reviewers", [])):
        print(f"INTERNAL_APPROVAL=ERROR revisor {rid} já cadastrado")
        return 1
    reg.setdefault("reviewers", []).append({"id": rid, "name": a.name, "type": "internal_owner", "github_login": a.github_login,
                                            "authorized_by": "proprietario", "authorized_at": a.authorized_at or dt.date.today().isoformat()})
    _dump(reg_p, reg)
    src = Path(a.audit_report)
    dst = root / lr.AUDIT_DIR / src.name
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    print(f"INTERNAL_APPROVAL_PR1=READY reviewer_id={rid} audit={dst.relative_to(root).as_posix()} sha256={hashlib.sha256(dst.read_bytes()).hexdigest()}")
    print("Próximo passo: commit destes dois arquivos num PR (âncora: merge por decisão deliberada, squash). Depois do merge, rode 'approve'.")
    return 0


def approve(root: Path, a) -> int:
    anchors = lr.GitRef(root, a.anchors_ref)
    reviewed = anchors.commit()
    if not reviewed:
        print(f"INTERNAL_APPROVAL=ERROR ref {a.anchors_ref} não existe (git fetch origin gh-pages)")
        return 1
    reg = json.loads((root / lr.REVIEWERS).read_text(encoding="utf-8"))
    entry = next((r for r in reg.get("reviewers", []) if r.get("type") == "internal_owner" and not r.get("authorization_commit")), None)
    if entry is None:
        print("INTERNAL_APPROVAL=ERROR nenhum revisor interno sem authorization_commit (faça o PR 1 antes)")
        return 1
    rc, out = anchors.run("log", "--format=%H", "--reverse", reviewed, "--", lr.REVIEWERS)
    auth = None
    for c in out.split():
        at = lr._loads(anchors.read(lr.REVIEWERS, c)) or {}
        if any(r.get("id") == entry["id"] for r in at.get("reviewers", [])):
            auth = c
            break
    if not auth:
        print("INTERNAL_APPROVAL=ERROR o cadastro do revisor ainda não está no gh-pages (merge do PR 1 primeiro)")
        return 1
    fp = lr.legal_fingerprint_src(anchors.at(reviewed))
    ids = [i["id"] for i in json.loads((root / lr.CHECKLIST).read_text(encoding="utf-8"))["items"]]
    filled = json.loads(Path(a.checklist).read_text(encoding="utf-8")).get("answers", {})
    answers = {i: {"answer": (filled.get(i) or {}).get("answer", ""), "evidence": (filled.get(i) or {}).get("evidence", "")} for i in ids}
    missing = [i for i, v in answers.items() if v["answer"] not in ("conforme", "nao_aplicavel") or not str(v["evidence"]).strip()]
    if missing:
        print(f"INTERNAL_APPROVAL=ERROR checklist incompleto: {missing}")
        return 1
    audit_path = root / a.audit_report
    pol_p = root / lr.POLICY
    pol = json.loads(pol_p.read_text(encoding="utf-8"))
    day = a.approved_at or dt.date.today().isoformat()
    record = f"{lr.RECORDS}/{fp}.json"
    review = {"status": "APPROVED_INTERNAL", "type": "internal_owner", "reviewer_id": entry["id"], "approved_by": entry["name"], "approved_at": day,
              "reviewed_sha256": fp, "reviewed_commit": reviewed, "document_version": pol.get("legal_document_version"), "record": record,
              "disclaimer": lr.INTERNAL_DISCLAIMER}
    pol["legal_review"] = review
    entry["authorization_commit"] = auth
    _dump(root / lr.REVIEWERS, reg)
    _dump(pol_p, pol)
    _dump(root / record, {"reviewer_id": entry["id"], "reviewed_sha256": fp, "reviewed_commit": reviewed, "document_version": review["document_version"],
                          "approved_at": day, "decision": "APPROVED_INTERNAL", "type": "internal_owner", "disclaimer": lr.INTERNAL_DISCLAIMER,
                          "checklist": answers,
                          "audit_report": {"ref": a.audit_report, "sha256": hashlib.sha256(audit_path.read_bytes()).hexdigest() if audit_path.exists() else "",
                                           "auditor": a.auditor, "auditor_kind": a.auditor_kind}})
    errs = lr.validate_approval(review, fp, root=root, anchors=lr.Tree(root), content=anchors.at(reviewed))
    for e in errs:
        print("::error title=INTERNAL_APPROVAL::" + e)
    print(f"INTERNAL_APPROVAL_PR2={'READY' if not errs else 'INVALID'} reviewed_sha256={fp} reviewed_commit={reviewed} authorization_commit={auth}")
    if not errs:
        print("Próximo passo: commit de data/politica-unica.json, data/p23/legal-reviewers.json e do registro num PR (âncora, squash).")
    return 0 if not errs else 1


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("register")
    r.add_argument("--name", required=True)
    r.add_argument("--github-login", required=True)
    r.add_argument("--audit-report", required=True)
    r.add_argument("--authorized-at")
    p = sub.add_parser("approve")
    p.add_argument("--checklist", required=True)
    p.add_argument("--audit-report", required=True)
    p.add_argument("--auditor", required=True)
    p.add_argument("--auditor-kind", required=True, choices=lr.AUDITOR_KINDS)
    p.add_argument("--approved-at")
    p.add_argument("--anchors-ref", default="refs/remotes/origin/gh-pages")
    a = ap.parse_args(argv)
    root = Path(a.root).resolve()
    return register(root, a) if a.cmd == "register" else approve(root, a)


if __name__ == "__main__":
    sys.exit(main())
