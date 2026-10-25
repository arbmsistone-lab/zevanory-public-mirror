#!/usr/bin/env python3
"""P16 Experimentos: gate do registro prévio de experimentos (Roteiro Mestre v4.7, seções 5, 6.5, 12 e 14).

Regra do processo (seção 5): registro prévio [3.1]; A/B só com cálculo amostral; 100% dos experimentos fechados com
decisão ou "INCONCLUSIVO" (PI). Política de experimentação do 3.1 (Anexo D): registro prévio, janela mínima de 7 dias,
cálculo amostral; tabela de decisão de inconclusivos (seção 14, mantida).

Mesmo estilo do registro de decisões do P02 (scripts/p02/decision_registry_gate.py, PR #926): JSON versionado, cada
registro com record_sha256 do conteúdo canônico, registro só cresce (comparação com a base), evidência verificável
no repositório ({'kind': 'repo', 'ref': caminho, 'contains': trecho}). A decisão de oferta continua no P02: o
fechamento de um experimento aponta para a decisão do P02 em vez de duplicá-la (p02_decision).

Entradas versionadas, sem rede e sem segredo:
  data/p16/experiments.json   registro prévio (schema zevanory-p16-experiments/v1): preregistrations, starts, closures
  data/experiments.json       registro VIVO lido pelo avaliador (scripts/audit/experiments.mjs) e pelo Command Center
  data/p02/decisions.json     (opcional até o #926 entrar) decisões do P02 citadas em p02_decision

Reprova (exit 1) quando:
  - um experimento do registro vivo não tem pré-registro + início registrado (nada começa sem registro prévio);
  - um pré-registro não legado não tem cálculo amostral explícito, ou o n declarado difere do n recalculado aqui
    (z bilateral de duas proporções ou de duas médias), ou o mínimo por braço fica abaixo do n calculado;
  - o início acontece antes do registro, ou o mínimo do registro vivo (minPerArm / minViewsPerSide) fica abaixo do
    mínimo pré-registrado (o avaliador decidiria com menos dados do que o registrado);
  - um experimento passou do prazo máximo da regra de parada sem fechamento (fechado = decisão ou INCONCLUSIVO);
  - um fechamento contradiz a tabela de decisão pré-registrada, decide sem atingir o n, decide antes da janela
    mínima, ou declara diferença sem p < alfa (ou "sem diferença" com p < alfa);
  - um fechado continua aberto no registro vivo (o avaliador ainda declararia vencedor);
  - registro alterado (record_sha256) ou removido em relação à base.
Legado: só os três experimentos iniciados em 2026-10-12 sem cálculo amostral (LEGACY_KEYS, lista fechada) podem
ter pré-registro sem cálculo, e só se estiverem fechados como INCONCLUSIVO (SEM_PRE_REGISTRO_VALIDO).
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import re
import sys
from pathlib import Path

SCHEMA = "zevanory-p16-experiments/v1"
SCHEMA_VERSION = 1
OUTCOMES = {"MANTER", "REFORCAR", "REFORMULAR", "APOSENTAR", "INCONCLUSIVO"}  # mesmos do P02 (seção 12)
RESULTS = ("VARIANTE_MELHOR", "SEM_DIFERENCA", "VARIANTE_PIOR", "AMOSTRA_INSUFICIENTE")
LEGACY_RESULT = "SEM_PRE_REGISTRO_VALIDO"
# Fechada: experimentos que já estavam no registro vivo em 2026-10-12, antes deste gate. Nenhum outro vira legado.
LEGACY_KEYS = frozenset({"short-format", "product-page-v2", "nurture-match"})
DESIGNS = {"ab_proportions": "two_proportions_z", "before_after_proportions": "two_proportions_z", "ab_means": "two_means_z"}
LIVE_KIND = {"ab_proportions": "arms", "ab_means": "arms", "before_after_proportions": "before_after"}
LIVE_MIN_FIELD = {"arms": "minPerArm", "before_after": "minViewsPerSide"}
LIVE_START_FIELD = {"arms": "startedAt", "before_after": "changeAt", "tracking": "startedAt"}
MIN_WINDOW_DAYS = 7  # 3.1: janela de 7 dias
MAX_WINDOW_DAYS = 120
PRE_RE = re.compile(r"^X-(\d{4})-(\d{4})$")
START_RE = re.compile(r"^S-(\d{4})-(\d{4})$")
CLOSE_RE = re.compile(r"^C-(\d{4})-(\d{4})$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
P02_RE = re.compile(r"^D-\d{4}-\d{4}$")


def record_hash(rec: dict) -> str:
    body = {k: v for k, v in rec.items() if k != "record_sha256"}
    canon = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- cálculo amostral (sem dependências externas)

def norm_ppf(p: float) -> float:
    """Inversa da normal padrão (algoritmo de Acklam, erro relativo < 1,2e-9), com um passo de Newton."""
    if not 0.0 < p < 1.0:
        raise ValueError("p fora de (0, 1)")
    a = (-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02, 1.383577518672690e02,
         -3.066479806614716e01, 2.506628277459239e00)
    b = (-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02, 6.680131188771972e01,
         -1.328068155288572e01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00, -2.549732539343734e00,
         4.374664141464968e00, 2.938163982698783e00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00, 3.754408661907416e00)
    lo, hi = 0.02425, 1 - 0.02425
    if p < lo:
        q = math.sqrt(-2 * math.log(p))
        x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    elif p > hi:
        q = math.sqrt(-2 * math.log(1 - p))
        x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    else:
        q = p - 0.5
        r = q * q
        x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    e = 0.5 * math.erfc(-x / math.sqrt(2)) - p
    return x - e * math.sqrt(2 * math.pi) * math.exp(x * x / 2)


def required_n(ss: dict) -> int:
    """n por braço. two_proportions_z: Fleiss sem correção de continuidade; two_means_z: 2((z_a+z_b) sd / mde)^2."""
    alpha, power = float(ss["alpha"]), float(ss["power"])
    z_a = norm_ppf(1 - alpha / 2) if ss.get("two_sided", True) else norm_ppf(1 - alpha)
    z_b = norm_ppf(power)
    mde = float(ss["mde_abs"])
    if ss["method"] == "two_proportions_z":
        p1 = float(ss["baseline"]["value"])
        p2 = p1 + mde
        pbar = (p1 + p2) / 2
        num = z_a * math.sqrt(2 * pbar * (1 - pbar)) + z_b * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
        return math.ceil(round((num * num) / (mde * mde), 9))
    sd = float(ss["sd"])
    return math.ceil(round(2 * ((z_a + z_b) * sd / mde) ** 2, 9))


# ---------------------------------------------------------------- utilidades

def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


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
    """Evidência verificável no repositório: {'kind': 'repo', 'ref': caminho relativo, 'contains': trecho 8+}."""
    if not isinstance(ev, dict) or ev.get("kind") != "repo":
        errs.append(f"{where}: evidência deve ser {{'kind': 'repo', 'ref', 'contains'}}")
        return False
    ref = ev.get("ref")
    if not isinstance(ref, str) or not ref or ref.startswith(("/", "\\")) or ".." in Path(ref).parts:
        errs.append(f"{where}: caminho de repositório inválido: {ref!r}")
        return False
    p = root / ref
    if not p.is_file():
        errs.append(f"{where}: arquivo de evidência não existe: {ref}")
        return False
    needle = ev.get("contains")
    if not isinstance(needle, str) or len(needle) < 8:
        errs.append(f"{where}: evidência {ref} precisa de 'contains' (trecho literal com 8+ caracteres)")
        return False
    if needle not in p.read_text(encoding="utf-8", errors="replace"):
        errs.append(f"{where}: trecho citado não aparece em {ref}: {needle!r}")
        return False
    return True


def _ordered(records, rx, label: str, errs: list[str]) -> dict:
    out: dict[str, dict] = {}
    last = None
    for i, rec in enumerate(records):
        where = f"{label}[{i}] {rec.get('id') if isinstance(rec, dict) else '?'}"
        if not isinstance(rec, dict):
            errs.append(f"{where}: deve ser objeto")
            continue
        rid = rec.get("id")
        m = rx.match(rid) if isinstance(rid, str) else None
        if not m:
            errs.append(f"{where}: id fora do padrão {rx.pattern}")
            continue
        num = int(m.group(1)) * 10000 + int(m.group(2))
        if last is not None and num <= last:
            errs.append(f"{where}: ids devem crescer na ordem do registro")
        last = num
        if rid in out:
            errs.append(f"{where}: id repetido")
        if rec.get("record_sha256") != record_hash(rec):
            errs.append(f"{where}: record_sha256 não confere com o conteúdo (registro alterado ou hash não recalculado)")
        out[rid] = rec
    return out


# ---------------------------------------------------------------- regras

def check_prereg(root: Path, rec: dict, today: dt.date, errs: list[str], notes: list[str]) -> None:
    where = f"pré-registro {rec.get('id')}"
    reg = _date(rec.get("registered_at"), "registered_at", errs, where)
    if reg and reg > today:
        errs.append(f"{where}: registered_at no futuro")
    key = rec.get("experiment_key")
    if not isinstance(key, str) or not re.match(r"^[a-z0-9][a-z0-9-]{2,63}$", key):
        errs.append(f"{where}: experiment_key inválido")
    for k in ("hypothesis", "recorded_by"):
        if not isinstance(rec.get(k), str) or len(rec[k].strip()) < (20 if k == "hypothesis" else 3):
            errs.append(f"{where}: {k} ausente ou curto")
    metric = rec.get("metric")
    if not isinstance(metric, dict) or not all(isinstance(metric.get(k), str) and metric[k].strip() for k in ("name", "definition")):
        errs.append(f"{where}: metric precisa de name e definition")
    elif re.search(r"\babert", metric["name"] + " " + metric["definition"], re.I):
        errs.append(f"{where}: abertura de e-mail não decide (3.1); use cliques ou ações")
    legacy = rec.get("legacy") is True
    if legacy:
        if key not in LEGACY_KEYS:
            errs.append(f"{where}: legacy só vale para {sorted(LEGACY_KEYS)} (lista fechada); experimento novo exige cálculo amostral")
        if rec.get("sample_size") is not None:
            errs.append(f"{where}: pré-registro legado não pode declarar cálculo amostral retroativo")
        return
    design = rec.get("design")
    if design not in DESIGNS:
        errs.append(f"{where}: design deve ser um de {sorted(DESIGNS)} (A/B ou antes/depois com cálculo amostral)")
        return
    arms = rec.get("arms")
    if not isinstance(arms, list) or len(arms) < 2 or len(set(arms)) != len(arms) or not all(isinstance(a, str) and a for a in arms):
        errs.append(f"{where}: arms deve listar ao menos 2 braços distintos")
    ss = rec.get("sample_size")
    if not isinstance(ss, dict):
        errs.append(f"{where}: A/B sem cálculo amostral (sample_size ausente)")
        return
    if ss.get("method") != DESIGNS[design]:
        errs.append(f"{where}: sample_size.method deve ser {DESIGNS[design]} para {design}")
        return
    ok = True
    if not _num(ss.get("alpha")) or not 0 < ss["alpha"] <= 0.10:
        errs.append(f"{where}: alpha deve estar em (0; 0,10]")
        ok = False
    if not _num(ss.get("power")) or not 0.80 <= ss["power"] < 1:
        errs.append(f"{where}: power deve estar em [0,80; 1)")
        ok = False
    if not isinstance(ss.get("two_sided"), bool):
        errs.append(f"{where}: two_sided deve ser booleano")
        ok = False
    if not _num(ss.get("mde_abs")) or ss["mde_abs"] <= 0:
        errs.append(f"{where}: mde_abs (efeito mínimo detectável, absoluto) deve ser > 0")
        ok = False
    if ss.get("method") == "two_proportions_z":
        base = ss.get("baseline")
        if not isinstance(base, dict) or not _num(base.get("value")) or not 0 < base["value"] < 1:
            errs.append(f"{where}: baseline.value deve ser proporção em (0; 1)")
            ok = False
        elif ok and not 0 < base["value"] + ss["mde_abs"] < 1:
            errs.append(f"{where}: baseline + mde_abs fora de (0; 1)")
            ok = False
    else:
        base = ss.get("baseline")
        if not _num(ss.get("sd")) or ss["sd"] <= 0:
            errs.append(f"{where}: sd deve ser > 0 em two_means_z")
            ok = False
    if isinstance(base, dict):
        if "source" in base:
            if not check_ref(root, base["source"], f"{where} fonte da linha de base", errs):
                ok = False
        elif isinstance(base.get("assumption"), str) and len(base["assumption"].strip()) >= 20:
            notes.append(f"{rec.get('id')}: linha de base ASSUMIDA ({base['assumption'][:80]})")
        else:
            errs.append(f"{where}: linha de base sem fonte verificável nem premissa declarada (assumption)")
            ok = False
    elif ss.get("method") == "two_means_z":
        errs.append(f"{where}: baseline (fonte ou premissa do sd) obrigatória")
        ok = False
    n_decl = ss.get("n_per_arm")
    if not _int(n_decl) or n_decl <= 0:
        errs.append(f"{where}: sample_size.n_per_arm deve ser inteiro positivo")
        ok = False
    if ok:
        n_calc = required_n(ss)
        if n_decl != n_calc:
            errs.append(f"{where}: n_per_arm declarado ({n_decl}) difere do recalculado ({n_calc})")
    min_n = rec.get("min_n_per_arm")
    if not _int(min_n) or (_int(n_decl) and min_n < n_decl):
        errs.append(f"{where}: min_n_per_arm deve ser inteiro >= n_per_arm do cálculo amostral")
    stop = rec.get("stop_rule")
    if not isinstance(stop, dict):
        errs.append(f"{where}: stop_rule ausente")
    else:
        mn, mx = stop.get("min_duration_days"), stop.get("max_duration_days")
        if not _int(mn) or mn < MIN_WINDOW_DAYS:
            errs.append(f"{where}: stop_rule.min_duration_days deve ser >= {MIN_WINDOW_DAYS} (janela do 3.1)")
        if not _int(mx) or not (_int(mn) and mn <= mx <= MAX_WINDOW_DAYS):
            errs.append(f"{where}: stop_rule.max_duration_days deve ficar entre min_duration_days e {MAX_WINDOW_DAYS}")
        if stop.get("early_stop") not in ("NENHUMA", "SEGURANCA"):
            errs.append(f"{where}: stop_rule.early_stop deve ser NENHUMA ou SEGURANCA")
        elif stop["early_stop"] == "SEGURANCA" and not (isinstance(stop.get("condition"), str) and len(stop["condition"].strip()) >= 20):
            errs.append(f"{where}: parada de segurança exige condition explícita")
    an = rec.get("analysis")
    if not isinstance(an, dict) or not isinstance(an.get("test"), str) or not an["test"].strip():
        errs.append(f"{where}: analysis.test ausente")
    elif isinstance(ss, dict) and an.get("alpha") != ss.get("alpha"):
        errs.append(f"{where}: analysis.alpha deve ser o mesmo alpha do cálculo amostral")
    table = rec.get("decision_table")
    if not isinstance(table, dict) or set(table) != set(RESULTS):
        errs.append(f"{where}: decision_table deve cobrir exatamente {list(RESULTS)}")
    else:
        for r, o in table.items():
            if o not in OUTCOMES:
                errs.append(f"{where}: decision_table[{r}] = {o!r} fora de {sorted(OUTCOMES)}")
        if table.get("AMOSTRA_INSUFICIENTE") != "INCONCLUSIVO":
            errs.append(f"{where}: tabela de decisão de inconclusivos [3.1]: AMOSTRA_INSUFICIENTE só pode ser INCONCLUSIVO")
        if table.get("SEM_DIFERENCA") in ("REFORCAR",):
            errs.append(f"{where}: SEM_DIFERENCA não pode levar a REFORCAR (reforço exige variante melhor)")
        if table.get("VARIANTE_PIOR") in ("REFORCAR", "MANTER") and table.get("VARIANTE_PIOR") == table.get("VARIANTE_MELHOR"):
            errs.append(f"{where}: VARIANTE_PIOR e VARIANTE_MELHOR não podem levar à mesma decisão de reforço")


def check_closure(root: Path, rec: dict, pre: dict, start: dict | None, today: dt.date, p02: dict | None,
                  errs: list[str], notes: list[str]) -> None:
    where = f"fechamento {rec.get('id')}"
    closed = _date(rec.get("closed_at"), "closed_at", errs, where)
    if closed and closed > today:
        errs.append(f"{where}: closed_at no futuro")
    if start is None:
        errs.append(f"{where}: experimento fechado sem início registrado")
    else:
        st = _date(start.get("started_at"), "started_at", [], where)
        if closed and st and closed < st:
            errs.append(f"{where}: closed_at antes do início")
    outcome, result = rec.get("outcome"), rec.get("result")
    if outcome not in OUTCOMES:
        errs.append(f"{where}: fechamento sem decisão: outcome deve ser um de {sorted(OUTCOMES)}")
    for k in ("outcome_reason", "action", "recorded_by"):
        if not isinstance(rec.get(k), str) or len(rec[k].strip()) < (20 if k == "outcome_reason" else 3):
            errs.append(f"{where}: {k} ausente ou curto")
    obs = rec.get("observed")
    if not isinstance(obs, dict) or obs.get("status") not in ("MEASURED", "NOT_AVAILABLE"):
        errs.append(f"{where}: observed.status deve ser MEASURED ou NOT_AVAILABLE")
        obs = {}
    if obs.get("status") == "NOT_AVAILABLE":
        if not isinstance(obs.get("reason"), str) or len(obs["reason"].strip()) < 10:
            errs.append(f"{where}: NOT_AVAILABLE exige motivo")
        for k in ("n_per_arm", "p_value"):
            if k in obs:
                errs.append(f"{where}: dado NOT_AVAILABLE não pode trazer '{k}' (número sem fonte)")
    sup = rec.get("p02_decision")
    if sup is not None:
        if not isinstance(sup, str) or not P02_RE.match(sup):
            errs.append(f"{where}: p02_decision deve seguir D-AAAA-NNNN")
        elif p02 is None:
            notes.append(f"{rec.get('id')}: ligação {sup} ao P02 não verificada (data/p02/decisions.json ausente; PR #926)")
        else:
            d = {x.get("id"): x for x in p02.get("decisions", []) if isinstance(x, dict)}.get(sup)
            if d is None:
                errs.append(f"{where}: p02_decision {sup} não existe em data/p02/decisions.json")
            elif d.get("outcome") != outcome:
                errs.append(f"{where}: outcome {outcome} diverge da decisão {sup} do P02 ({d.get('outcome')})")
    if pre.get("legacy") is True:
        if result != LEGACY_RESULT or outcome != "INCONCLUSIVO":
            errs.append(f"{where}: experimento legado (sem cálculo amostral) só fecha como {LEGACY_RESULT} -> INCONCLUSIVO")
        return
    if result not in RESULTS:
        errs.append(f"{where}: result deve ser um de {list(RESULTS)}")
        return
    table = pre.get("decision_table") or {}
    if table.get(result) != outcome:
        errs.append(f"{where}: outcome {outcome} contradiz a tabela de decisão pré-registrada ({result} -> {table.get(result)})")
    if outcome != "INCONCLUSIVO" and result == "AMOSTRA_INSUFICIENTE":
        errs.append(f"{where}: amostra insuficiente só pode fechar INCONCLUSIVO")
    min_n = pre.get("min_n_per_arm")
    arms = pre.get("arms") or []
    if obs.get("status") == "MEASURED":
        n = obs.get("n_per_arm")
        if not isinstance(n, dict) or set(n) != set(arms) or not all(_int(v) and v >= 0 for v in n.values()):
            errs.append(f"{where}: observed.n_per_arm deve trazer um inteiro por braço pré-registrado {arms}")
            n = {}
        if not check_ref(root, obs.get("source"), f"{where} fonte do dado", errs):
            errs.append(f"{where}: dado MEASURED sem fonte verificável")
        short = [a for a, v in n.items() if _int(min_n) and v < min_n]
        if short and result != "AMOSTRA_INSUFICIENTE":
            errs.append(f"{where}: n abaixo do mínimo pré-registrado ({min_n}) em {short}: result deve ser AMOSTRA_INSUFICIENTE")
    if result != "AMOSTRA_INSUFICIENTE":
        if obs.get("status") != "MEASURED":
            errs.append(f"{where}: {result} exige dado MEASURED")
            return
        p = obs.get("p_value")
        alpha = (pre.get("analysis") or {}).get("alpha")
        if not _num(p) or not 0 <= p <= 1:
            errs.append(f"{where}: {result} exige p_value em [0; 1]")
        elif _num(alpha):
            if result in ("VARIANTE_MELHOR", "VARIANTE_PIOR") and not p < alpha:
                errs.append(f"{where}: {result} exige p < alfa ({p} >= {alpha}); sem significância é SEM_DIFERENCA")
            if result == "SEM_DIFERENCA" and p < alpha:
                errs.append(f"{where}: SEM_DIFERENCA com p < alfa ({p} < {alpha})")
        if start is not None and closed:
            st = _date(start.get("started_at"), "started_at", [], where)
            mn = (pre.get("stop_rule") or {}).get("min_duration_days")
            if st and _int(mn) and (closed - st).days < mn:
                errs.append(f"{where}: decisão antes da janela mínima pré-registrada ({(closed - st).days} < {mn} dias); feche INCONCLUSIVO")


def validate(root: Path, registry: dict, live: dict, base: dict | None = None, today: dt.date | None = None,
             p02: dict | None = None, notes: list[str] | None = None) -> list[str]:
    errs: list[str] = []
    notes = notes if notes is not None else []
    today = today or dt.datetime.now(dt.timezone.utc).date()
    if registry.get("schema") != SCHEMA:
        errs.append(f"schema deve ser {SCHEMA}")
    if registry.get("schema_version") != SCHEMA_VERSION:
        errs.append(f"schema_version deve ser {SCHEMA_VERSION}")
    lists = {}
    for name in ("preregistrations", "starts", "closures"):
        v = registry.get(name)
        if not isinstance(v, list):
            errs.append(f"{name} deve ser lista")
            v = []
        lists[name] = v
    pres = _ordered(lists["preregistrations"], PRE_RE, "pré-registro", errs)
    starts = _ordered(lists["starts"], START_RE, "início", errs)
    closures = _ordered(lists["closures"], CLOSE_RE, "fechamento", errs)
    by_key: dict[str, dict] = {}
    for rec in pres.values():
        check_prereg(root, rec, today, errs, notes)
        k = rec.get("experiment_key")
        if k in by_key:
            errs.append(f"pré-registro {rec.get('id')}: experiment_key {k} já pré-registrado ({by_key[k].get('id')}); experimento novo exige chave nova")
        by_key[k] = rec
    start_of: dict[str, dict] = {}
    for rec in starts.values():
        where = f"início {rec.get('id')}"
        pid = rec.get("prereg")
        pre = pres.get(pid)
        if pre is None:
            errs.append(f"{where}: experimento iniciado sem pré-registro ({pid!r})")
            continue
        if pid in start_of:
            errs.append(f"{where}: {pid} já tem início registrado")
        start_of[pid] = rec
        st = _date(rec.get("started_at"), "started_at", errs, where)
        reg = _date(pre.get("registered_at"), "registered_at", [], where)
        if st and st > today:
            errs.append(f"{where}: started_at no futuro")
        if pre.get("legacy") is not True and st and reg and st < reg:
            errs.append(f"{where}: início ({st}) antes do registro prévio ({reg})")
        if not check_ref(root, rec.get("evidence"), f"{where} evidência", errs):
            errs.append(f"{where}: início sem evidência verificável")
    close_of: dict[str, dict] = {}
    for rec in closures.values():
        pid = rec.get("prereg")
        pre = pres.get(pid)
        if pre is None:
            errs.append(f"fechamento {rec.get('id')}: pré-registro inexistente ({pid!r})")
            continue
        if pid in close_of:
            errs.append(f"fechamento {rec.get('id')}: {pid} já foi fechado ({close_of[pid].get('id')})")
        close_of[pid] = rec
        check_closure(root, rec, pre, start_of.get(pid), today, p02, errs, notes)
    for pid, pre in pres.items():
        if pre.get("legacy") is True and pid not in close_of:
            errs.append(f"pré-registro {pid}: experimento legado sem cálculo amostral precisa estar fechado como INCONCLUSIVO")
        st = start_of.get(pid)
        if st and pid not in close_of and pre.get("legacy") is not True:
            d = _date(st.get("started_at"), "started_at", [], pid)
            mx = (pre.get("stop_rule") or {}).get("max_duration_days")
            if d and _int(mx) and (today - d).days > mx:
                errs.append(f"pré-registro {pid}: passou do prazo máximo ({mx} dias desde {d}) sem fechamento; registre decisão ou INCONCLUSIVO")
    # Registro vivo (avaliador + Command Center): nada roda sem pré-registro; fechado não pode seguir decidindo.
    exps = live.get("experiments") if isinstance(live, dict) else None
    if not isinstance(exps, list):
        errs.append("data/experiments.json: experiments deve ser lista")
        exps = []
    live_ids = set()
    for e in exps:
        eid = e.get("id") if isinstance(e, dict) else None
        where = f"registro vivo {eid}"
        live_ids.add(eid)
        pre = by_key.get(eid)
        if pre is None:
            errs.append(f"{where}: experimento sem pré-registro em data/p16/experiments.json (nada começa sem registro prévio)")
            continue
        pid = pre.get("id")
        st = start_of.get(pid)
        if st is None:
            errs.append(f"{where}: experimento rodando sem início registrado ({pid})")
        kind = e.get("kind")
        live_start = e.get(LIVE_START_FIELD.get(kind, "startedAt"))
        if st is not None and live_start != st.get("started_at"):
            errs.append(f"{where}: data de início do registro vivo ({live_start}) difere do início registrado ({st.get('started_at')})")
        cl = close_of.get(pid)
        mark = e.get("closed")
        if cl is not None:
            want = {"at": cl.get("closed_at"), "outcome": cl.get("outcome"), "ref": f"data/p16/experiments.json#{cl.get('id')}"}
            if not isinstance(mark, dict) or any(mark.get(k) != v for k, v in want.items()):
                errs.append(f"{where}: fechado em {cl.get('id')} mas o registro vivo não traz closed={want} (o avaliador continuaria declarando resultado)")
        elif mark is not None:
            errs.append(f"{where}: registro vivo marcado como fechado sem fechamento no registro P16")
        if pre.get("legacy") is True:
            continue
        if kind != LIVE_KIND.get(pre.get("design")):
            errs.append(f"{where}: kind {kind!r} incompatível com o design pré-registrado {pre.get('design')!r}")
            continue
        fld = LIVE_MIN_FIELD[kind]
        live_min = e.get(fld)
        if not _int(live_min) or (_int(pre.get("min_n_per_arm")) and live_min < pre["min_n_per_arm"]):
            errs.append(f"{where}: {fld}={live_min!r} abaixo do mínimo pré-registrado ({pre.get('min_n_per_arm')}); o avaliador decidiria cedo")
        if kind == "arms" and e.get("arms") != pre.get("arms"):
            errs.append(f"{where}: braços do registro vivo diferem dos pré-registrados")
    for pid, st in start_of.items():
        k = pres[pid].get("experiment_key")
        if pid not in close_of and k not in live_ids:
            errs.append(f"início {st.get('id')}: experimento {k} iniciado e aberto, mas ausente do registro vivo (sem medição)")
    if base is not None:
        for name, cur in (("preregistrations", pres), ("starts", starts), ("closures", closures)):
            for r in base.get(name, []) or []:
                rid = r.get("id") if isinstance(r, dict) else None
                if rid not in cur:
                    errs.append(f"append-only: {name} {rid} da base foi removido")
                elif cur[rid].get("record_sha256") != r.get("record_sha256"):
                    errs.append(f"append-only: {name} {rid} da base foi alterado")
    return errs


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    # python3 -I ignora PYTHONIOENCODING; no Windows a saída cairia em cp1252 e os acentos se perderiam.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".")
    ap.add_argument("--registry", default="data/p16/experiments.json")
    ap.add_argument("--live", default="data/experiments.json")
    ap.add_argument("--base", help="registro P16 da branch base, para a regra append-only")
    ap.add_argument("--today", help="AAAA-MM-DD (testes)")
    ap.add_argument("--print-hash", action="store_true", help="imprime o record_sha256 esperado de cada registro")
    ap.add_argument("--sample-size", help="JSON de sample_size: imprime o n por braço recalculado")
    args = ap.parse_args(argv)
    if args.sample_size:
        print(required_n(json.loads(args.sample_size)))
        return 0
    root = Path(args.root)
    try:
        reg = _load_json(root / args.registry)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"P16_GATE=FAIL registro ilegível: {exc}")
        return 1
    if args.print_hash:
        for name in ("preregistrations", "starts", "closures"):
            for r in reg.get(name, []):
                print(r.get("id"), record_hash(r))
        return 0
    try:
        live = _load_json(root / args.live)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"P16_GATE=FAIL registro vivo ilegível: {exc}")
        return 1
    p02 = None
    p02_path = root / "data/p02/decisions.json"
    if p02_path.is_file():
        try:
            p02 = _load_json(p02_path)
        except json.JSONDecodeError as exc:
            print(f"P16_GATE=FAIL data/p02/decisions.json ilegível: {exc}")
            return 1
    base = None
    if args.base:
        bp = Path(args.base)
        if bp.is_file() and bp.stat().st_size > 0:
            base = _load_json(bp)
    today = dt.date.fromisoformat(args.today) if args.today else None
    notes: list[str] = []
    errs = validate(root, reg, live, base, today, p02, notes)
    for n in notes:
        print(f"::notice title=P16::{n}")
    for e in errs:
        print(f"::error title=P16::{e}")
    pres = reg.get("preregistrations") if isinstance(reg.get("preregistrations"), list) else []
    closes = reg.get("closures") if isinstance(reg.get("closures"), list) else []
    starts = reg.get("starts") if isinstance(reg.get("starts"), list) else []
    closed_ids = {c.get("prereg") for c in closes if isinstance(c, dict)}
    started_ids = {s.get("prereg") for s in starts if isinstance(s, dict)}
    inc = sum(1 for c in closes if isinstance(c, dict) and c.get("outcome") == "INCONCLUSIVO")
    legacy = sum(1 for p in pres if isinstance(p, dict) and p.get("legacy") is True)
    print(f"P16_EXPERIMENTS preregistered={len(pres)} legacy={legacy} started={len(started_ids)} "
          f"open={len(started_ids - closed_ids)} closed={len(closed_ids)} inconclusivo={inc} "
          f"p02={'present' if p02 is not None else 'absent'} base={'yes' if base is not None else 'no'}")
    print(f"P16_GATE={'FAIL' if errs else 'PASS'} errors={len(errs)}")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
