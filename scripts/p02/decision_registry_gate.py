#!/usr/bin/env python3
"""P02 Oferta: gate do registro auditável de decisões (Roteiro Mestre v4.7, seções 5, 12 e 3).

Regra do processo (seção 5): decisão só com amostra pré-registrada; sem amostra, "INCONCLUSIVO".
Métrica do P01: 100% das decisões de oferta ligadas a evidência do P01.

Entradas versionadas, sem rede e sem segredo:
  data/p02/decisions.json     registro de decisões (schema zevanory-p02-decisions/v1, schema_version 1)
  data/p01/hypotheses.json    registro de hipóteses do P01 (schema zevanory-p01-hypotheses/v1)
  data/products.json          produtos vendidos (escopo válido)

Reprova quando uma decisão:
  - não liga a nenhuma hipótese do P01, ou liga a hipótese inexistente ou sem fonte verificável;
  - não tem evidência verificável no repositório (arquivo existe e contém o trecho citado);
  - decide algo diferente de INCONCLUSIVO sem amostra pré-registrada antes da decisão, sem n observado
    que alcance o mínimo pré-registrado, ou com dado NOT_AVAILABLE;
  - é de classe D (preço, produto novo) com decisão diferente de INCONCLUSIVO sem aprovação do proprietário;
  - teve o conteúdo alterado (record_sha256) ou foi removida/alterada em relação à base (registro só cresce).
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path

SCHEMA = "zevanory-p02-decisions/v1"
SCHEMA_VERSION = 1
SCHEMA_P01 = "zevanory-p01-hypotheses/v1"
OUTCOMES = {"MANTER", "REFORCAR", "REFORMULAR", "APOSENTAR", "INCONCLUSIVO"}
CLASSES = {"A", "B", "C", "D"}
REQUIRED = ("id", "decided_at", "subject", "scope", "decision_class", "p01_hypotheses", "pre_registration",
            "observed", "outcome", "outcome_reason", "action", "evidence", "recorded_by", "record_sha256")
ID_RE = re.compile(r"^D-(\d{4})-(\d{4})$")
HYP_RE = re.compile(r"^H-\d{4}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def record_hash(rec: dict) -> str:
    body = {k: v for k, v in rec.items() if k != "record_sha256"}
    canon = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _date(s, field: str, errs: list[str], where: str):
    if not isinstance(s, str) or not DATE_RE.match(s):
        errs.append(f"{where}: {field} deve ser AAAA-MM-DD")
        return None
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        errs.append(f"{where}: {field} inválida")
        return None


def check_ref(root: Path, ev, where: str, errs: list[str]) -> bool:
    """Evidência verificável: {'kind': 'repo', 'ref': caminho, 'contains': trecho} ou {'kind': 'url', 'ref': https://...}."""
    if not isinstance(ev, dict):
        errs.append(f"{where}: evidência deve ser objeto")
        return False
    kind, ref = ev.get("kind"), ev.get("ref")
    if kind == "repo":
        if not isinstance(ref, str) or not ref or ref.startswith(("/", "..")) or ".." in Path(ref).parts:
            errs.append(f"{where}: caminho de repositório inválido: {ref!r}")
            return False
        p = root / ref
        if not p.is_file():
            errs.append(f"{where}: arquivo de evidência não existe: {ref}")
            return False
        needle = ev.get("contains")
        if not isinstance(needle, str) or len(needle) < 8:
            errs.append(f"{where}: evidência {ref} precisa de 'contains' (trecho literal com 8+ caracteres) para ser verificável")
            return False
        if needle not in p.read_text(encoding="utf-8", errors="replace"):
            errs.append(f"{where}: trecho citado não aparece em {ref}: {needle!r}")
            return False
        return True
    if kind == "url":
        if not isinstance(ref, str) or not re.match(r"^https://[^/\s]+\.[^/\s]+/", ref):
            errs.append(f"{where}: URL de evidência deve ser https absoluta: {ref!r}")
            return False
        return True
    errs.append(f"{where}: tipo de evidência desconhecido: {kind!r}")
    return False


def load_p01(root: Path, errs: list[str]) -> dict:
    path = root / "data/p01/hypotheses.json"
    try:
        reg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errs.append(f"P01: registro de hipóteses ilegível: {exc}")
        return {}
    if reg.get("schema") != SCHEMA_P01:
        errs.append(f"P01: schema deve ser {SCHEMA_P01}")
    hyps = {}
    for h in reg.get("hypotheses", []):
        hid = h.get("id")
        where = f"P01 {hid}"
        if not isinstance(hid, str) or not HYP_RE.match(hid):
            errs.append(f"P01: id de hipótese inválido {hid!r}")
            continue
        if hid in hyps:
            errs.append(f"P01: hipótese repetida {hid}")
        if not isinstance(h.get("statement"), str) or len(h["statement"]) < 20:
            errs.append(f"{where}: enunciado ausente ou curto")
        srcs = h.get("sources") or []
        ok = [check_ref(root, s, f"{where} fonte", errs) for s in srcs]
        if not srcs or not any(ok):
            errs.append(f"{where}: hipótese sem fonte verificável")
        hyps[hid] = h
    return hyps


def validate(root: Path, registry: dict, base: dict | None = None, today: dt.date | None = None) -> list[str]:
    errs: list[str] = []
    today = today or dt.datetime.now(dt.timezone.utc).date()
    if registry.get("schema") != SCHEMA:
        errs.append(f"schema deve ser {SCHEMA}")
    if registry.get("schema_version") != SCHEMA_VERSION:
        errs.append(f"schema_version deve ser {SCHEMA_VERSION}")
    hyps = load_p01(root, errs)
    try:
        slugs = {p["slug"] for p in json.loads((root / "data/products.json").read_text(encoding="utf-8"))["products"]}
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        errs.append(f"data/products.json ilegível: {exc}")
        slugs = set()
    decisions = registry.get("decisions")
    if not isinstance(decisions, list):
        return errs + ["decisions deve ser lista"]
    seen: dict[str, dict] = {}
    last_num = None
    for i, rec in enumerate(decisions):
        where = f"decisão[{i}] {rec.get('id') if isinstance(rec, dict) else '?'}"
        if not isinstance(rec, dict):
            errs.append(f"{where}: deve ser objeto")
            continue
        for k in REQUIRED:
            if k not in rec:
                errs.append(f"{where}: campo obrigatório ausente: {k}")
        rid = rec.get("id")
        m = ID_RE.match(rid) if isinstance(rid, str) else None
        if not m:
            errs.append(f"{where}: id deve seguir D-AAAA-NNNN")
        else:
            num = int(m.group(1)) * 10000 + int(m.group(2))
            if last_num is not None and num <= last_num:
                errs.append(f"{where}: ids devem crescer na ordem do registro")
            last_num = num
        if rid in seen:
            errs.append(f"{where}: id repetido")
        seen[rid] = rec
        if rec.get("record_sha256") != record_hash(rec):
            errs.append(f"{where}: record_sha256 não confere com o conteúdo (registro alterado ou hash não recalculado)")
        decided = _date(rec.get("decided_at"), "decided_at", errs, where)
        if decided and decided > today:
            errs.append(f"{where}: decided_at no futuro")
        for k in ("subject", "outcome_reason", "action", "recorded_by"):
            if not isinstance(rec.get(k), str) or not rec.get(k, "").strip():
                errs.append(f"{where}: {k} vazio")
        scope = rec.get("scope")
        if not isinstance(scope, list) or not scope or any(s not in slugs for s in scope):
            errs.append(f"{where}: scope deve listar produtos de data/products.json")
        klass = rec.get("decision_class")
        if klass not in CLASSES:
            errs.append(f"{where}: decision_class deve ser A, B, C ou D (seção 3)")
        # Ligação ao P01.
        links = rec.get("p01_hypotheses")
        if not isinstance(links, list) or not links:
            errs.append(f"{where}: decisão sem ligação a hipótese do P01")
        else:
            for h in links:
                if h not in hyps:
                    errs.append(f"{where}: hipótese do P01 inexistente: {h}")
        # Evidência verificável.
        evs = rec.get("evidence")
        if not isinstance(evs, list) or not evs:
            errs.append(f"{where}: decisão sem evidência")
        else:
            okrepo = [check_ref(root, ev, f"{where} evidência", errs) and ev.get("kind") == "repo" for ev in evs]
            if not any(okrepo):
                errs.append(f"{where}: precisa de ao menos uma evidência verificável no repositório")
        # Amostra pré-registrada.
        outcome = rec.get("outcome")
        if outcome not in OUTCOMES:
            errs.append(f"{where}: outcome deve ser um de {sorted(OUTCOMES)}")
        pre = rec.get("pre_registration")
        obs = rec.get("observed")
        if not isinstance(obs, dict) or obs.get("status") not in ("MEASURED", "NOT_AVAILABLE"):
            errs.append(f"{where}: observed.status deve ser MEASURED ou NOT_AVAILABLE")
            obs = obs if isinstance(obs, dict) else {}
        if obs.get("status") == "NOT_AVAILABLE":
            if not isinstance(obs.get("reason"), str) or not obs["reason"].strip():
                errs.append(f"{where}: NOT_AVAILABLE exige motivo")
            for k in ("n", "value"):
                if k in obs:
                    errs.append(f"{where}: dado NOT_AVAILABLE não pode trazer '{k}' (número sem fonte)")
            if outcome != "INCONCLUSIVO":
                errs.append(f"{where}: sem dado observado a decisão só pode ser INCONCLUSIVO")
        if pre is not None:
            if not isinstance(pre, dict):
                errs.append(f"{where}: pre_registration deve ser objeto ou null")
                pre = None
            else:
                reg_at = _date(pre.get("registered_at"), "pre_registration.registered_at", errs, where)
                if reg_at and decided and reg_at >= decided:
                    errs.append(f"{where}: amostra registrada na data da decisão ou depois (não é pré-registro)")
                if not check_ref(root, pre.get("ref"), f"{where} pré-registro", errs):
                    errs.append(f"{where}: pré-registro sem referência verificável")
                mins = pre.get("min_n")
                if not isinstance(mins, dict) or not mins or any(not isinstance(v, int) or isinstance(v, bool) or v <= 0 for v in mins.values()):
                    errs.append(f"{where}: pre_registration.min_n deve mapear cada medida a um inteiro positivo")
                    mins = {}
                if not isinstance(pre.get("metric"), str) or not pre["metric"].strip():
                    errs.append(f"{where}: pre_registration.metric vazio")
        if outcome != "INCONCLUSIVO":
            if pre is None:
                errs.append(f"{where}: decisão {outcome} sem amostra pré-registrada; registre INCONCLUSIVO")
            if obs.get("status") != "MEASURED":
                errs.append(f"{where}: decisão {outcome} exige dado MEASURED")
            else:
                n = obs.get("n")
                if not isinstance(n, dict):
                    errs.append(f"{where}: observed.n deve mapear as mesmas medidas do pré-registro")
                elif isinstance(pre, dict) and isinstance(pre.get("min_n"), dict):
                    for k, v in pre["min_n"].items():
                        got = n.get(k)
                        if not isinstance(got, int) or isinstance(got, bool) or got < v:
                            errs.append(f"{where}: n observado de '{k}' ({got}) abaixo do mínimo pré-registrado ({v}); registre INCONCLUSIVO")
                if not check_ref(root, obs.get("source"), f"{where} fonte do dado", errs):
                    errs.append(f"{where}: dado MEASURED sem fonte verificável")
            if klass == "D":
                appr = rec.get("owner_approval")
                if not isinstance(appr, dict) or not check_ref(root, appr.get("ref"), f"{where} aprovação", errs) or not _date(appr.get("date"), "owner_approval.date", errs, where):
                    errs.append(f"{where}: classe D (preço, produto novo) exige aprovação do proprietário registrada")
        else:
            if not isinstance(rec.get("outcome_reason"), str) or len(rec["outcome_reason"].strip()) < 20:
                errs.append(f"{where}: INCONCLUSIVO exige motivo explícito")
        sup = rec.get("supersedes")
        if sup is not None and sup not in seen:
            errs.append(f"{where}: supersedes aponta para decisão anterior inexistente: {sup}")
    # Registro só cresce.
    if base is not None:
        cur = {r.get("id"): r.get("record_sha256") for r in decisions if isinstance(r, dict)}
        for r in base.get("decisions", []) or []:
            rid = r.get("id")
            if rid not in cur:
                errs.append(f"append-only: decisão {rid} da base foi removida (registre uma nova decisão com 'supersedes')")
            elif cur[rid] != r.get("record_sha256"):
                errs.append(f"append-only: decisão {rid} da base foi alterada (registre uma nova decisão com 'supersedes')")
    return errs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".")
    ap.add_argument("--registry", default="data/p02/decisions.json")
    ap.add_argument("--base", help="registro da branch base, para a regra append-only")
    ap.add_argument("--today", help="AAAA-MM-DD (testes)")
    ap.add_argument("--print-hash", action="store_true", help="imprime o record_sha256 esperado de cada decisão")
    args = ap.parse_args(argv)
    root = Path(args.root)
    try:
        reg = json.loads((root / args.registry).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"P02_GATE=FAIL registro ilegível: {exc}")
        return 1
    if args.print_hash:
        for r in reg.get("decisions", []):
            print(r.get("id"), record_hash(r))
        return 0
    base = None
    if args.base:
        bp = Path(args.base)
        if bp.is_file() and bp.stat().st_size > 0:
            base = json.loads(bp.read_text(encoding="utf-8"))
    today = dt.date.fromisoformat(args.today) if args.today else None
    errs = validate(root, reg, base, today)
    for e in errs:
        print(f"::error title=P02::{e}")
    ds = reg.get("decisions", []) if isinstance(reg.get("decisions"), list) else []
    inc = sum(1 for d in ds if isinstance(d, dict) and d.get("outcome") == "INCONCLUSIVO")
    print(f"P02_DECISIONS total={len(ds)} inconclusivo={inc} decided={len(ds) - inc} base={'yes' if base is not None else 'no'}")
    print(f"P02_GATE={'FAIL' if errs else 'PASS'} errors={len(errs)}")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
