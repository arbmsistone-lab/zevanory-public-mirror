#!/usr/bin/env python3
"""ZEVANORY | Revisão jurídica dos textos de consumo (M1, reauditoria do PR #946).

Uma única regra, usada em dois lugares:
  * scripts/p23/ecommerce_legal_gate.py (check de PR p23 / ecommerce-legal);
  * os workflows que PUBLICAM /termos e /reembolso (zevanory-sales-public-release.yml, job deploy, e
    central-production-deploy.yml, job deploy), com --publish-gate, antes de qualquer chamada à Cloudflare.

Impressão digital (legal_fingerprint): SHA-256 do texto visível de <main> das páginas jurídicas publicadas
(sales-public/termos.html, sales-public/reembolso.html, termos/index.html, reembolso/index.html) e dos textos de consumo
de data/politica-unica.json que o Worker e o chat repetem (sol_text, rule_7d, customer_wording, refund_channels). Só o
texto conta: trocar o nome de um asset ou o HTML em volta não muda a impressão digital; mudar uma palavra muda.

Aprovação válida (validate_approval), em data/politica-unica.json -> legal_review. Uma string livre não basta:
  * identidade AUTORIZADA: reviewer_id cadastrado em data/p23/legal-reviewers.json (nome, registro profissional,
    login do GitHub, autorizado pelo proprietário com data e commit da autorização); approved_by igual ao nome
    cadastrado, com nome e sobrenome (opcional ", OAB/UF 12345") e sem marcador de teste ou papel genérico;
  * conteúdo: reviewed_sha256 igual à impressão digital ATUAL (o texto revisado é o que vai ao ar);
  * versão: document_version igual a legal_document_version de data/politica-unica.json (a versão entra na impressão);
  * origem: reviewed_commit com o SHA (40 hex) do commit que contém o texto revisado; approved_at em data ISO, não futura;
  * registro auditável: record aponta para docs/legal/reviews/<reviewed_sha256>.json, versionado, com os mesmos
    reviewer_id, reviewed_sha256, reviewed_commit, document_version, approved_at e decision "APPROVED".
  Hoje o cadastro de revisores está VAZIO: nenhuma aprovação passa até o proprietário cadastrar quem revisa.

Portão de publicação (--publish-gate), fail-closed:
  * impressão digital igual à de data/p23/legal-published-baseline.json (texto que já está publicado): PASSA, mesmo
    com a revisão PENDENTE. Um deploy que não muda texto jurídico não fica preso e nada que já está no ar é retirado;
  * texto diferente do publicado: exige aprovação válida para ESTA impressão digital; sem ela, sai com código 1 e o
    deploy para antes de tocar a produção (o que está no ar continua como está).
Sem rede, sem segredos; só lê arquivos.
Uso: legal_review.py --root . --fingerprint | --publish-gate | --check-approval
"""
from __future__ import annotations

import argparse, datetime as dt, hashlib, html, json, re, sys
from pathlib import Path

LEGAL_PAGES = ("sales-public/termos.html", "sales-public/reembolso.html", "termos/index.html", "reembolso/index.html")
POLICY_FIELDS = ("legal_document_version", "sol_text", "rule_7d", "customer_wording", "refund_channels")
BASELINE = "data/p23/legal-published-baseline.json"
REVIEWERS = "data/p23/legal-reviewers.json"
RECORDS = "docs/legal/reviews"

# Marcadores de teste, de exemplo ou de papel genérico: nunca identificam quem revisou.
FIXTURE = re.compile(r"(?i)\b(fixture|teste?s?|test|exemplo|example|dummy|fake|mock|placeholder|todo|tbd|xxx+|n/?a|"
                     r"pendente|pending|jurista|advogad[oa]|revisor[a]?|propriet[aá]rio|owner|admin|bot|ci|codex|claude|sol)\b")
NAME = re.compile(r"^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*(?: (?:d[aeo]s?|e|[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*))+"
                  r"(?:,? \(?OAB/[A-Z]{2} ?\d{3,7}\)?)?$")


def _main_text(raw: str) -> str:
    m = re.search(r"<main\b[^>]*>(.*?)</main>", raw, re.S | re.I)
    body = m.group(1) if m else raw
    body = re.sub(r"<(script|style)\b.*?</\1>", " ", body, flags=re.S | re.I)
    body = re.sub(r"<[^>]+>", " ", body)
    return re.sub(r"\s+", " ", html.unescape(body)).strip()


def legal_fingerprint(root: Path) -> str:
    h = hashlib.sha256()
    for rel in LEGAL_PAGES:
        path = root / rel
        if not path.is_file():
            raise SystemExit(f"LEGAL_FINGERPRINT_SOURCE_MISSING {rel}")
        h.update(rel.encode() + b"\0" + _main_text(path.read_text(encoding="utf-8")).encode() + b"\0")
    pol = json.loads((root / "data/politica-unica.json").read_text(encoding="utf-8"))
    for k in POLICY_FIELDS:
        if k not in pol and k not in ("refund_channels", "legal_document_version"):
            raise SystemExit(f"LEGAL_FINGERPRINT_FIELD_MISSING {k}")
        h.update(k.encode() + b"\0" + json.dumps(pol.get(k), ensure_ascii=False, sort_keys=True).encode() + b"\0")
    return h.hexdigest()


def _day(value) -> dt.date | None:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?", value):
        return None
    try:
        return dt.date.fromisoformat(value[:10])
    except ValueError:
        return None


def _json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def validate_approval(review, fingerprint: str, today: dt.date | None = None, root: Path | None = None) -> list[str]:
    today = today or dt.datetime.now(dt.timezone.utc).date()
    review = review if isinstance(review, dict) else {}
    root = Path(root) if root else Path(__file__).resolve().parents[2]
    errs: list[str] = []
    if review.get("status") != "APPROVED":
        errs.append("REVISÃO JURÍDICA PENDENTE; legal_review exige status APPROVED, approved_by, approved_at, reviewed_sha256 e reviewed_commit")
        return errs
    who = review.get("approved_by")
    who = who.strip() if isinstance(who, str) else ""
    if not who or not NAME.fullmatch(who) or FIXTURE.search(who):
        errs.append(f"legal_review.approved_by {review.get('approved_by')!r} não identifica uma pessoa (nome e sobrenome, opcional ', OAB/UF número'; sem marcador de teste ou papel genérico)")
    day = _day(review.get("approved_at"))
    if day is None:
        errs.append(f"legal_review.approved_at {review.get('approved_at')!r} não é uma data ISO (AAAA-MM-DD)")
    elif day > today + dt.timedelta(days=1):
        errs.append(f"legal_review.approved_at {review.get('approved_at')!r} está no futuro")
    sha = review.get("reviewed_sha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
        errs.append("legal_review.reviewed_sha256 ausente ou inválido (SHA-256 do texto revisado: legal_review.py --fingerprint)")
    elif sha != fingerprint:
        errs.append(f"legal_review.reviewed_sha256 {sha[:12]}… não corresponde ao texto atual {fingerprint[:12]}…: o texto mudou depois da revisão")
    commit = review.get("reviewed_commit")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        errs.append("legal_review.reviewed_commit ausente ou inválido (SHA de 40 caracteres do commit com o texto revisado)")
    # Versão do documento revisado.
    pol = _json(root / "data/politica-unica.json") or {}
    version = pol.get("legal_document_version")
    if not isinstance(version, str) or not version.strip() or review.get("document_version") != version:
        errs.append(f"legal_review.document_version {review.get('document_version')!r} difere da versão publicada {version!r}")
    # Identidade autorizada (cadastro mantido pelo proprietário).
    reg = _json(root / REVIEWERS)
    reviewers = reg.get("reviewers") if isinstance(reg, dict) else None
    entry = next((r for r in (reviewers or []) if isinstance(r, dict) and r.get("id") == review.get("reviewer_id")), None)
    if entry is None:
        errs.append(f"legal_review.reviewer_id {review.get('reviewer_id')!r} não está no cadastro de revisores autorizados ({REVIEWERS})")
    else:
        auth_day = _day(entry.get("authorized_at"))
        if (entry.get("name") != who or entry.get("authorized_by") != "proprietario" or auth_day is None
                or not re.fullmatch(r"[0-9a-f]{40}", str(entry.get("authorization_commit", "")))
                or not re.fullmatch(r"OAB/[A-Z]{2} ?\d{3,7}", str(entry.get("registro", "")))
                or not re.fullmatch(r"[A-Za-z0-9-]{1,39}", str(entry.get("github_login", "")))):
            errs.append(f"legal_review.reviewer_id {review.get('reviewer_id')!r}: cadastro incompleto ou nome diferente de approved_by (exige name, registro OAB, github_login, authorized_by=proprietario, authorized_at e authorization_commit)")
        elif day is not None and auth_day > day:
            errs.append("legal_review: aprovação anterior à autorização do revisor")
    # Registro auditável versionado.
    rec_path = review.get("record")
    want = f"{RECORDS}/{sha}.json" if isinstance(sha, str) else None
    rec = _json(root / rec_path) if isinstance(rec_path, str) and rec_path == want else None
    if not isinstance(rec, dict):
        errs.append(f"legal_review.record ausente: exige o registro {want or RECORDS + '/<reviewed_sha256>.json'} versionado no repositório")
    else:
        for k in ("reviewer_id", "reviewed_sha256", "reviewed_commit", "document_version", "approved_at"):
            if rec.get(k) != review.get(k):
                errs.append(f"registro {rec_path}: {k} {rec.get(k)!r} difere de legal_review ({review.get(k)!r})")
        if rec.get("decision") != "APPROVED":
            errs.append(f"registro {rec_path}: decision deve ser APPROVED")
    return errs


def publish_gate(root: Path) -> tuple[bool, list[str]]:
    fp = legal_fingerprint(root)
    base = json.loads((root / BASELINE).read_text(encoding="utf-8"))
    lines = [f"LEGAL_FINGERPRINT={fp}", f"LEGAL_PUBLISHED_BASELINE={base.get('fingerprint')} source_commit={base.get('source_commit')}"]
    if not re.fullmatch(r"[0-9a-f]{64}", str(base.get("fingerprint", ""))):
        return False, lines + ["::error title=LEGAL_PUBLISH_GATE::baseline publicado inválido; fail-closed"]
    if fp == base["fingerprint"]:
        return True, lines + ["LEGAL_PUBLISH_GATE=PASS_UNCHANGED (texto jurídico idêntico ao já publicado; revisão não exigida para este deploy)"]
    pol = json.loads((root / "data/politica-unica.json").read_text(encoding="utf-8"))
    errs = validate_approval(pol.get("legal_review"), fp, root=root)
    if errs:
        return False, lines + [f"::error title=LEGAL_PUBLISH_GATE::{e}" for e in errs] + [
            "LEGAL_PUBLISH_GATE=BLOCKED (texto jurídico novo sem aprovação válida; nada foi publicado e a produção segue com o texto anterior)"]
    return True, lines + ["LEGAL_PUBLISH_GATE=PASS_APPROVED"]


def main(argv=None) -> int:
    # -I ignora PYTHONIOENCODING: no Windows o console é cp1252 e a mensagem com acento sairia ilegível.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--fingerprint", action="store_true")
    g.add_argument("--publish-gate", action="store_true")
    g.add_argument("--check-approval", action="store_true")
    a = ap.parse_args(argv)
    root = Path(a.root).resolve()
    if a.fingerprint:
        print(legal_fingerprint(root))
        return 0
    if a.check_approval:
        pol = json.loads((root / "data/politica-unica.json").read_text(encoding="utf-8"))
        errs = validate_approval(pol.get("legal_review"), legal_fingerprint(root), root=root)
        for e in errs:
            print("::error title=LEGAL_REVIEW::" + e)
        print("LEGAL_REVIEW=" + ("FAIL" if errs else "PASS"))
        return 1 if errs else 0
    ok, lines = publish_gate(root)
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
