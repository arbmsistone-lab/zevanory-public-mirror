#!/usr/bin/env python3
"""P25 Aprendizado: revisão semanal, só leitura, dos registros de funil e de experimentos (Roteiro Mestre v4.7, seções 5 e 12).

Lê apenas arquivos do repositório (nenhum segredo, nenhuma escrita em produção):
  data/experiments.json       registro de experimentos (P16)
  data/p01/hypotheses.json    hipóteses (P01)
  data/p02/decisions.json     decisões de oferta (P02)
  funil                       NOT_AVAILABLE por desenho: o agregado do funil fica no KV e exige credencial;
                              este fluxo não usa segredo. Um arquivo agregado pode ser passado em --funnel.

Escreve um registro de decisão da semana (JSON). Sem dado, escreve "SEM_DADOS" e diz por quê; nunca estima
número, nunca declara vencedor sem a amostra pré-registrada. O registro vai para a branch evidence/p25-learning
(nunca gh-pages); quem grava é o workflow .github/workflows/p25-weekly-learning.yml.

Regra PI do P25: 100% dos resultados viram mudança ou decisão registrada em até 7 dias. A revisão marca como
VENCIDO o experimento cuja janela fechou há mais de 7 dias sem decisão registrada no P02 nem revisão P25 anterior.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

SCHEMA = "zevanory-p25-weekly-review/v1"


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _d(s):
    try:
        return dt.date.fromisoformat(s) if s else None
    except (TypeError, ValueError):
        return None


def hypothesis_for(exp_id: str, p01: dict) -> list[str]:
    needle = f'"id": "{exp_id}"'
    return [h["id"] for h in p01.get("hypotheses", []) if any(s.get("ref") == "data/experiments.json" and s.get("contains") == needle for s in h.get("sources", []))]


def review_experiment(exp: dict, today: dt.date, p01: dict, p02: dict, funnel: dict | None, prior_reviews: set[str]) -> dict:
    hyps = hypothesis_for(exp["id"], p01)
    p02_links = [d["id"] for d in p02.get("decisions", []) if set(d.get("p01_hypotheses", [])) & set(hyps)]
    row = {"id": exp["id"], "title": exp.get("title"), "kind": exp.get("kind"), "p01_hypotheses": hyps, "p02_decisions": p02_links,
           "pre_registered": {}, "window": {}, "data": "NOT_AVAILABLE", "decision": None, "reason": None, "pi_7_days": None}
    kind = exp.get("kind")
    closed_at = None
    design_ok = True
    if kind == "before_after":
        change, days = _d(exp.get("changeAt")), int(exp.get("windowDays") or 0)
        row["pre_registered"] = {"min_views_per_side": exp.get("minViewsPerSide"), "min_events_total": exp.get("minEventsTotal"), "window_days": days}
        if change and days:
            closed_at = change + dt.timedelta(days=days)
            clean = _d(exp.get("cleanSince"))
            design_ok = not (clean and change - dt.timedelta(days=days) < clean)
            row["window"] = {"change_at": str(change), "closes_at": str(closed_at), "closed": today >= closed_at, "comparable_design": design_ok}
    elif kind == "arms":
        row["pre_registered"] = {"arms": exp.get("arms"), "min_per_arm": exp.get("minPerArm")}
        row["window"] = {"started_at": exp.get("startedAt"), "closes_at": None, "closed": None, "note": "fecha por amostra (mínimo por braço), não por data"}
    elif kind == "tracking":
        row["pre_registered"] = {"campaign_prefix": exp.get("campaignPrefix"), "rule": exp.get("decision")}
        row["window"] = {"started_at": exp.get("startedAt"), "closes_at": None, "closed": None, "note": "fecha por número de leads (regra do registro)"}
    exp_data = (funnel or {}).get("experiments", {}).get(exp["id"]) if funnel else None
    if exp_data is not None:
        row["data"] = "READ_UNEVALUATED"
    if kind == "before_after" and not design_ok:
        row["decision"] = "INCONCLUSIVO"
        row["reason"] = ("Desenho pré-registrado não comparável: a janela anterior à mudança começa antes do filtro de robôs "
                         f"(cleanSince {exp.get('cleanSince')}); nenhum vencedor pode ser declarado, com ou sem dados.")
    elif exp_data is None:
        row["decision"] = "SEM_DADOS"
        row["reason"] = "Dados do funil e do canal não lidos por esta revisão (fonte exige credencial). Nada é concluído; nenhum número estimado."
    else:
        row["decision"] = "SEM_DADOS"
        row["reason"] = "Agregado recebido, mas a avaliação estatística pré-registrada não roda nesta revisão; nada é concluído."
    if closed_at:
        due = closed_at + dt.timedelta(days=7)
        recorded = bool(p02_links) or exp["id"] in prior_reviews or row["decision"] == "INCONCLUSIVO"
        if today < closed_at:
            row["pi_7_days"] = "JANELA_ABERTA"
        elif recorded:
            row["pi_7_days"] = "DECISAO_REGISTRADA"
        elif today <= due:
            row["pi_7_days"] = f"PENDENTE_ATE_{due}"
        else:
            row["pi_7_days"] = "VENCIDO"
    else:
        row["pi_7_days"] = "NAO_SE_APLICA_SEM_DATA_DE_FECHAMENTO"
    return row


def build(root: Path, today: dt.date, run: dict, funnel_path: str | None = None, prior: str | None = None) -> dict:
    sources = []
    exps = _load(root / "data/experiments.json")
    sources.append({"name": "experimentos (P16)", "ref": "data/experiments.json", "status": "READ", "items": len(exps.get("experiments", []))})
    p01 = _load(root / "data/p01/hypotheses.json")
    sources.append({"name": "hipóteses (P01)", "ref": "data/p01/hypotheses.json", "status": "READ", "items": len(p01.get("hypotheses", []))})
    p02 = _load(root / "data/p02/decisions.json")
    sources.append({"name": "decisões de oferta (P02)", "ref": "data/p02/decisions.json", "status": "READ", "items": len(p02.get("decisions", []))})
    funnel = None
    if funnel_path and Path(funnel_path).is_file():
        funnel = _load(Path(funnel_path))
        sources.append({"name": "funil (P15)", "ref": funnel_path, "status": "READ"})
    else:
        sources.append({"name": "funil (P15)", "ref": "KV zpc-funnel:v1:summary", "status": "NOT_AVAILABLE",
                        "reason": "exige credencial do Cloudflare; esta revisão roda sem segredo por desenho"})
    prior_reviews: set[str] = set()
    if prior and Path(prior).is_dir():
        for f in sorted(Path(prior).glob("*.json")):
            try:
                for e in _load(f).get("experiments", []):
                    if e.get("decision") in ("INCONCLUSIVO", "MUDANCA_REGISTRADA"):
                        prior_reviews.add(e["id"])
            except (OSError, json.JSONDecodeError, AttributeError):
                continue
    rows = [review_experiment(e, today, p01, p02, funnel, prior_reviews) for e in exps.get("experiments", [])]
    overdue = [r["id"] for r in rows if r["pi_7_days"] == "VENCIDO"]
    any_data = any(s["status"] == "READ" for s in sources if s["name"].startswith("funil"))
    iso = today.isocalendar()
    return {
        "schema": SCHEMA,
        "process": "P25",
        "week": f"{iso[0]}-W{iso[1]:02d}",
        "reviewed_on": str(today),
        "run": run,
        "evidence_label": "SINTÉTICA (revisão automática de registros; nenhuma ocorrência real avaliada)",
        "sources": sources,
        "experiments": rows,
        "offer_decisions_reviewed": [{"id": d["id"], "outcome": d["outcome"], "decided_at": d["decided_at"]} for d in p02.get("decisions", [])],
        "decision": "SEM_DADOS" if not any_data else "REVISADO_SEM_CONCLUSAO",
        "decision_text": ("Sem dados de funil ou de canal nesta revisão: nenhuma mudança e nenhuma conclusão. "
                          "Os experimentos ficam como estão; o único veredito possível é o que o próprio desenho pré-registrado já determina.")
                         if not any_data else "Dados recebidos; a avaliação pré-registrada não roda aqui; nenhuma conclusão.",
        "hypotheses_updated": [],
        "pi_7_days": {"overdue": overdue, "status": "VENCIDO" if overdue else "OK"},
        "not_claimed": ["taxa de conversão", "vencedor de experimento", "receita", "qualquer número do funil"],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".")
    ap.add_argument("--today", help="AAAA-MM-DD (padrão: hoje em UTC)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--funnel", help="agregado do funil em JSON (opcional; ausente = NOT_AVAILABLE)")
    ap.add_argument("--prior-dir", help="pasta com revisões anteriores (branch de evidência)")
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--sha", default=None)
    args = ap.parse_args(argv)
    today = dt.date.fromisoformat(args.today) if args.today else dt.datetime.now(dt.timezone.utc).date()
    rep = build(Path(args.root), today, {"run_id": args.run_id, "commit_sha": args.sha}, args.funnel, args.prior_dir)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for r in rep["experiments"]:
        print(f"P25 {r['id']}: decisão={r['decision']} dados={r['data']} pi7={r['pi_7_days']}")
    print(f"P25_WEEK={rep['week']} P25_DECISION={rep['decision']} P25_PI7={rep['pi_7_days']['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
