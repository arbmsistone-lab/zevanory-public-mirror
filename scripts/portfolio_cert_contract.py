#!/usr/bin/env python3
"""Contrato de certificação do portfólio: pré-merge do candidato x pós-publicação da versão canônica.

Mudança formal de contrato (Sol, Ordens 265-268; exige autorização do proprietário para entrar em vigor):

* ``post-deploy`` (push em gh-pages, workflow_dispatch, ou qualquer contexto que não seja pull_request):
  produção deve ser IDÊNTICA à nova fonte em <title> e <h1> (rigor inalterado; códigos de falha
  ``live_title_mismatch`` / ``live_h1_mismatch``).
* ``pre-merge`` (somente evento pull_request): produção ainda serve a BASE. A comparação com produção é
  feita contra a fonte da BASE (prova produção == base, isto é, ausência de deriva: ``live_drift_vs_base``).
  Toda diferença candidato x base em title/h1/canonical é listada como mudança esperada, com o trecho do
  diff da fonte; só é aceita se (a) a base não mudou aquele campo depois do ponto de ramificação e
  (b) a linha do campo no candidato está dentro de um trecho adicionado pelo diff merge-base..candidato.
  Caso contrário falha com ``change_not_in_candidate_diff``.

O contexto é derivado de GITHUB_EVENT_NAME; uma variável CERT_CONTEXT só pode confirmar o contexto
derivado, nunca relaxá-lo (divergência falha fechado).
"""
import re
import subprocess

CONTRACT_VERSION = "zevanory.portfolio.cert-contract.v2"
PRE_MERGE = "pre-merge"
POST_DEPLOY = "post-deploy"
LIVE_FIELDS = ("title", "h1")
CANDIDATE_FIELDS = ("title", "h1", "canonical")
_SHA = re.compile(r"[0-9a-f]{40}")


class ContractError(AssertionError):
    def __init__(self, code, **detail):
        self.code = code
        self.detail = detail
        super().__init__(code, detail)


def resolve_context(event_name, declared=None):
    derived = PRE_MERGE if (event_name or "") == "pull_request" else POST_DEPLOY
    if declared not in (None, "") and declared != derived:
        raise ContractError("context_mismatch", event=event_name, declared=declared, derived=derived)
    return derived


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
    """Trechos do diff cujo lado novo cobre as linhas indicadas (para a evidência)."""
    out = []
    parts = re.split(r"(?m)^(?=@@ )", diff_text or "")
    for part in parts:
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


def evaluate_live_contract(context, head, live, base=None, merge_base=None, head_html="", diff_text=""):
    """Avalia o contrato. Lança ContractError na primeira violação; devolve o bloco de evidência."""
    for name, d, fields in (("head", head, CANDIDATE_FIELDS), ("live", live, LIVE_FIELDS)):
        for f in fields:
            if not d.get(f):
                raise ContractError("missing_field", side=name, field=f)
    if context == POST_DEPLOY:
        for f in LIVE_FIELDS:
            if live[f] != head[f]:
                raise ContractError(f"live_{f}_mismatch", field=f, live=live[f], source=head[f])
        return {"certification_context": POST_DEPLOY, "contract_version": CONTRACT_VERSION,
                "live_binding": "live==source(title+h1)", "expected_changes": [], "live_drift": []}
    if context != PRE_MERGE:
        raise ContractError("unknown_context", context=context)
    if base is None or merge_base is None:
        raise ContractError("premerge_base_missing")
    for name, d in (("base", base), ("merge_base", merge_base)):
        for f in LIVE_FIELDS:
            if not d.get(f):
                raise ContractError("missing_field", side=name, field=f)
    drift = [{"field": f, "live": live[f], "base": base[f]} for f in LIVE_FIELDS if live[f] != base[f]]
    if drift:
        raise ContractError("live_drift_vs_base", drift=drift)
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
    return {"certification_context": PRE_MERGE, "contract_version": CONTRACT_VERSION,
            "live_binding": "live==base(title+h1); candidate-vs-base changes recorded",
            "expected_changes": expected, "live_drift": []}


def _git(*args):
    return subprocess.check_output(["git", *args], text=True)


def git_show(rev, path):
    return _git("show", f"{rev}:{path}")


def premerge_inputs(path, head_sha, event_base_sha, live, tip_ref="refs/remotes/origin/gh-pages"):
    """Resolve a base contra a qual produção é comparada e os insumos do diff do candidato.

    Usa o SHA de base do evento; se produção não coincide com ele mas coincide com a ponta atual de gh-pages
    (deploy autorizado que entrou depois do evento), usa a ponta, registrando a resolução.
    """
    if not _SHA.fullmatch(event_base_sha or ""):
        raise ContractError("premerge_base_missing", base_sha=event_base_sha)
    candidates = [("event_base", event_base_sha)]
    try:
        tip = _git("rev-parse", tip_ref).strip()
        if _SHA.fullmatch(tip) and tip != event_base_sha:
            candidates.append(("gh_pages_tip", tip))
    except subprocess.CalledProcessError:
        pass
    chosen = None
    for label, sha in candidates:
        fields = extract_fields(git_show(sha, path))
        if chosen is None:
            chosen = (label, sha, fields)
        if all(live.get(f) == fields.get(f) for f in LIVE_FIELDS):
            chosen = (label, sha, fields)
            break
    label, base_sha, base_fields = chosen
    mb = _git("merge-base", base_sha, head_sha).strip()
    mb_fields = extract_fields(git_show(mb, path))
    diff_text = _git("diff", "--no-color", "--no-ext-diff", "-U0", mb, head_sha, "--", path)
    return {"base_sha": base_sha, "base_resolution": label, "merge_base_sha": mb,
            "base": base_fields, "merge_base": mb_fields, "diff_text": diff_text}
