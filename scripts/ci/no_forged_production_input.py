#!/usr/bin/env python3
"""R4 (PI) guard: no GitHub Actions workflow may send forged or signed input to a PRODUCTION host (incident I1).

Between 4 and 8 October 2026 workflows POSTed signed Meta-style webhooks to the production Worker; the live bot answered
real WhatsApp users and Meta banned the WhatsApp Business account. Disabling the workflows through the API is not a
regression guard: this static scan is. It is fail-closed: any hit not covered by an explicit, justified allow-list
entry, any unreadable file, an empty workflow set, a malformed or stale allow-list, or an internal error fails.

What is scanned
  * every ``.github/workflows/*.yml|*.yaml`` (the whole file: run blocks, heredocs, github-script);
  * every repo script those workflows EXECUTE (paths named in ``run:``/``script:`` blocks, .py .mjs .cjs .js .sh .ts),
    and, transitively up to ``--depth`` (default 3), the repo scripts those scripts execute or import. Files only
    syntax-checked (``node --check``, ``py_compile``) or merely read (cat, sha256sum, git diff, grep) are not executed
    and are not followed. Production runtime source (``worker/``, root ``*worker*.mjs``) is not followed either: it is
    the deployed service, driven in-process by tests (``worker.fetch(new Request(...))`` is not network traffic).
  * helper functions are resolved inside each file: a call of a local helper (Python def/method, JS function/arrow)
    whose body makes a request with a parameter-fed URL is judged at the call site with the arguments bound.

Production hosts
  ``zevanory.api.br`` and every ``*.zevanory.api.br`` (zevanory.api.br, edge., vendas., controle., ...), and the
  workers.dev names of the production Cloudflare accounts: ``*.girolocal-rb.workers.dev`` and ``*.zevanory.workers.dev``.

Requests recognised (method inferred; only POST, PUT, PATCH, DELETE or an unknown method count as mutating)
  curl, wget, httpie; JS ``fetch(...)`` (``obj.fetch(...)`` such as ``worker.fetch`` is an in-process call and is
  ignored), ``fetch(req)`` resolved through ``new Request(...)``, ``http(s).request(...)``; Python ``requests``/
  ``httpx``/session verbs and ``urllib.request.Request``. The URL argument is resolved through literal assignments in
  the same file (const/let/var, Python, shell, YAML env) and through ``process.env.X`` / ``os.environ`` / ``$X`` names
  that an invoking workflow sets to a production URL.

Rules (a hit is a mutating request whose target resolves to a production host and ...)
  R4-INBOUND    ... whose path is a webhook or inbound endpoint (/api/webhooks/*, /api/internal/*, inbound, meta,
                whatsapp, resend, mercadopago, asaas, webhook);
  R4-SIGNED     ... that carries a signature/HMAC header (x-hub-signature[-256], x-signature, svix-*, webhook-signature,
                stripe-signature, any x-*-signature);
  R4-HMAC       ... with an HMAC computed within ``HMAC_WINDOW`` lines of it in the same file;
  R4-UNRESOLVED a mutating request with an unresolvable target that is signed or has an HMAC nearby, in a file that (or
                whose invoking workflow) names a production host. Fail-closed: if we cannot prove where it goes, it fails.
  GET/HEAD readbacks (/api/release, /api/health, public pages) and calls to provider APIs (api.resend.com,
  api.cloudflare.com, api.mercadopago.com, graph.facebook.com, ...) are not production inbound endpoints: they pass.

Allow-list (``scripts/ci/no_forged_production_input_allow.json``, schema ``r4-allow/v2``; Sol rule R4, 24/10/2026)
  ``allowed``: a ZEVANORY-internal authenticated call is allowed only when ALL conditions are recorded and validated:
  registered ``endpoint`` + ``method`` (the hit must match both), ZEVANORY's own ``identity`` (impersonates []),
  concrete ``purpose`` and ``least_privilege``, ``effects`` and ``data_scope`` all false (no synthetic financial
  transaction, no sales opening, no commercial effect, no webhook/checkout, no credential/config change, no production
  data altered/deleted/restored), controlled ``payload`` (idempotent if it writes, audit trail free of secrets),
  existing ``handler_evidence`` file:line references and an existing ``counter_proof_test``. Only R4-INBOUND hits can be
  allowed: signed, HMAC or unresolved requests never are. ``risk_acceptance`` is a SEPARATE field (PENDING_OWNER or
  ACCEPTED with by/at/reference); an allow entry never implies acceptance.
  ``open_real_risks``: REAL_RISK / OPEN_NOT_HOMOLOGATED hits, never accepted here, each with an independent control:
  an owner-approval gate (first step of every job that can run it, verified) or a pending fix PR (reported).
  ``financial_gates``: the financial workflows in REQUIRED_GATE_WORKFLOWS must carry the owner-approval gate as the
  first step of every job (and stay ``if: false`` when required); PENDING_FIX_PR is accepted only while the gate is
  still absent. Stale entries, unknown or missing fields fail the scan.

Usage: python3 scripts/ci/no_forged_production_input.py [--root DIR] [--allow FILE] [--json] [--depth N]
Exit: 0 clean; 1 hits; 2 configuration or scan error (fail-closed).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

PROD_HOST_RE = re.compile(
    r"(?<![\w.-])(?:[a-z0-9-]+\.)*zevanory\.api\.br(?![\w-])"
    r"|(?<![\w.-])(?!zevanory-certification\.)(?:[a-z0-9-]+\.)+(?:girolocal-rb|zevanory)\.workers\.dev(?![\w-])", re.I)
INBOUND_RE = re.compile(
    r"/api/webhooks?(?![\w-])|/api/internal(?![\w-])|inbound|(?<![\w-])meta(?![\w-])|whatsapp|resend"
    r"|mercado[-_]?pago|asaas|webhook", re.I)
SIG_HEADER_RE = re.compile(
    r"(?<![\w-])(?:x-hub-signature(?:-256)?|x-signature|svix-(?:signature|id|timestamp)|webhook-signature"
    r"|webhook-timestamp|stripe-signature|x-[\w-]*-signature(?:-256)?|[\w-]*-signature-256)(?![\w-])", re.I)
HMAC_RE = re.compile(
    r"createHmac\s*\(|\bhmac\s*\.\s*(?:new|digest|HMAC)\s*\(|['\"]HMAC['\"]|openssl\s+dgst[^\n]*-hmac"
    r"|openssl\s+mac\b|-mac\s+HMAC|\bhmac_sha256\s*\(|\bhmacSha256\s*\(|\bsignHmac\s*\(", re.I)
HMAC_WINDOW = 60
MUTATING = {"POST", "PUT", "PATCH", "DELETE", "UNKNOWN"}
HTTP_VERBS = {"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"}
SCRIPT_EXT = (".py", ".mjs", ".cjs", ".js", ".sh", ".ts")
# Production runtime source (the deployed Workers themselves). Tests import these modules in-process and drive them with
# worker.fetch(new Request(...)), which is not network traffic; the modules' own outbound fetches are the service's
# runtime calls to providers, not CI-originated input. They are therefore not followed; the CI files that import them
# are scanned. Residual risk (documented in the PR): a CI script calling a runtime helper that itself POSTs to production.
RUNTIME_SOURCE_RE = re.compile(r"^(?:worker/|[^/]*worker[^/]*\.(?:mjs|js)$)")
DEFAULT_ALLOW = "scripts/ci/no_forged_production_input_allow.json"
# Sol rule R4 (24/10/2026): an internal ZEVANORY call may be allowed only when ALL conditions hold, each recorded as a
# field and validated here. Risk acceptance is a SEPARATE field and is never implied by an allow entry.
ALLOW_REQUIRED = {"file", "line_pattern", "endpoint", "method", "identity", "purpose", "least_privilege", "effects",
                  "data_scope", "payload", "handler_evidence", "counter_proof_test", "risk_acceptance"}
ALLOW_OPTIONAL = {"notes"}
EFFECT_KEYS = {"synthetic_financial_transaction", "opens_sales", "commercial_effect", "triggers_webhook_or_checkout",
               "changes_credentials_or_config"}
DATA_SCOPE_KEYS = {"alters_production_data", "deletes_production_data", "restores_into_production"}
PAYLOAD_KEYS = {"controlled", "writes", "idempotent", "audit_trail", "secrets_in_audit"}
ACCEPTANCE_KEYS = {"status", "by", "at", "reference"}
ALLOWABLE_RULES = {"R4-INBOUND"}  # signed, HMAC or unresolved requests can never be allow-listed
OPEN_REQUIRED = {"file", "line_pattern", "classification", "status", "reason", "evidence", "required_fix",
                 "independent_control", "risk_acceptance"}
GATE_REQUIRED = {"workflow", "variable", "require_job_if_false", "status", "reference"}
# Financial workflows that must always carry an independent owner-approval gate (Sol R4 item 2d).
REQUIRED_GATE_WORKFLOWS = {".github/workflows/mercadopago-exact-sha-recovery.yml",
                           ".github/workflows/financial-e2e-stripe.yml"}
GATE_STEP_NAME = "R4 owner approval gate"
NOT_EXECUTED_RE = re.compile(
    r"node\s+(?:--check|-c)\b|py_compile|\bcompileall\b|\bcat\s|\bsha256sum\b|\bsha1sum\b|\bmd5sum\b|\bgit\s+(?:diff|show|log|"
    r"ls-files|add|rm|mv)\b|\bgrep\b|\brg\b|\bwc\b|\bhead\s|\btail\s|\bstat\s|\btest\s+-[efs]\b|\[\s+-[efs]\b|\bls\s|"
    r"\bdiff\s|\bcmp\s|hashFiles\(", re.I)
PATH_TOKEN_RE = re.compile(r"(?<![\w$@/.-])((?:\.{1,2}/)*[\w][\w./-]*\.(?:py|mjs|cjs|js|sh|ts))(?![\w/-])")
PY_IMPORT_RE = re.compile(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", re.M)


class ScanError(Exception):
    """Configuration or scan defect: always exit 2."""


# ------------------------------------------------------------------ small text helpers
def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def balanced(text, open_pos):
    """Text inside the parenthesis starting at text[open_pos] == '(' (quote-aware, template-literal aware)."""
    depth, i, n, quote = 0, open_pos, len(text), None
    while i < n:
        c = text[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                return text[open_pos + 1:i]
        i += 1
    return text[open_pos + 1:min(n, open_pos + 4000)]


def split_top(args):
    """Split call arguments at top-level commas."""
    out, depth, cur, quote, i = [], 0, [], None, 0
    while i < len(args):
        c = args[i]
        if quote:
            cur.append(c)
            if c == "\\" and i + 1 < len(args):
                cur.append(args[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
            cur.append(c)
        elif c in "([{":
            depth += 1
            cur.append(c)
        elif c in ")]}":
            depth -= 1
            cur.append(c)
        elif c == "," and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    if "".join(cur).strip():
        out.append("".join(cur))
    return out


def is_comment_line(line):
    s = line.lstrip()
    return s.startswith("#") or s.startswith("//")


# ------------------------------------------------------------------ resolution
class Resolver:
    """Literal assignments in one file plus env names an invoking workflow sets to production URLs."""

    ASSIGN_RES = [
        re.compile(r"^\s*(?:export\s+|readonly\s+|local\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_]\w*)=(.+)$", re.M),
        re.compile(r"(?:\b(?:const|let|var)\s+|^\s*)([A-Za-z_$][\w$]*)\s*(?::\s*[\w\[\]|<> ]+)?=(?![=>])\s*(.+)", re.M),
        re.compile(r"^[ \t]*-?[ \t]*['\"]?([A-Za-z_][\w-]*)['\"]?[ \t]*:[ \t]+(['\"]?https?://\S+)", re.M),
        re.compile(r"\b([A-Za-z_$][\w$]*)['\"]?\s*:\s*(['\"`]https?://[^'\"`]+['\"`])"),
    ]

    def __init__(self, text, env_taint=()):
        self.defs = {}
        for rx in self.ASSIGN_RES:
            for m in rx.finditer(text):
                self.defs.setdefault(m.group(1), []).append((m.start(2), m.group(2)[:600]))
        for v in self.defs.values():
            v.sort()
        self.env_taint = set(env_taint)

    def lookup(self, name, pos):
        """The definition of name that governs position pos: the nearest preceding one, else the nearest following."""
        cands = self.defs.get(name) or []
        before = [d for d in cands if d[0] < pos]
        if before:
            return before[-1]
        return cands[0] if cands else None

    def values(self, name):
        return [v for _, v in self.defs.get(name, [])]

    def expand(self, expr, pos=0, depth=3, seen=None):
        """expr with each identifier/env reference replaced by its governing definition (bounded recursion)."""
        seen = set() if seen is None else seen
        out = [expr]
        if depth <= 0:
            return " ".join(out)
        for name in self.env_refs(expr):
            if name in self.env_taint:
                out.append(" https://zevanory.api.br#env:" + name)
        names = set(re.findall(r"\$\{?([A-Za-z_]\w*)", expr)) | set(re.findall(r"(?<![\w$.'\"])([A-Za-z_$][\w$]*)", expr))
        for name in sorted(names):
            if name in seen or name in self.SKIP:
                continue
            seen.add(name)
            if name in self.env_taint:
                out.append(" https://zevanory.api.br#env:" + name)
            d = self.lookup(name, pos)
            if d:
                out.append(self.expand(d[1], d[0], depth - 1, seen))
        return " ".join(out)

    SKIP = {"process", "env", "os", "environ", "https", "http", "const", "let", "var", "await", "new", "true",
            "false", "null", "None", "method", "headers", "body", "signal", "encodeURIComponent", "String", "URL"}

    @staticmethod
    def env_refs(expr):
        names = set(re.findall(r"process\.env(?:\.([A-Za-z_]\w*)|\[\s*['\"]([A-Za-z_]\w*)['\"]\s*\])", expr))
        names |= set(re.findall(r"os\.(?:environ(?:\.get)?\s*[\[(]\s*|getenv\s*\(\s*)['\"]([A-Za-z_]\w*)['\"]", expr))
        names |= set(re.findall(r"\$\{\{\s*(?:env|vars|inputs)\.([A-Za-z_][\w-]*)\s*\}\}", expr))
        flat = set()
        for n in names:
            if isinstance(n, tuple):
                flat |= {x for x in n if x}
            elif n:
                flat.add(n)
        return flat

    def has_unresolved(self, expr):
        """True if expr has a variable we cannot resolve to anything literal (fail-closed path)."""
        for name in set(re.findall(r"\$\{?([A-Za-z_]\w*)", expr)) | self.env_refs(expr):
            if name not in self.defs and name not in self.env_taint:
                return True
        for name in set(re.findall(r"(?<![\w$.'\"/:-])([A-Za-z_$][\w$]*)(?![\w$]*['\"])", expr)):
            if name not in self.defs and name not in self.env_taint and name not in (
                    "process", "env", "os", "environ", "new", "await", "URL", "String", "encodeURIComponent"):
                return True
        return False


def prod_hosts(text):
    return sorted({m.group(0).lower() for m in PROD_HOST_RE.finditer(text)})


def path_part(expr):
    """Everything in expr except host names (so 'meta'/'resend' in a host never counts as an inbound path)."""
    return re.sub(r"https?://[^/\s'\"`]+", " ", expr)


# ------------------------------------------------------------------ request extraction
def shell_logical(lines, idx):
    """Logical shell command starting at lines[idx] (backslash continuations joined)."""
    parts, j = [], idx
    while j < len(lines):
        ln = lines[j]
        parts.append(ln.rstrip("\\").rstrip())
        if not ln.rstrip().endswith("\\"):
            break
        j += 1
    return " ".join(parts)


def cut_shell(cmd):
    """Cut a command at the first unquoted |, ;, &&, || or closing ')' that ends a $(...)."""
    quote, depth, i = None, 0, 0
    while i < len(cmd):
        c = cmd[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif c == "(":
            depth += 1
        elif c == ")":
            if depth == 0:
                return cmd[:i]
            depth -= 1
        elif c in "|;&" and depth == 0:
            return cmd[:i]
        i += 1
    return cmd


def curl_method(cmd):
    m = re.search(r"(?:-X|--request)[\s=]*['\"]?([A-Za-z$]\w*|\$\{?\w+\}?)", cmd)
    if m:
        v = m.group(1)
        return v.upper() if re.fullmatch(r"[A-Za-z]+", v) else "UNKNOWN"
    if re.search(r"(?<![\w-])(?:-T|--upload-file)(?![\w-])", cmd):
        return "PUT"
    if re.search(r"(?<![\w-])(?:-I|--head)(?![\w-])", cmd):
        return "HEAD"
    if re.search(r"(?<![\w-])(?:-G|--get)(?![\w-])", cmd):
        return "GET"
    # -d (also combined short flags such as -sd), --data*, --json, -F/--form imply POST
    if re.search(r"(?<![\w-])(?:-[a-zA-Z]*[dF]|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|--form(?:-string)?)(?![\w-])", cmd):
        return "POST"
    return "GET"


def wget_method(cmd):
    m = re.search(r"--method[=\s]+['\"]?(\w+)", cmd)
    if m:
        return m.group(1).upper()
    if re.search(r"--(?:post|body)-(?:data|file)", cmd):
        return "POST"
    return "GET"


def curl_urls(cmd):
    """URL-bearing tokens of a curl/wget command (literal URLs and variable tokens), excluding header values."""
    no_headers = re.sub(r"(?:-H|--header)\s+(?:'[^']*'|\"[^\"]*\"|\S+)", " ", cmd)
    no_headers = re.sub(r"(?:-o|--output|-D|--dump-header|-w|--write-out|--max-time|-m|--connect-timeout|-u|--user|"
                        r"--data(?:-raw|-binary|-urlencode)?|-d|--json|-F|--form|-T|--upload-file|-X|--request)"
                        r"\s+(?:'[^']*'|\"[^\"]*\"|\S+)", " ", no_headers)
    toks = re.findall(r"https?://[^\s'\"\\)]+", no_headers)
    toks += re.findall(r"\$\{\{[^}]*\}\}[^\s'\"]*|\$\{?[A-Za-z_]\w*\}?[^\s'\"]*", no_headers)
    return toks


def curl_headers(cmd):
    return " ".join(re.findall(r"(?:-H|--header)\s+('[^']*'|\"[^\"]*\"|\S+)", cmd))


def find_requests(text):
    """-> list of dicts {line, kind, method, url_expr, opts} for every network request in text."""
    reqs, lines = [], text.split("\n")
    # shell: curl / wget / httpie
    for idx, ln in enumerate(lines):
        if is_comment_line(ln):
            continue
        for tool, rx in (("curl", r"(?<![\w.-])curl(?![\w.-])"), ("wget", r"(?<![\w.-])wget(?![\w.-])"),
                         ("httpie", r"(?<![\w.-])https?\s+(?:--\S+\s+)*(POST|PUT|PATCH|DELETE)\s")):
            for m in re.finditer(rx, ln):
                logical = shell_logical(lines, idx)
                start = logical.find(m.group(0))
                cmd = cut_shell(logical[start:]) if start >= 0 else logical
                if tool == "curl":
                    method = curl_method(cmd)
                elif tool == "wget":
                    method = wget_method(cmd)
                else:
                    method = m.group(1).upper()
                reqs.append({"line": idx + 1, "kind": tool, "method": method,
                             "url_expr": " ".join(curl_urls(cmd)) if tool != "httpie" else cmd,
                             "opts": curl_headers(cmd) if tool != "httpie" else cmd, "raw": cmd})
    # JS fetch (not obj.fetch), http(s).request
    for m in re.finditer(r"(?:(?<![\w.$])|(?<=globalThis\.)|(?<=window\.)|(?<=self\.))fetch\s*\(", text):
        if is_comment_line(text[text.rfind("\n", 0, m.start()) + 1:m.start() + 1]):
            continue
        inner = balanced(text, m.end() - 1)
        after = text[m.end() + len(inner) + 1:m.end() + len(inner) + 40].lstrip()
        if after.startswith("{") or after.startswith("=>") or re.search(r"(?:async|function)\s+$", text[max(0, m.start() - 12):m.start()]):
            continue  # a method/function definition named fetch, not a call
        args = split_top(inner)
        if not args:
            continue
        url, opts = args[0], ",".join(args[1:])
        me = re.search(r"\bmethod\s*:\s*([A-Za-z_$][\w$.]*)", opts)
        reqs.append({"line": line_of(text, m.start()), "kind": "fetch", "method": js_method(opts, url),
                     "url_expr": url, "opts": opts, "raw": "fetch(" + ",".join(args)[:400],
                     "method_expr": me.group(1) if me else (url.strip() if not opts.strip() else None)})
    for m in re.finditer(r"(?<![\w$])(?:https?|http2)\s*\.\s*request\s*\(", text):
        args = split_top(balanced(text, m.end() - 1))
        body = ",".join(args)
        host = re.search(r"\b(?:hostname|host)\s*:\s*([^,}]+)", body)
        url = args[0] if args and not args[0].lstrip().startswith("{") else (host.group(1) if host else "")
        reqs.append({"line": line_of(text, m.start()), "kind": "node-http", "method": js_method(body, ""),
                     "url_expr": url, "opts": body, "raw": body[:400]})
    # Python requests / httpx / sessions
    for m in re.finditer(r"(?<![\w])(?:requests|httpx|session|sess|s|client|http)\s*\.\s*(post|put|patch|delete|get|head|"
                         r"request)\s*\(", text):
        args = split_top(balanced(text, m.end() - 1))
        verb, method_expr = m.group(1).upper(), None
        if verb == "REQUEST":
            lit = [a.strip().strip("'\"").upper() for a in args[:2]]
            if lit and lit[0] in HTTP_VERBS:          # requests.request("POST", url, ...)
                verb, args = lit[0], args[1:]
            elif len(lit) > 1 and lit[1] in HTTP_VERBS:  # client.request(url, "POST", ...)
                verb = lit[1]
            else:
                kw = re.search(r"\bmethod\s*=\s*([^,]+)", ",".join(args))
                verb = "UNKNOWN"
                if kw and kw.group(1).strip().strip("'\"").upper() in HTTP_VERBS:
                    verb = kw.group(1).strip().strip("'\"").upper()
                elif len(args) > 1 and re.fullmatch(r"\s*[A-Za-z_]\w*\s*", args[1]):
                    method_expr = args[1].strip()
                elif kw:
                    method_expr = kw.group(1).strip()
                elif len(args) == 1:
                    verb = "GET"
        url = args[0] if args else ""
        reqs.append({"line": line_of(text, m.start()), "kind": "python-http", "method": verb, "url_expr": url,
                     "opts": ",".join(args[1:]), "raw": ",".join(args)[:400], "method_expr": method_expr})
    # Python urllib.request.Request(...) (JS `new Request` is not a request by itself)
    for m in re.finditer(r"(?<![\w$.])(?:urllib\.request\.|request\.)?Request\s*\(", text):
        if re.search(r"new\s+$", text[max(0, m.start() - 8):m.start()]):
            continue
        args = split_top(balanced(text, m.end() - 1))
        if not args:
            continue
        body = ",".join(args[1:])
        mm = re.search(r"method\s*=\s*['\"](\w+)['\"]", body)
        method_expr = None
        if mm:
            method = mm.group(1).upper()
        elif re.search(r"method\s*=", body):
            method = "UNKNOWN"
            me = re.search(r"method\s*=\s*([A-Za-z_][\w.]*)", body)
            method_expr = me.group(1) if me else None
        elif re.search(r"(?:^|,)\s*data\s*=", body) or (len(args) > 1 and "=" not in args[1].split("(")[0]):
            method = "POST"
        else:
            method = "GET"
        reqs.append({"line": line_of(text, m.start()), "kind": "urllib", "method": method, "url_expr": args[0],
                     "opts": body, "raw": ",".join(args)[:400], "method_expr": method_expr})
    starts = [0]
    for ln in lines:
        starts.append(starts[-1] + len(ln) + 1)
    for r in reqs:
        r["pos"] = starts[r["line"] - 1]
    return reqs


def js_method(opts, url):
    m = re.search(r"\bmethod\s*:\s*['\"`](\w+)['\"`]", opts)
    if m:
        return m.group(1).upper()
    if re.search(r"\bmethod\s*:", opts) or re.search(r"\bmethod\s*[,}]", opts):
        return "UNKNOWN"
    if not opts.strip() and re.fullmatch(r"\s*[A-Za-z_$][\w$]*\s*", url or ""):
        return "DEFER"  # fetch(req): resolved through `new Request(...)` below
    if re.fullmatch(r"\s*[A-Za-z_$][\w$]*\s*", opts or "") and opts.strip():
        return "DEFER_OPTS"
    return "GET"


def resolve_deferred(req, text, resolver):
    """fetch(req) / fetch(url, opts) where req or opts are identifiers: look at their governing definitions."""
    if req["method"] == "DEFER":
        d = resolver.lookup(req["url_expr"].strip(), req["pos"])
        mm = re.search(r"new\s+Request\s*\(", text[d[0]:d[0] + 600]) if d else None
        if mm:
            args = split_top(balanced(text, d[0] + mm.end() - 1))
            if args:
                req["url_expr"], req["opts"], req["pos"] = args[0], ",".join(args[1:]), d[0]
                req["method"] = js_method(req["opts"], args[0])
        if req["method"].startswith("DEFER"):
            req["method"] = "UNKNOWN"
    if req["method"] == "DEFER_OPTS":
        d = resolver.lookup(req["opts"].strip(), req["pos"])
        expanded = definition_text(text, d) if d else ""
        req["opts"] = expanded or req["opts"]
        req["method"] = js_method(expanded, "") if expanded else "UNKNOWN"
        if req["method"].startswith("DEFER") or not expanded:
            req["method"] = "UNKNOWN"
    return req


def definition_text(text, d):
    """Full text of a definition starting at d=(pos, one-line value): a balanced {...} literal when it opens one."""
    pos, value = d
    if value.lstrip().startswith("{"):
        brace = text.find("{", pos)
        depth, i = 0, brace
        while 0 <= i < len(text):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    return text[brace:i + 1]
            i += 1
    return value


# ------------------------------------------------------------------ wrapper functions (indirection inside one file)
FUNC_DEF_RES = [
    ("py", re.compile(r"^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(", re.M)),
    ("js", re.compile(r"(?:^|[^\w$.])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(", re.M)),
    ("js", re.compile(r"(?:\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(", re.M)),
    ("js", re.compile(r"(?:\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>", re.M)),
]


def parse_params(ptext):
    """[(name, default_or_None)] of a Python/JS parameter list (self/cls kept; destructuring ignored)."""
    out = []
    for p in split_top(ptext):
        p = p.strip()
        if not p or p in ("/", "*") or p.startswith("**") or p.startswith("...") or p[0] in "{[":
            continue
        p = p.lstrip("*")
        name = re.match(r"[A-Za-z_$][\w$]*", p)
        if not name:
            continue
        d = re.search(r"=\s*(.+)$", p)
        out.append((name.group(0), d.group(1).strip() if d else None))
    return out


def function_defs(text):
    """-> [{name, params, start, end}] for Python defs (indent-delimited) and JS functions/arrows (brace-delimited)."""
    defs = []
    for lang, rx in FUNC_DEF_RES:
        for m in rx.finditer(text):
            name = m.group(2) if lang == "py" else m.group(1)
            if rx.groups == 2 and lang == "js":  # const f = async x => ...
                params, after = [(m.group(2), None)], m.end()
            else:
                op = text.find("(", m.end() - 1)
                inner = balanced(text, op)
                params, after = parse_params(inner), op + len(inner) + 2
            if lang == "py":
                ind = len(m.group(1).expandtabs())
                nl = text.find("\n", after)
                end = len(text)
                for lm in re.finditer(r"^([ \t]*)\S", text[nl + 1:] if nl >= 0 else "", re.M):
                    if len(lm.group(1).expandtabs()) <= ind:
                        end = nl + 1 + lm.start()
                        break
            else:
                rest = text[after:after + 200]
                br = re.match(r"\s*(?:=>\s*)?\{", rest)
                if br:
                    bpos = after + br.end() - 1
                    depth, i, end = 0, bpos, len(text)
                    while i < len(text):
                        if text[i] == "{":
                            depth += 1
                        elif text[i] == "}":
                            depth -= 1
                            if depth == 0:
                                end = i + 1
                                break
                        i += 1
                else:
                    nl = text.find("\n", after)
                    end = nl if nl >= 0 else len(text)
            defs.append({"name": name, "params": params, "start": m.start(), "end": end, "lang": lang})
    return defs


def bind_args(params, args, method_call):
    """{param: argument text} for a call; drops self/cls for obj.method(...) calls."""
    ps = list(params)
    if method_call and ps and ps[0][0] in ("self", "cls"):
        ps = ps[1:]
    bound, pos_i = {}, 0
    for a in args:
        kw = re.match(r"\s*([A-Za-z_]\w*)\s*=(?!=)\s*(.*)$", a, re.S)
        if kw and any(kw.group(1) == p for p, _ in ps):
            bound[kw.group(1)] = kw.group(2).strip()
        elif pos_i < len(ps):
            bound[ps[pos_i][0]] = a.strip()
            pos_i += 1
    for p, d in ps:
        bound.setdefault(p, d if d is not None else "")
    return bound


def synthesize_wrappers(text, reqs, resolver, rounds=4):
    """Calls of local helper functions whose body makes a request with a parameter-fed URL become requests at the
    call site (url = helper URL expression with the argument bound; method = bound argument or default)."""
    defs = function_defs(text)
    wrapped = set()
    work, out = list(reqs), []
    for _ in range(rounds):
        new = []
        for r in work:
            owner = min((d for d in defs if d["start"] < r["pos"] < d["end"]), key=lambda d: d["end"] - d["start"],
                        default=None)
            if not owner:
                continue
            names = [p for p, _ in owner["params"] if p not in ("self", "cls")]
            inner = resolver.expand(r["url_expr"], r["pos"], seen=set(names))
            url_params = [p for p in names if re.search(r"(?<![\w$])" + re.escape(p) + r"(?![\w$])", inner)]
            mexpr = (r.get("method_expr") or "").split(".")[-1]
            method_param = mexpr if mexpr in names else None
            opt_params = [p for p in names if re.search(r"(?<![\w$])" + re.escape(p) + r"(?![\w$])", r["opts"])]
            if not url_params and not method_param:
                continue
            call_rx = re.compile(r"(?<![\w$])(?:([\w$]+)\s*\.\s*)?" + re.escape(owner["name"]) + r"\s*\(")
            for cm in call_rx.finditer(text):
                pre = text[max(0, cm.start() - 12):cm.start()]
                if re.search(r"(?:def|function)\s*$", pre) or (owner["start"] <= cm.start() < owner["start"] + 200
                                                                 and text.find("(", cm.start()) == text.find("(", owner["start"])):
                    continue
                args = split_top(balanced(text, cm.end() - 1))
                bound = bind_args(owner["params"], args, bool(cm.group(1)))
                url_args = " ".join(bound.get(p, "") for p in url_params)
                if method_param:
                    lit = bound.get(method_param, "").strip().strip("'\"`").upper()
                    if lit in HTTP_VERBS:
                        method, mx = lit, None
                    else:
                        method, mx = ("UNKNOWN", bound.get(method_param, "").strip() or None)
                        if not mx:
                            method = "GET"
                else:
                    method, mx = r["method"], r.get("method_expr")
                syn = {"line": line_of(text, cm.start()), "pos": cm.start(), "kind": r["kind"] + "+wrapper:" + owner["name"],
                       "method": method, "method_expr": mx, "url_expr": inner + " " + url_args,
                       "opts": r["opts"] + " " + " ".join(bound.get(p, "") for p in opt_params) + " " + ",".join(args),
                       "raw": owner["name"] + "(" + ",".join(args)[:400] + ")", "synthetic": True}
                key = (syn["line"], syn["kind"])
                if any((x["line"], x["kind"]) == key for x in out + new):
                    continue
                new.append(syn)
                wrapped.add(id(r))
        out += new
        work = new
        if not new:
            break
    return out, wrapped


# ------------------------------------------------------------------ file analysis
def analyze_text(rel, text, env_taint=(), context_hosts=()):
    """-> list of hit dicts for one file."""
    resolver = Resolver(text, env_taint)
    lines = text.split("\n")
    hmac_lines = [line_of(text, m.start()) for m in HMAC_RE.finditer(text)
                  if not is_comment_line(lines[line_of(text, m.start()) - 1])]
    file_names_prod = bool(prod_hosts(text)) or bool(context_hosts)
    hits = []
    base_reqs = [resolve_deferred(r, text, resolver) for r in find_requests(text)]
    synthetic, wrapped = synthesize_wrappers(text, base_reqs, resolver)
    for req in base_reqs + synthetic:
        if id(req) in wrapped:
            continue  # a helper's own request: judged at each call site, where the arguments are bound
        method = req["method"]
        if method not in MUTATING:
            continue
        url_full = resolver.expand(req["url_expr"], req["pos"])
        hosts = prod_hosts(url_full)
        opts_names = set(re.findall(r"(?<![\w$.'\"-])([A-Za-z_$][\w$]*)(?![\w$]*\s*:)", req["opts"])) - Resolver.SKIP
        opts_defs = [resolver.lookup(n, req["pos"]) for n in sorted(opts_names)]
        opts_full = req["opts"] + " " + " ".join(definition_text(text, d) for d in opts_defs if d)
        signed = sorted({s.lower() for s in SIG_HEADER_RE.findall(opts_full + " " + req.get("raw", ""))})
        near_hmac = [h for h in hmac_lines if abs(h - req["line"]) <= HMAC_WINDOW]
        inbound = sorted({s.lower() for s in INBOUND_RE.findall(path_part(url_full))})
        base = {"file": rel, "line": req["line"], "method": method, "kind": req["kind"],
                "text": lines[req["line"] - 1].strip()[:240], "line_text": lines[req["line"] - 1], "hosts": hosts,
                "url_path": path_part(url_full)[:2000]}
        if hosts:
            if inbound:
                hits.append({**base, "rule": "R4-INBOUND", "evidence": "path:" + ",".join(inbound)})
            if signed:
                hits.append({**base, "rule": "R4-SIGNED", "evidence": "header:" + ",".join(signed)})
            if near_hmac:
                hits.append({**base, "rule": "R4-HMAC", "evidence": "hmac_at_line:" + ",".join(map(str, near_hmac[:5]))})
        elif (signed or near_hmac) and file_names_prod and not req.get("synthetic") \
                and resolver.has_unresolved(req["url_expr"]):
            ev = ("header:" + ",".join(signed)) if signed else ("hmac_at_line:" + ",".join(map(str, near_hmac[:5])))
            hits.append({**base, "rule": "R4-UNRESOLVED", "evidence": ev + ";target_unresolved"})
    return hits


def run_blocks(text):
    """Lines (1-based) inside run:/script: blocks of a workflow."""
    out, lines = set(), text.split("\n")
    i = 0
    while i < len(lines):
        m = re.match(r"^(\s*)(?:-\s+)?['\"]?(run|script)['\"]?\s*:\s*(.*)$", lines[i])
        if m:
            ind = len(m.group(1))
            rest = m.group(3).strip()
            if rest and not re.match(r"^[|>][-+]?\d*\s*(#.*)?$", rest):
                out.add(i + 1)
                i += 1
                continue
            j = i + 1
            while j < len(lines) and (not lines[j].strip() or len(lines[j]) - len(lines[j].lstrip()) > ind):
                out.add(j + 1)
                j += 1
            i = j
            continue
        i += 1
    return out


SCRIPT_EXEC_RES = [
    # JS/TS module graph: static, dynamic and CommonJS imports (relative specifiers only)
    re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"`](\.{1,2}/[^'"`]+)['"`]"""),
    # shell / spawn / subprocess: an interpreter followed by a script path
    re.compile(r"""(?:\bnode|\bpython3?|\bbash|\bsh|\bsource|sys\.executable|process\.execPath|\bdeno\s+run|\btsx|\bnpx\s+tsx)"""
               r"""['"`]?\s*,?\s*(?:\[\s*)?(?:['"`]?--?[\w-]+['"`]?\s*,?\s*)*['"`]?((?:\.{0,2}/)?[\w./-]+\.(?:py|mjs|cjs|js|sh|ts))\b"""),
    # a script executed directly by path (./x.sh, scripts/x.sh at the start of a command)
    re.compile(r"(?:^|[;&|]\s*|\$\(\s*)\s*((?:\./|scripts/)[\w./-]+\.(?:sh|py|mjs))\b", re.M),
]


def _resolve_path(tok, root, base_dir, is_workflow):
    cands = (root / tok,) if is_workflow else (base_dir / tok, root / tok)
    for cand in cands:
        try:
            cand = cand.resolve()
            r = cand.relative_to(root.resolve())
        except (ValueError, OSError):
            continue
        if cand.is_file() and cand.suffix in SCRIPT_EXT and r.parts[:1] != (".github",):
            return r.as_posix()
        if not cand.suffix and not is_workflow:
            for ext in (".mjs", ".js", ".cjs", ".ts"):
                c2 = cand.with_name(cand.name + ext)
                if c2.is_file():
                    return c2.relative_to(root.resolve()).as_posix()
    return None


def executed_paths(rel, text, root, is_workflow):
    """Repo scripts this file EXECUTES or imports (existing files only).

    Workflows: every repo script path named in a run:/script: block, unless the command segment naming it only
    syntax-checks or reads it (node --check, py_compile, cat, grep, sha256sum, git diff, ...).
    Scripts: only execution references (interpreter + path, ./x.sh) and module imports (JS relative imports, Python
    sibling modules). A path that a script merely reads as data (open('worker/x.mjs')) is not an execution."""
    lines = text.split("\n")
    found, base_dir = set(), (root / rel).parent
    if is_workflow:
        for no in sorted(run_blocks(text)):
            ln = lines[no - 1]
            if is_comment_line(ln):
                continue
            for m in PATH_TOKEN_RE.finditer(ln):
                cmd = re.split(r"&&|\|\||;|\|", ln[:m.start()])[-1]
                if NOT_EXECUTED_RE.search(cmd + " "):
                    continue
                r = _resolve_path(m.group(1), root, base_dir, True)
                if r:
                    found.add(r)
            for m in SCRIPT_EXEC_RES[0].finditer(ln):  # heredoc JS importing repo modules
                r = _resolve_path(m.group(1), root, base_dir, True)
                if r:
                    found.add(r)
    else:
        for ln in lines:
            if is_comment_line(ln) or NOT_EXECUTED_RE.search(ln) and not SCRIPT_EXEC_RES[0].search(ln):
                continue
            for rx in SCRIPT_EXEC_RES:
                for m in rx.finditer(ln):
                    r = _resolve_path(m.group(1), root, base_dir, False)
                    if r:
                        found.add(r)
        if rel.endswith(".py"):
            for m in PY_IMPORT_RE.finditer(text):
                mod = (m.group(1) or m.group(2) or "").split(".")[0]
                cand = base_dir / (mod + ".py")
                if mod and cand.is_file():
                    found.add(cand.resolve().relative_to(root.resolve()).as_posix())
    found.discard(rel)
    return {f for f in found if not RUNTIME_SOURCE_RE.match(f)}


def workflow_env_taint(text):
    """Env/variable names a workflow sets to a production URL (YAML env keys and shell assignments)."""
    names = set()
    for m in re.finditer(r"^[ \t]*(?:export[ \t]+)?['\"]?([A-Za-z_][\w]*)['\"]?[ \t]*[:=][ \t]*['\"]?([^\n'\"]*)", text, re.M):
        if PROD_HOST_RE.search(m.group(2)):
            names.add(m.group(1))
    return names


def scan(root, depth=3):
    root = Path(root)
    wf_dir = root / ".github" / "workflows"
    wfs = sorted([p for p in wf_dir.glob("*.y*ml") if p.suffix in (".yml", ".yaml")]) if wf_dir.is_dir() else []
    if not wfs:
        raise ScanError(f"no workflows found under {wf_dir}")
    hits, scanned, chains = [], {}, {}
    queue = []
    for wf in wfs:
        rel = wf.relative_to(root).as_posix()
        try:
            text = wf.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            raise ScanError(f"cannot read {rel}: {e}") from None
        taint = workflow_env_taint(text)
        scanned[rel] = "workflow"
        hits += analyze_text(rel, text)
        for p in executed_paths(rel, text, root, True):
            queue.append((p, 1, rel, taint, prod_hosts(text)))
    seen_ctx = {}
    while queue:
        rel, lvl, parent, taint, ctx_hosts = queue.pop(0)
        key = rel
        prev = seen_ctx.get(key)
        merged_taint = set(taint) | (prev[0] if prev else set())
        merged_hosts = set(ctx_hosts) | (prev[1] if prev else set())
        if prev and merged_taint == prev[0] and merged_hosts == prev[1]:
            chains.setdefault(rel, set()).add(parent)
            continue
        seen_ctx[key] = (merged_taint, merged_hosts)
        chains.setdefault(rel, set()).add(parent)
        try:
            text = (root / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            raise ScanError(f"cannot read invoked script {rel}: {e}") from None
        scanned[rel] = f"script(level {lvl})"
        hits = [h for h in hits if h["file"] != rel]
        hits += analyze_text(rel, text, merged_taint, merged_hosts)
        if lvl < depth:
            for p in executed_paths(rel, text, root, False):
                queue.append((p, lvl + 1, rel, merged_taint | workflow_env_taint(text), merged_hosts))
    for h in hits:
        if h["file"] in chains:
            h["invoked_by"] = sorted(chains[h["file"]])
    uniq, seen = [], set()
    for h in sorted(hits, key=lambda h: (h["file"], h["line"], h["rule"])):
        k = (h["file"], h["line"], h["rule"])
        if k not in seen:
            seen.add(k)
            uniq.append(h)
    return uniq, scanned


def _need(cond, msg):
    if not cond:
        raise ScanError(msg)


def _text(v, n=1):
    return isinstance(v, str) and len(v.strip()) >= n


def _evidence_ok(root, ref):
    m = re.fullmatch(r"([\w./-]+):(\d+)(?:-(\d+))?", str(ref))
    if not m:
        return False
    p = Path(root) / m.group(1)
    if not p.is_file():
        return False
    n = len(p.read_text(encoding="utf-8", errors="replace").split("\n"))
    return int(m.group(2)) <= n and int(m.group(3) or m.group(2)) <= n


def _test_ok(root, ref):
    m = re.fullmatch(r"([\w./-]+\.py)::(test_\w+)", str(ref))
    if not m or not (Path(root) / m.group(1)).is_file():
        return False
    return re.search(r"def " + re.escape(m.group(2)) + r"\(", (Path(root) / m.group(1)).read_text(encoding="utf-8")) is not None


def _acceptance(e, where, allowed_status):
    ra = e.get("risk_acceptance")
    _need(isinstance(ra, dict) and set(ra) == ACCEPTANCE_KEYS, f"{where}: risk_acceptance must have exactly {sorted(ACCEPTANCE_KEYS)}")
    _need(ra["status"] in allowed_status, f"{where}: risk_acceptance.status must be one of {sorted(allowed_status)}")
    if ra["status"] == "ACCEPTED":
        _need(all(_text(ra[k], 3) for k in ("by", "at", "reference")), f"{where}: an ACCEPTED risk needs by/at/reference")


def validate_allowed(e, root, i):
    w = f"allowed[{i}]"
    _need(isinstance(e, dict), f"{w}: must be an object")
    missing, unknown = ALLOW_REQUIRED - set(e), set(e) - ALLOW_REQUIRED - ALLOW_OPTIONAL
    _need(not missing, f"{w}: missing required fields {sorted(missing)}")
    _need(not unknown, f"{w}: unknown fields {sorted(unknown)}")
    _need(_text(e["file"]) and _text(e["line_pattern"]), f"{w}: file and line_pattern required")
    try:
        re.compile(e["line_pattern"])
    except re.error as err:
        raise ScanError(f"{w}: line_pattern invalid: {err}") from None
    _need(_text(e["endpoint"]) and e["endpoint"].startswith("/"), f"{w}: endpoint must be a registered path")
    _need(e["method"] in ("POST", "PUT", "PATCH", "DELETE"), f"{w}: method must be an explicit mutating verb")
    idn = e["identity"]
    _need(isinstance(idn, dict) and set(idn) == {"principal", "credential", "impersonates"} and idn["principal"] == "ZEVANORY"
          and _text(idn["credential"], 3) and idn["impersonates"] == [],
          f"{w}: identity must be ZEVANORY's own (principal ZEVANORY, credential named, impersonates [])")
    _need(_text(e["purpose"], 40), f"{w}: purpose must be concrete (>= 40 chars)")
    _need(_text(e["least_privilege"], 40), f"{w}: least_privilege must be concrete (>= 40 chars)")
    eff = e["effects"]
    _need(isinstance(eff, dict) and set(eff) == EFFECT_KEYS and all(v is False for v in eff.values()),
          f"{w}: effects must list {sorted(EFFECT_KEYS)}, all false")
    ds = e["data_scope"]
    _need(isinstance(ds, dict) and set(ds) == DATA_SCOPE_KEYS and all(v is False for v in ds.values()),
          f"{w}: data_scope must list {sorted(DATA_SCOPE_KEYS)}, all false")
    pl = e["payload"]
    _need(isinstance(pl, dict) and set(pl) == PAYLOAD_KEYS, f"{w}: payload must have exactly {sorted(PAYLOAD_KEYS)}")
    _need(pl["controlled"] is True and isinstance(pl["writes"], bool) and isinstance(pl["idempotent"], bool)
          and pl["secrets_in_audit"] is False and _text(pl["audit_trail"], 20),
          f"{w}: payload must be controlled, with an audit trail free of secrets")
    _need(not pl["writes"] or pl["idempotent"] is True, f"{w}: a writing call must be idempotent")
    ev = e["handler_evidence"]
    _need(isinstance(ev, list) and ev and all(_evidence_ok(root, x) for x in ev),
          f"{w}: handler_evidence must list existing file:line references")
    _need(_test_ok(root, e["counter_proof_test"]), f"{w}: counter_proof_test must name an existing test (file.py::test_x)")
    _acceptance(e, w, {"PENDING_OWNER", "ACCEPTED"})


def validate_open(e, root, i):
    w = f"open_real_risks[{i}]"
    _need(isinstance(e, dict) and set(e) == OPEN_REQUIRED, f"{w}: must have exactly {sorted(OPEN_REQUIRED)}")
    try:
        re.compile(e["line_pattern"])
    except re.error as err:
        raise ScanError(f"{w}: line_pattern invalid: {err}") from None
    _need(e["classification"] == "REAL_RISK" and e["status"] == "OPEN_NOT_HOMOLOGATED",
          f"{w}: classification REAL_RISK and status OPEN_NOT_HOMOLOGATED required")
    _need(_text(e["reason"], 40) and _text(e["required_fix"], 20), f"{w}: reason and required_fix must be concrete")
    _need(isinstance(e["evidence"], list) and e["evidence"] and all(_text(x, 5) for x in e["evidence"]),
          f"{w}: evidence must be a non-empty list")
    ic = e["independent_control"]
    _need(isinstance(ic, dict) and ic.get("type") in ("owner-approval-gate", "pending-fix-pr"), f"{w}: independent_control type")
    if ic["type"] == "owner-approval-gate":
        _need(set(ic) == {"type", "variable", "workflows"} and _text(ic["variable"], 3) and isinstance(ic["workflows"], list)
              and ic["workflows"], f"{w}: owner-approval-gate needs variable and workflows")
    else:
        _need(set(ic) == {"type", "pr", "until"} and _text(ic["pr"], 2) and _text(ic["until"], 10), f"{w}: pending-fix-pr needs pr and until")
    _acceptance(e, w, {"NOT_ACCEPTED"})


def validate_gate(g, i):
    w = f"financial_gates[{i}]"
    _need(isinstance(g, dict) and set(g) == GATE_REQUIRED, f"{w}: must have exactly {sorted(GATE_REQUIRED)}")
    _need(g["status"] in ("ENFORCED", "PENDING_FIX_PR") and isinstance(g["require_job_if_false"], bool)
          and _text(g["variable"], 3) and _text(g["reference"], 3), f"{w}: status/variable/reference invalid")


def load_allow(path, root="."):
    p = Path(path)
    if not p.exists():
        raise ScanError(f"allow-list {path} missing (it must exist, even if empty)")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ScanError(f"allow-list {path} unreadable: {e}") from None
    _need(isinstance(data, dict) and set(data) == {"schema", "allowed", "open_real_risks", "financial_gates"}
          and data["schema"] == "r4-allow/v2", "allow-list must be {schema: r4-allow/v2, allowed, open_real_risks, financial_gates}")
    for k in ("allowed", "open_real_risks", "financial_gates"):
        _need(isinstance(data[k], list), f"{k} must be a list")
    for i, e in enumerate(data["allowed"]):
        validate_allowed(e, root, i)
    for i, e in enumerate(data["open_real_risks"]):
        validate_open(e, root, i)
    for i, g in enumerate(data["financial_gates"]):
        validate_gate(g, i)
    return data


def job_blocks(text):
    """{job_id: job text} for a block-style workflow (jobs at 2-space indent)."""
    lines, out, cur, in_jobs = text.split("\n"), {}, None, False
    for ln in lines:
        if re.match(r"^jobs:\s*$", ln):
            in_jobs = True
            continue
        if in_jobs and re.match(r"^\S", ln):
            in_jobs, cur = False, None
        if not in_jobs:
            continue
        m = re.match(r"^  ([\w-]+):\s*$", ln)
        if m:
            cur = m.group(1)
            out[cur] = []
            continue
        if cur:
            out[cur].append(ln)
    return {k: "\n".join(v) for k, v in out.items()}


def first_step(job_text):
    lines, start = job_text.split("\n"), None
    for i, ln in enumerate(lines):
        if re.match(r"^    steps:\s*$", ln):
            start = i + 1
            break
    if start is None:
        return ""
    block, seen = [], False
    for ln in lines[start:]:
        if re.match(r"^      - ", ln):
            if seen:
                break
            seen = True
        elif ln.strip() and len(ln) - len(ln.lstrip()) <= 4:
            break
        if seen:
            block.append(ln)
    return "\n".join(block)


def gate_problems(root, workflow, variable, require_if_false=False):
    """Why the workflow does NOT carry the owner-approval gate as the first step of every job ([] if it does)."""
    p = Path(root) / workflow
    if not p.is_file():
        return [f"{workflow}: missing"]
    jobs, probs = job_blocks(p.read_text(encoding="utf-8")), []
    if not jobs:
        return [f"{workflow}: no jobs found"]
    for jid, jt in jobs.items():
        st = first_step(jt)
        if not (GATE_STEP_NAME in st and ("vars." + variable) in st and re.search(r"\bexit 1\b", st)):
            probs.append(f"{workflow}:{jid}: first step is not the R4 owner approval gate on vars.{variable}")
        if require_if_false and not re.search(r"^    if:\s*\$\{\{\s*false\s*\}\}", jt, re.M):
            probs.append(f"{workflow}:{jid}: job must stay 'if: ${{{{ false }}}}'")
    return probs


def apply_allow(hits, allow, root="."):
    """-> (remaining hits, gate hits, open-risk hits). Raises ScanError on stale entries."""
    allowed, opened = allow["allowed"], allow["open_real_risks"]
    used_a, used_o, remaining, open_hits = set(), set(), [], []
    for h in hits:
        line = h.get("line_text", h["text"])
        ai = next((i for i, e in enumerate(allowed)
                   if e["file"] == h["file"] and re.search(e["line_pattern"], line)
                   and h["rule"] in ALLOWABLE_RULES and h["method"] == e["method"]
                   and e["endpoint"] in h.get("url_path", "")), None)
        if ai is not None:
            used_a.add(ai)
            h["allowed"] = {"endpoint": allowed[ai]["endpoint"], "acceptance": allowed[ai]["risk_acceptance"]["status"]}
            continue
        oi = next((i for i, e in enumerate(opened) if e["file"] == h["file"] and re.search(e["line_pattern"], line)), None)
        if oi is not None:
            used_o.add(oi)
            h["open_risk"] = opened[oi]["independent_control"]["type"]
            open_hits.append(h)
            continue
        remaining.append(h)
    stale = [allowed[i] for i in range(len(allowed)) if i not in used_a]
    stale += [opened[i] for i in range(len(opened)) if i not in used_o]
    if stale:
        raise ScanError("stale allow-list entries (match no current hit): " + json.dumps(
            [{"file": e["file"], "line_pattern": e["line_pattern"]} for e in stale], ensure_ascii=False))
    gates = []
    # open risks controlled by an owner-approval gate: every workflow that can run the hit must carry the gate
    for e in opened:
        ic = e["independent_control"]
        if ic["type"] != "owner-approval-gate":
            continue
        for h in open_hits:
            if h["file"] != e["file"]:
                continue
            runners = [h["file"]] if h["file"].startswith(".github/workflows/") else h.get("invoked_by", [])
            for wf in runners:
                if wf not in ic["workflows"]:
                    gates.append(_gate_hit(wf, f"open risk {e['file']} runs from {wf}, which is not in its gated workflows"))
        for wf in ic["workflows"]:
            for prob in gate_problems(root, wf, ic["variable"]):
                gates.append(_gate_hit(wf, prob))
    # independent financial gates (Sol R4 2d): required set, enforced or explicitly pending a fix PR
    listed = {g["workflow"]: g for g in allow["financial_gates"]}
    for wf in sorted(REQUIRED_GATE_WORKFLOWS - set(listed)):
        if (Path(root) / wf).exists():  # a deleted workflow cannot run; an existing one must be gated
            gates.append(_gate_hit(wf, "required financial gate not registered"))
    for wf, g in listed.items():
        probs = gate_problems(root, wf, g["variable"], g["require_job_if_false"])
        if g["status"] == "ENFORCED":
            gates += [_gate_hit(wf, prob) for prob in probs]
        elif not probs:
            gates.append(_gate_hit(wf, "gate is now present: mark it ENFORCED (stale PENDING_FIX_PR)"))
    return remaining, gates, open_hits


def _gate_hit(wf, why):
    return {"file": wf, "line": 0, "rule": "R4-GATE", "method": "-", "hosts": [], "evidence": why, "text": why}


def main(argv=None):
    ap = argparse.ArgumentParser(description="R4 guard: no forged/signed input to production hosts from workflows.")
    ap.add_argument("--root", default=".")
    ap.add_argument("--allow", default=None, help=f"allow-list JSON (default <root>/{DEFAULT_ALLOW})")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--depth", type=int, default=3)
    args = ap.parse_args(argv)
    try:
        if args.depth < 1:
            raise ScanError("--depth must be >= 1")
        root = Path(args.root)
        allow = load_allow(args.allow or (root / DEFAULT_ALLOW), root)
        hits, scanned = scan(root, args.depth)
        remaining, gates, open_hits = apply_allow(hits, allow, root)
        remaining = remaining + gates
    except ScanError as e:
        print(f"R4_FORGED_INPUT_SCAN_ERROR {e}", file=sys.stderr)
        return 2
    n_wf = sum(1 for v in scanned.values() if v == "workflow")
    if args.json:
        for h in hits:
            h.pop("line_text", None)
        print(json.dumps({"scanned_workflows": n_wf, "scanned_scripts": len(scanned) - n_wf, "hits": remaining,
                          "allowed": [h for h in hits if "allowed" in h], "open_real_risks": open_hits},
                         ensure_ascii=False, indent=1))
    out = sys.stderr if args.json else sys.stdout
    for h in open_hits:
        print(f"R4_OPEN_RISK {h['file']}:{h['line']} {h['rule']} control={h['open_risk']} (REAL RISK, not accepted)", file=out)
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::warning title=R4_OPEN_RISK::{h['file']}:{h['line']} {h['rule']} control={h['open_risk']}", file=out)
    for h in remaining:
        via = f" via {','.join(h['invoked_by'])}" if h.get("invoked_by") else ""
        print(f"R4_HIT {h['file']}:{h['line']} {h['rule']} {h['method']} {','.join(h['hosts']) or '?'} "
              f"{h['evidence']}{via} :: {h['text'][:160]}", file=sys.stderr if args.json else sys.stdout)
    verdict = "FAIL" if remaining else "PASS"
    n_allowed = sum(1 for h in hits if "allowed" in h)
    print(f"R4_FORGED_INPUT_SCAN {verdict} workflows={n_wf} scripts={len(scanned) - n_wf} hits={len(remaining)} "
          f"allowed={n_allowed} open_real_risks={len(open_hits)}", file=sys.stderr if args.json else sys.stdout)
    return 1 if remaining else 0


if __name__ == "__main__":
    sys.exit(main())
