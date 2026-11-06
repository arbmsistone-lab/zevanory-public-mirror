#!/usr/bin/env python3
"""Contrato de certificação do portfólio: pré-merge do candidato x pós-publicação da versão canônica.

Mudança formal de contrato (Sol, Ordens 265-268 e AVAL 271; exige autorização do proprietário para vigorar).

Superfícies publicadas (cada uma com o seu SHA efetivamente publicado, lido ao vivo):
  central = Worker "zevanory"              -> https://zevanory.api.br/api/release  (deployment.commit_sha)
  sales   = Worker "zevanory-sales-public" -> https://vendas.zevanory.api.br/health (release)
A superfície que SERVE a página certificada é a do host final após redirecionamentos.

* ``pre-merge`` (somente evento pull_request). A base de comparação com produção é a fonte no SHA
  EFETIVAMENTE PUBLICADO pela superfície que serve a página (não a ponta de gh-pages):
  - para cada superfície, a relação publicado x base do PR é registrada explicitamente
    (equal | behind_base = merges ainda não publicados / retenção de rollback | ahead_of_base);
    publicado fora da linhagem de gh-pages (diverged) ou ilegível falha fechado;
  - produção tem de ser idêntica à fonte no SHA publicado (title/h1), senão ``live_drift_vs_deployed``;
  - diferenças fonte-publicada x base são registradas como ``pending_undeployed`` por superfície (nunca em silêncio);
  - diferenças candidato x base em title/h1/canonical são ``expected_changes`` com o trecho do diff, aceitas só se
    a base não mudou o campo depois da ramificação e a linha está num trecho adicionado do diff
    merge-base..candidato (senão ``change_not_in_candidate_diff``).
* ``post-deploy`` (workflow_run de central-production-deploy / zevanory-sales-public-release com sucesso,
  push em gh-pages, workflow_dispatch): só compara DEPOIS da promoção efetiva:
  - workflow_run: a superfície do deploy que disparou TEM de reportar exatamente o SHA implantado;
  - a superfície que serve a página tem de estar publicada num SHA cuja fonte da página é a esperada;
  - espera até o prazo; sem promoção observada falha (workflow_run: ``promotion_not_observed``;
    push/dispatch: ``post_deploy_deferred``) — nunca passa e nunca acusa um falso live_title_mismatch;
  - depois da promoção: produção == nova fonte, exata (``live_title_mismatch`` / ``live_h1_mismatch``).

O contexto é derivado de GITHUB_EVENT_NAME; CERT_CONTEXT só pode confirmar o contexto derivado, nunca relaxá-lo.
"""
import re
import subprocess
import time
import urllib.parse

CONTRACT_VERSION = "zevanory.portfolio.cert-contract.v3"
PRE_MERGE = "pre-merge"
POST_DEPLOY = "post-deploy"
LIVE_FIELDS = ("title", "h1")
CANDIDATE_FIELDS = ("title", "h1", "canonical")
SURFACES = {
    "central": {"host": "zevanory.api.br", "release_url": "https://zevanory.api.br/api/release",
                "release_path": ("deployment", "commit_sha"), "workflow": "ZEVANORY central production deploy"},
    "sales": {"host": "vendas.zevanory.api.br", "release_url": "https://vendas.zevanory.api.br/health",
              "release_path": ("release",), "workflow": "ZEVANORY SALES public release"},
}
_SHA = re.compile(r"[0-9a-f]{40}")


class ContractError(AssertionError):
    def __init__(self, code, **detail):
        self.code = code
        self.detail = detail
        super().__init__(code, detail)


# ---------------------------------------------------------------- contexto
def resolve_context(event_name, declared=None):
    derived = PRE_MERGE if (event_name or "") == "pull_request" else POST_DEPLOY
    if declared not in (None, "") and declared != derived:
        raise ContractError("context_mismatch", event=event_name, declared=declared, derived=derived)
    return derived


def resolve_trigger(event_name, trigger_surface):
    """workflow_run exige a superfície do deploy que disparou; nos demais eventos não pode haver uma."""
    if (event_name or "") == "workflow_run":
        if trigger_surface not in SURFACES:
            raise ContractError("workflow_run_trigger_surface_missing", trigger=trigger_surface)
        return trigger_surface
    if trigger_surface not in (None, ""):
        raise ContractError("trigger_surface_outside_workflow_run", event=event_name, trigger=trigger_surface)
    return None


# ---------------------------------------------------------------- superfícies
def surface_for_url(url):
    host = (urllib.parse.urlsplit(url or "").hostname or "").lower()
    for name, s in SURFACES.items():
        if host == s["host"]:
            return name
    raise ContractError("unknown_serving_surface", url=url)


def release_sha(surface, payload):
    v = payload if isinstance(payload, dict) else {}
    for k in SURFACES[surface]["release_path"]:
        v = v.get(k) if isinstance(v, dict) else None
    v = str(v or "").lower()
    return v if _SHA.fullmatch(v) else None


# ---------------------------------------------------------------- campos
_TITLE = re.compile(r"<title>(.*?)</title>", re.I | re.S)
_H1 = re.compile(r"<h1[^>]*>(.*?)</h1>", re.I | re.S)
_CANON = re.compile(r"<link\b[^>]*\brel=[\"']canonical[\"'][^>]*>", re.I)
_HREF = re.compile(r"\bhref=[\"']([^\"']*)[\"']", re.I)


def _clean(x):
    return re.sub(r"<[^>]+>", "", x).strip()


def _spans(html):
    out = {}
    m = _TITLE.search(html)
    out["title"] = (m.group(1).strip(), m.span()) if m else (None, None)
    m = _H1.search(html)
    out["h1"] = (_clean(m.group(1)), m.span()) if m else (None, None)
    m = _CANON.search(html)
    if m:
        h = _HREF.search(m.group(0))
        out["canonical"] = (h.group(1) if h else None, m.span())
    else:
        out["canonical"] = (None, None)
    return out


def extract_fields(html):
    return {k: v[0] for k, v in _spans(html).items()}


def field_lines(html, field):
    span = _spans(html)[field][1]
    if span is None:
        return None
    start = html.count("\n", 0, span[0]) + 1
    end = html.count("\n", 0, max(span[0], span[1] - 1)) + 1
    return (start, end)


_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", re.M)


def added_line_ranges(diff_text):
    """Faixas (1-based, inclusivas) de linhas do lado novo adicionadas/alteradas em um diff unificado -U0."""
    ranges = []
    for m in _HUNK.finditer(diff_text or ""):
        start = int(m.group(1))
        count = 1 if m.group(2) is None else int(m.group(2))
        if count > 0:
            ranges.append((start, start + count - 1))
    return ranges


def hunks_for_lines(diff_text, lines):
    out = []
    for part in re.split(r"(?m)^(?=@@ )", diff_text or ""):
        m = _HUNK.match(part)
        if not m:
            continue
        start = int(m.group(1))
        count = 1 if m.group(2) is None else int(m.group(2))
        if count > 0 and start <= lines[1] and lines[0] <= start + count - 1:
            out.append(part.rstrip("\n")[:4000])
    return out


def _intersects(lines, ranges):
    return lines is not None and any(a <= lines[1] and lines[0] <= b for a, b in ranges)


def _require(d, fields, side):
    for f in fields:
        if not (d or {}).get(f):
            raise ContractError("missing_field", side=side, field=f)


# ---------------------------------------------------------------- pré-merge
def evaluate_premerge(head, live, deployed, base, merge_base, head_html="", diff_text="", surfaces=None,
                      serving=None):
    """deployed = campos da página na fonte do SHA publicado pela superfície que serve; surfaces = relações."""
    _require(head, CANDIDATE_FIELDS, "head")
    _require(live, LIVE_FIELDS, "live")
    surfaces = surfaces or {}
    if serving not in surfaces:
        raise ContractError("serving_surface_unrecorded", serving=serving)
    for name, s in surfaces.items():
        if s.get("relation") in (None, "unresolvable"):
            raise ContractError("deployed_sha_unresolvable", surface=name, deployed_sha=s.get("deployed_sha"))
        if s.get("relation") == "diverged":
            raise ContractError("deployed_not_in_gh_pages_lineage", surface=name, deployed_sha=s.get("deployed_sha"),
                                base_sha=s.get("base_sha"))
    if base is None or merge_base is None or deployed is None:
        raise ContractError("premerge_base_missing")
    for name, d in (("base", base), ("merge_base", merge_base), ("deployed", deployed)):
        _require(d, LIVE_FIELDS, name)
    drift = [{"field": f, "live": live[f], "deployed_source": deployed[f]} for f in LIVE_FIELDS if live[f] != deployed[f]]
    if drift:
        raise ContractError("live_drift_vs_deployed", surface=serving,
                            deployed_sha=surfaces[serving].get("deployed_sha"), drift=drift)
    pending = [{"surface": serving, "field": f, "deployed_sha": surfaces[serving].get("deployed_sha"),
                "deployed": deployed.get(f), "base": base.get(f), "relation": surfaces[serving]["relation"]}
               for f in CANDIDATE_FIELDS if deployed.get(f) != base.get(f)]
    ranges = added_line_ranges(diff_text)
    expected = []
    for f in CANDIDATE_FIELDS:
        if head.get(f) == base.get(f):
            continue
        if merge_base.get(f) != base.get(f):
            raise ContractError("change_not_in_candidate_diff", field=f, reason="base_changed_after_branch_point",
                                base=base.get(f), merge_base=merge_base.get(f), candidate=head.get(f))
        lines = field_lines(head_html, f)
        if not _intersects(lines, ranges):
            raise ContractError("change_not_in_candidate_diff", field=f, reason="field_line_not_in_added_hunks",
                                candidate_lines=lines, added_ranges=ranges)
        expected.append({"field": f, "base": base.get(f), "candidate": head.get(f),
                         "candidate_lines": list(lines), "source_diff": hunks_for_lines(diff_text, lines)})
    return {"certification_context": PRE_MERGE, "contract_version": CONTRACT_VERSION, "serving_surface": serving,
            "live_binding": "live==source@deployed_sha(title+h1); deployed-vs-base and candidate-vs-base recorded",
            "surfaces": surfaces, "pending_undeployed": pending, "expected_changes": expected, "live_drift": []}


# ---------------------------------------------------------------- pós-publicação
def evaluate_post_deploy(head, live, promotion):
    """Só depois de await_promotion: produção == nova fonte, exata."""
    if not promotion or promotion.get("state") != "PROMOTED":
        raise ContractError("post_deploy_without_promotion", promotion=promotion)
    _require(head, CANDIDATE_FIELDS, "head")
    _require(live, LIVE_FIELDS, "live")
    for f in LIVE_FIELDS:
        if live[f] != head[f]:
            raise ContractError(f"live_{f}_mismatch", field=f, live=live[f], source=head[f], promotion=promotion)
    return {"certification_context": POST_DEPLOY, "contract_version": CONTRACT_VERSION,
            "live_binding": "live==source(title+h1) after observed promotion", "promotion": promotion,
            "expected_changes": [], "pending_undeployed": [], "live_drift": []}


def await_promotion(expected_sha, expected_fields, serving, read_release, fields_at, trigger=None,
                    wait_seconds=900, interval=20, sleep=time.sleep, clock=time.monotonic):
    """Espera a promoção efetiva. read_release(surface)->sha|None; fields_at(sha)->campos da página|None.

    Pronto quando (a) a superfície do deploy que disparou (workflow_run) reporta exatamente expected_sha e
    (b) a superfície que serve a página está publicada num SHA cuja fonte da página tem title/h1 esperados.
    """
    if not _SHA.fullmatch(expected_sha or ""):
        raise ContractError("expected_sha_invalid", expected_sha=expected_sha)
    deadline = clock() + max(0, wait_seconds)
    attempts = 0
    while True:
        attempts += 1
        trig = read_release(trigger) if trigger else None
        serv = trig if trigger == serving else read_release(serving)
        serv_fields = fields_at(serv) if serv else None
        trig_ok = trigger is None or trig == expected_sha
        serv_ok = bool(serv_fields) and all(serv_fields.get(f) == expected_fields.get(f) for f in LIVE_FIELDS)
        obs = {"expected_sha": expected_sha, "trigger_surface": trigger, "trigger_release": trig,
               "serving_surface": serving, "serving_release": serv, "attempts": attempts}
        if trig_ok and serv_ok:
            return {"state": "PROMOTED", **obs}
        if clock() >= deadline:
            code = "promotion_not_observed" if trigger else "post_deploy_deferred"
            raise ContractError(code, trigger_ok=trig_ok, serving_ok=serv_ok, **obs)
        sleep(interval)


# ---------------------------------------------------------------- git
def _git(*args):
    return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL)


def ensure_commit(sha):
    try:
        _git("cat-file", "-e", f"{sha}^{{commit}}")
        return True
    except subprocess.CalledProcessError:
        pass
    try:
        _git("fetch", "--quiet", "--no-tags", "--filter=blob:none", "origin", sha)
        _git("cat-file", "-e", f"{sha}^{{commit}}")
        return True
    except subprocess.CalledProcessError:
        return False


def git_show(rev, path):
    return _git("show", f"{rev}:{path}")


def fields_at_sha(sha, path):
    if not sha or not ensure_commit(sha):
        return None
    try:
        return extract_fields(git_show(sha, path))
    except subprocess.CalledProcessError:
        return None


def _is_ancestor(a, b):
    return subprocess.run(["git", "merge-base", "--is-ancestor", a, b], capture_output=True).returncode == 0


def relation(deployed_sha, base_sha, lineage_ref="refs/remotes/origin/gh-pages"):
    """equal | behind_base | ahead_of_base | diverged (fora da história de gh-pages) | unresolvable."""
    if not deployed_sha or not ensure_commit(deployed_sha):
        return "unresolvable"
    if not _is_ancestor(deployed_sha, lineage_ref):
        return "diverged"
    if deployed_sha == base_sha:
        return "equal"
    if _is_ancestor(deployed_sha, base_sha):
        return "behind_base"
    if _is_ancestor(base_sha, deployed_sha):
        return "ahead_of_base"
    return "diverged"


def premerge_inputs(path, head_sha, event_base_sha, deployed_shas, serving, lineage_ref="refs/remotes/origin/gh-pages"):
    """Base do PR + fonte no SHA publicado de cada superfície; nada é escolhido em silêncio."""
    if not _SHA.fullmatch(event_base_sha or ""):
        raise ContractError("premerge_base_missing", base_sha=event_base_sha)
    surfaces = {}
    for name in SURFACES:
        sha = (deployed_shas or {}).get(name)
        surfaces[name] = {"deployed_sha": sha, "base_sha": event_base_sha, "relation": relation(sha, event_base_sha, lineage_ref)}
    base_fields = extract_fields(git_show(event_base_sha, path))
    dep = surfaces.get(serving, {}).get("deployed_sha")
    deployed_fields = fields_at_sha(dep, path) if surfaces.get(serving, {}).get("relation") not in (None, "unresolvable") else None
    mb = _git("merge-base", event_base_sha, head_sha).strip()
    mb_fields = extract_fields(git_show(mb, path))
    diff_text = _git("diff", "--no-color", "--no-ext-diff", "-U0", mb, head_sha, "--", path)
    return {"base_sha": event_base_sha, "merge_base_sha": mb, "surfaces": surfaces, "base": base_fields,
            "deployed": deployed_fields, "merge_base": mb_fields, "diff_text": diff_text}
