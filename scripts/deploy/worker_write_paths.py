#!/usr/bin/env python3
"""T1 (strict): every path that can change a production Worker, compared with ops/publishers.json.

Stricter companion of scripts/deploy/credential_inventory.py (left unchanged). Static and read-only:
no network, no credentials. It reads the repository as DATA (YAML with BaseLoader, scripts as text).

What counts as a write path ("can change a Worker", Sol T1 conditions 1-3)
  code    wrangler deploy | rollback | delete | versions deploy; cloudflare/wrangler-action;
          Cloudflare API writes to workers/scripts/<name> (upload/delete), /versions, /deployments
  config  wrangler [versions] secret put|bulk|delete; triggers deploy; API writes to /settings,
          /script-settings, /secrets, /schedules, /subdomain
  route   API writes to workers/routes, zones/<id>/workers/routes, workers/domains
  kv      wrangler kv key|bulk put|delete; API writes to storage/kv/namespaces
  Each is detected in `run:` blocks and `with:` values of every workflow step, and in repository scripts
  those blocks invoke (followed up to FOLLOW_DEPTH levels; an invocation carrying --dry-run, `node --check`,
  py_compile or `node --test` is not followed). `--dry-run` wrangler lines are not writes.
  Workers Builds: files carrying WORKERS_CI*/RESERVE_DEPLOY markers (Cloudflare runs the build script then a
  dashboard deploy command, outside GitHub). Other CI systems (.circleci) are scanned like workflows.
  Standalone repository scripts with write commands that no workflow invokes are recovery/manual paths.

Findings (any finding -> exit 1)
  UNREGISTERED            write path absent from ops/publishers.json
  UNGUARDED_CODE_PATH     code path of a production Worker without promotion_guard.py BEFORE the write
                          (same job earlier step or a job in `needs`, and the write gated on its outcome)
  RETIRED_STILL_WRITES    workflow listed as retired that still contains a write
  TARGET_MISMATCH         statically resolved target Worker differs from the registered service
  UNREGISTERED_SCRIPT     standalone script with writes that is neither invoked nor registered
  UNPARSEABLE_WORKFLOW    workflow YAML that does not parse (scanned as raw text, never skipped)
  NOT_SERIALIZED          registered canonical/config publisher outside its service concurrency group
  PENDING_OWNER_AUTHORIZATION  registered only as pending (financial workflows): reported, never accepted
  Jobs that cannot read any Cloudflare credential (secrets.CLOUDFLARE_* / CF_*, except the account id) cannot
  change a Worker; their write commands are listed as no_credential_ops and do not produce findings.
  Steps that write an isolated candidate before the guard must be listed in pre_guard_isolated_steps and must
  not resolve to a canonical Worker.
Usage: worker_write_paths.py [--root DIR] [--json] [--registry FILE]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

try:
    import yaml
except ImportError:  # pragma: no cover - CI installs pyyaml when absent
    yaml = None

FOLLOW_DEPTH = 2
SCRIPT_WINDOW = 12
SCRIPT_EXT = (".sh", ".py", ".mjs", ".cjs", ".js", ".ts")
WR = r"\bwrangler(?:@[\w.\-]+)?\s+"
WRANGLER_OPS = [
    ("code", re.compile(WR + r"(deploy|rollback|delete|versions\s+deploy)\b")),
    ("config", re.compile(WR + r"((?:versions\s+)?secret\s+(?:put|bulk|delete)|triggers\s+deploy)\b")),
    ("kv", re.compile(WR + r"(kv(?::key|:bulk|\s+key|\s+bulk)\s+(?:put|delete))\b")),
]
CF_TARGET = re.compile(r"workers/scripts|workers/routes|workers/domains|storage/kv/namespaces|/deployments\b")
WRITE_METHOD = re.compile(
    r"-X\s*[\"']?(?:POST|PUT|PATCH|DELETE)\b|--request\s+[\"']?(?:POST|PUT|PATCH|DELETE)\b"
    r"|method\s*[=:]\s*[\"'](?:POST|PUT|PATCH|DELETE)[\"']|requests\.(?:post|put|patch|delete)\("
    r"|\bcurl\b[^\n]*(?:\s-d\s|\s--data(?:-binary|-raw|-urlencode)?\b|\s-F\s|\s--form\b|\s--upload-file\b|\s-T\s)")
READ_CALL = re.compile(r"\bfetch\w*\(|urlopen\(|\bcurl\b|requests\.get\(|\b_?get\(|\bapi\s*\(")
# A request helper whose method comes from its caller (fetch(url, {...init}), method=method) is a builder too.
PASSTHROUGH = re.compile(r"\.\.\.\s*(?:init|opts|options)\b|\bmethod\s*[=:]\s*method\b|,\s*(?:init|opts|options)\s*\)")
CF_API = re.compile(r"api\.cloudflare\.com|client/v4")
BUILDS_MARKER = re.compile(r"\bWORKERS_CI(?:_[A-Z_]+)?\b|\bRESERVE_DEPLOY\b")
GUARD = re.compile(r"promotion_guard\.py(?![^\n]*--verify-promoted)(?![^\n]*--preview)")
SCRIPT_REF = re.compile(r"(?:^|[\s\"'=(])((?:\./)?[\w.\-]+(?:/[\w.\-]+)*\.(?:sh|py|mjs|cjs|js|ts))\b")
NO_FOLLOW = re.compile(r"--dry-run|node\s+--check|py_compile|node\s+--test|\bcat\b|\bgrep\b|\bcmp\b|\bsha256sum\b")
SECRET = re.compile(r"secrets\.([A-Z0-9_]+)")
# A job can only write to Cloudflare if it can read a Cloudflare credential (account id alone is not one).
CF_CREDENTIAL = re.compile(r"secrets\.(?:CLOUDFLARE|CF)_(?!ACCOUNT_ID\b)\w+|secrets\s*\[|toJSON\(\s*secrets\s*\)")
SELF = {"scripts/deploy/worker_write_paths.py", "scripts/deploy/credential_inventory.py",
        "scripts/deploy/t1_exclusivity_verdict.py", "scripts/ci/mutants_t1_exclusivity.py"}


def logical_lines(text: str) -> list[str]:
    """Join backslash continuations; drop pure comment lines; collapse list-form commands
    (["npx", "wrangler", "deploy"] -> npx wrangler deploy)."""
    text = re.sub(r"[\"']\s*,\s*[\"']", " ", text)
    out, buf = [], ""
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        if line.endswith("\\"):
            buf += line[:-1] + " "
            continue
        line = buf + line
        buf = ""
        if line.lstrip().startswith(("#", "//")) and not line.lstrip().startswith("#!"):
            out.append("")
            continue
        out.append(line)
    if buf:
        out.append(buf)
    return out


def api_kind(line: str) -> str:
    if re.search(r"storage/kv/namespaces", line):
        return "kv"
    if re.search(r"workers/routes|workers/domains", line):
        return "route"
    if re.search(r"/(?:settings|script-settings|secrets|schedules|subdomain)\b", line):
        return "config"
    return "code"


def ops_in_text(text: str, is_script: bool) -> list[dict]:
    """Write operations in one blob. Workflow blocks: CF target and write method on the same logical line or
    within 6 lines. Scripts: file-level conjunction (target + method + Cloudflare API host)."""
    lines = logical_lines(text)
    ops = []
    for i, line in enumerate(lines):
        if not line:
            continue
        for kind, rx in WRANGLER_OPS:
            m = rx.search(line)
            if m and "--dry-run" not in line and not re.search(r"\becho\b|::(?:notice|error|warning)", line.split("wrangler")[0]):
                ops.append({"kind": kind, "op": "wrangler " + re.sub(r"\s+", " ", m.group(1)), "line": i,
                            "target": wrangler_target(line)})
        if re.search(r"uses:\s*cloudflare/wrangler-action", line):
            ops.append({"kind": "code", "op": "cloudflare/wrangler-action", "line": i, "target": None})
        if CF_TARGET.search(line):
            window = "\n".join(lines[max(0, i - 6): i + 7])
            if WRITE_METHOD.search(line) or (not is_script and re.search(r"-X\s*[\"']?(?:POST|PUT|PATCH|DELETE)|method\s*[=:]\s*[\"'](?:POST|PUT|PATCH|DELETE)", window)):
                ops.append({"kind": api_kind(line), "op": "cloudflare-api-write", "line": i, "target": api_target(line)})
    if is_script and CF_API.search(text):
        # Scripts build URLs in helpers: the write method must sit within SCRIPT_WINDOW lines of the target.
        for i, line in enumerate(lines):
            # A target line that itself performs a request without a write method is a read; only URL
            # builders (no request call on the line) borrow the method of a nearby call.
            builder = not READ_CALL.search(line) or PASSTHROUGH.search(line)
            if CF_TARGET.search(line) and not WRITE_METHOD.search(line) and builder:
                near = [j for j in range(max(0, i - SCRIPT_WINDOW), min(len(lines), i + SCRIPT_WINDOW + 1))
                        if WRITE_METHOD.search(lines[j])]
                if near:
                    ops.append({"kind": api_kind(line), "op": "cloudflare-api-write", "line": max(i, near[0]),
                                "target": api_target(line)})
    # A version created by `versions secret put|bulk|delete` and then deployed is a secret change of the live
    # code (worker_secret_rotate.py), not a code publication.
    if any(o["op"].startswith("wrangler versions secret") for o in ops):
        for o in ops:
            if o["op"] == "wrangler versions deploy":
                o["kind"], o["op"] = "config", "wrangler versions deploy (secret version)"
    return ops


def wrangler_target(line: str) -> dict | None:
    m = re.search(r"--name[ =][\"']?([\w\-${}.]+)", line)
    if m:
        return {"name": m.group(1)}
    m = re.search(r"--config[ =][\"']?([\w./\-]+)", line) or re.search(r"(?:^|\s)-c\s+([\w./\-]+)", line)
    if m:
        return {"config": m.group(1)}
    return {"config": "wrangler.toml"}


def api_target(line: str) -> dict | None:
    m = re.search(r"workers/scripts/([\w\-${}.]+)", line)
    return {"name": m.group(1)} if m else None


def resolve_target(root: pathlib.Path, target: dict | None) -> str | None:
    """Static Worker name, or None when it is computed at run time (variables, generated configs)."""
    if not target:
        return None
    name = target.get("name")
    if name:
        return None if "$" in name or "{" in name else name
    cfg = root / target.get("config", "")
    if not cfg.is_file():
        return None
    text = cfg.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^\s*name\s*=\s*[\"']([^\"']+)[\"']", text, re.M) or re.search(r"\"name\"\s*:\s*\"([^\"]+)\"", text)
    return m.group(1) if m else None


def followed_scripts(root: pathlib.Path, text: str) -> list[tuple[str, int]]:
    refs = []
    for i, line in enumerate(logical_lines(text)):
        if not line or NO_FOLLOW.search(line):
            continue
        for m in SCRIPT_REF.finditer(line):
            rel = m.group(1)[2:] if m.group(1).startswith("./") else m.group(1)
            if not (root / rel).is_file() or rel in SELF or rel.startswith(".github/"):
                continue
            body = (root / rel).read_text(encoding="utf-8", errors="replace")
            flag = re.search(r"[\"'](--(?:apply|write|execute))[\"']", body)
            if flag and flag.group(1) not in line:
                continue  # the script only writes behind an explicit flag this invocation does not pass
            refs.append((rel, i))
    return refs


def scan_blob(root: pathlib.Path, text: str, is_script: bool, depth: int = 0, seen=None, via=None) -> list[dict]:
    """Ops of a blob plus those of the scripts it invokes. Each op keeps the line of the blob where it (or
    the invocation leading to it) happens, so the guard position can be compared."""
    seen = set() if seen is None else seen
    ops = [dict(o, via=via or []) for o in ops_in_text(text, is_script)]
    if depth >= FOLLOW_DEPTH:
        return ops
    for rel, line in followed_scripts(root, text):
        if rel in seen:
            continue
        seen.add(rel)
        sub = scan_blob(root, (root / rel).read_text(encoding="utf-8", errors="replace"), True, depth + 1, seen,
                        (via or []) + [rel])
        ops += [dict(o, line=line) for o in sub]
    return ops


def guard_line(text: str) -> int | None:
    for i, line in enumerate(logical_lines(text)):
        if line and GUARD.search(line):
            return i
    return None


def _load_yaml(text: str):
    if yaml is None:
        raise SystemExit("pyyaml required: python3 -m pip install pyyaml")
    try:
        y = yaml.load(text, Loader=yaml.BaseLoader)
    except yaml.YAMLError:
        return None
    return y if isinstance(y, dict) else None


def _strings(v):
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict):
        for x in v.values():
            yield from _strings(x)
    elif isinstance(v, list):
        for x in v:
            yield from _strings(x)


def _needs(job: dict) -> list[str]:
    n = job.get("needs") or []
    return [n] if isinstance(n, str) else list(n)


def analyse_workflow(root: pathlib.Path, name: str, text: str, workflows: dict, stack=()) -> dict:
    """-> {ops: [...], guarded: bool|None, guard_detail} for one workflow (reusable callees included)."""
    y = _load_yaml(text)
    if y is None:
        # Unparseable: GitHub would not run it as written, but its text is scanned whole (fail-closed) and the
        # inventory reports it, so a write can never hide behind a YAML error.
        ops = [dict(o, job="?", step="?") for o in scan_blob(root, text, False)]
        return {"ops": ops, "unguarded": ["?/unparseable"] if any(o["kind"] == "code" for o in ops) else [],
                "no_credential": [], "unparseable": True}
    jobs = y.get("jobs") or {}
    ops, unguarded, no_cred = [], [], []
    wf_cred = any(CF_CREDENTIAL.search(s) for s in _strings(y.get("env") or {}))
    guard_jobs = set()
    for jname, job in jobs.items():
        if isinstance(job, dict) and any(GUARD.search(s) for st in job.get("steps") or [] if isinstance(st, dict) for s in _strings(st.get("run", ""))):
            guard_jobs.add(jname)

    def ancestors(j, acc=None):
        acc = set() if acc is None else acc
        for n in _needs(jobs.get(j) or {}):
            if n not in acc:
                acc.add(n)
                ancestors(n, acc)
        return acc

    for jname, job in jobs.items():
        if not isinstance(job, dict):
            continue
        job_cred = wf_cred or any(CF_CREDENTIAL.search(s) for s in _strings(job)) or str(job.get("secrets") or "").strip() == "inherit"
        uses = job.get("uses")
        if isinstance(uses, str):
            m = re.match(r"^\./\.github/workflows/([\w.\-]+\.ya?ml)$", uses.strip())
            if m and m.group(1) in workflows and m.group(1) not in stack:
                callee = analyse_workflow(root, m.group(1), workflows[m.group(1)], workflows, stack + (name,))
                if not job_cred:
                    no_cred += [f"{jname}->{m.group(1)}: {o['op']}" for o in callee["ops"]]
                    continue
                for o in callee["ops"]:
                    ops.append(dict(o, job=jname, via=[m.group(1)] + o.get("via", [])))
                if callee["unguarded"]:
                    unguarded.append(f"{jname}->{m.group(1)}")
            continue
        steps = [s for s in job.get("steps") or [] if isinstance(s, dict)]
        guard_step, gated_ids, gated_env = None, set(), set()
        job_if = str(job.get("if") or "")
        job_gated = any(f"needs.{g}." in job_if for g in guard_jobs & ancestors(jname))
        for idx, st in enumerate(steps):
            run = st.get("run") if isinstance(st.get("run"), str) else ""
            blob = run + "\n" + "\n".join(_strings(st.get("with") or {}))
            if isinstance(st.get("uses"), str):
                blob = f"uses: {st['uses']}\n" + blob
            sops = scan_blob(root, blob, False)
            g = guard_line(run)
            sid, sif = str(st.get("id") or ""), str(st.get("if") or "")
            if g is not None and guard_step is None:
                guard_step = idx
                if sid:
                    gated_ids.add(sid)
                gated_env |= set(re.findall(r"echo\s+[\"']?([A-Z_][A-Z0-9_]*)=[^\n]*GITHUB_ENV", run))
            step_gated = (job_gated or any(f"steps.{i}." in sif for i in gated_ids)
                          or any(re.search(rf"env\.{e}\b", sif) for e in gated_env))
            if step_gated and sid:
                gated_ids.add(sid)
            for o in sops:
                o = dict(o, job=jname, step=st.get("name") or f"#{idx}")
                if not job_cred:
                    no_cred.append(f"{jname}/{o['step']}: {o['op']}")
                    continue  # no Cloudflare credential reachable from this job: cannot change a Worker
                ops.append(o)
                if o["kind"] != "code":
                    continue
                same_step_guard = g is not None and g < o["line"]
                earlier = guard_step is not None and guard_step < idx and step_gated
                if not (job_gated or same_step_guard or earlier):
                    unguarded.append(f"{jname}/{o['step']}")
    return {"ops": ops, "unguarded": sorted(set(unguarded)), "no_credential": sorted(set(no_cred))}


def registry_index(reg: dict) -> dict:
    idx = {}
    for svc, s in (reg.get("services") or {}).items():
        for wf in [s.get("canonical"), *s.get("config_publishers", []), *s.get("pending_owner_authorization", [])]:
            if wf:
                idx[wf] = {"service": svc, "role": "canonical" if wf == s.get("canonical") else
                           ("pending_owner_authorization" if wf in s.get("pending_owner_authorization", []) else "config")}
    for target, wf in (reg.get("isolated") or {}).items():
        idx[wf] = {"service": target, "role": "isolated"}
    for wf in reg.get("unserialized_known") or {}:
        idx.setdefault(wf, {"service": "unserialized", "role": "unserialized_known"})
    for wf in reg.get("retired") or []:
        idx[wf] = {"service": "retired", "role": "retired"}
    for wf in reg.get("validation_only") or []:
        idx[wf] = {"service": "validation_only", "role": "validation_only"}
    return idx


def inventory(root: pathlib.Path, registry: dict) -> dict:
    wf_dir = root / ".github" / "workflows"
    workflows = {f.name: f.read_text(encoding="utf-8", errors="replace")
                 for f in sorted(list(wf_dir.glob("*.yml")) + list(wf_dir.glob("*.yaml")))}
    idx = registry_index(registry)
    rows, findings, invoked = [], [], set()

    def add(code, path, detail):
        findings.append({"code": code, "path": path, "detail": detail})

    for name, text in workflows.items():
        res = analyse_workflow(root, name, text, workflows)
        for o in res["ops"]:
            invoked.update(o.get("via") or [])
        if not res["ops"]:
            if res["no_credential"]:
                rows.append({"path": name, "type": "workflow", "registered_as": idx.get(name), "kinds": [],
                             "ops": [], "targets": [], "unguarded": [], "credentials": [],
                             "no_credential_ops": res["no_credential"]})
            continue
        canon = {s.get("canonical") and svc for svc, s in (registry.get("services") or {}).items()}
        iso = (registry.get("pre_guard_isolated_steps") or {}).get(name) or {}
        acknowledged = []
        for u in list(res["unguarded"]):
            step = u.split("/", 1)[-1]
            step_targets = {resolve_target(root, o.get("target")) for o in res["ops"] if o.get("step") == step}
            if step in iso and not (step_targets & canon):
                res["unguarded"].remove(u)
                acknowledged.append(u)
        reg = idx.get(name)
        if res.get("unparseable"):
            add("UNPARSEABLE_WORKFLOW", name, "YAML does not parse; scanned as raw text")
        kinds = sorted({o["kind"] for o in res["ops"]})
        targets = sorted({t for t in (resolve_target(root, o.get("target")) for o in res["ops"]) if t})
        row = {"path": name, "type": "workflow", "registered_as": reg, "kinds": kinds,
               "ops": sorted({o["op"] + (f" via {'>'.join(o['via'])}" if o.get("via") else "") for o in res["ops"]}),
               "targets": targets, "unguarded": res["unguarded"], "isolated_pre_guard": acknowledged,
               "no_credential_ops": res["no_credential"],
               "credentials": sorted({s for s in SECRET.findall(text) if s.startswith(("CLOUDFLARE", "CF_"))})}
        rows.append(row)
        if not reg:
            add("UNREGISTERED", name, f"kinds={','.join(kinds)} ops={'; '.join(row['ops'])}")
            continue
        if reg["role"] in ("retired", "validation_only"):
            add("RETIRED_STILL_WRITES", name, f"{reg['role']} but ops={'; '.join(row['ops'])}")
            continue
        production = reg["role"] not in ("isolated",)
        if production and "code" in kinds and res["unguarded"]:
            add("UNGUARDED_CODE_PATH", name, "no promotion_guard.py gating before: " + ", ".join(res["unguarded"]))
        svc = reg["service"]
        conc = (_load_yaml(text) or {}).get("concurrency")
        group = str(conc.get("group", "") if isinstance(conc, dict) else conc or "")
        svc_group = ((registry.get("services") or {}).get(svc) or {}).get("group")
        serialized = bool(svc_group) and (group == svc_group or f"'{svc_group}'" in group)
        row["concurrency_group"] = group
        if reg["role"] in ("pending_owner_authorization", "unserialized_known"):
            add("PENDING_OWNER_AUTHORIZATION", name, f"registered for {svc} but not brought under the service rules "
                f"(serialized={str(serialized).lower()}, group={group or 'none'}); needs the owner's written authorization")
        elif reg["role"] in ("canonical", "config") and not serialized:
            add("NOT_SERIALIZED", name, f"group={group or 'none'} expected {svc_group}")
        code_targets = sorted({t for t in (resolve_target(root, o.get("target")) for o in res["ops"] if o["kind"] in ("code", "config")) if t})
        if reg["role"] in ("canonical", "config", "pending_owner_authorization", "isolated"):
            wrong = [t for t in code_targets if t != svc]
            if wrong:
                add("TARGET_MISMATCH", name, f"registered for {svc}, writes {','.join(wrong)}")

    # Other CI systems: same scan over their command text.
    for ci in sorted((root / ".circleci").glob("*.yml")) if (root / ".circleci").is_dir() else []:
        text = ci.read_text(encoding="utf-8", errors="replace")
        ops = scan_blob(root, text, False)
        rel = str(ci.relative_to(root))
        for o in ops:
            invoked.update(o.get("via") or [])
        if ops:
            rows.append({"path": rel, "type": "ci", "registered_as": None, "kinds": sorted({o["kind"] for o in ops}),
                         "ops": sorted({o["op"] for o in ops}), "targets": [], "unguarded": [], "credentials": []})
            add("UNREGISTERED", rel, "external CI system with write commands")

    # Workers Builds (Cloudflare-side build + dashboard deploy command).
    builds_reg = registry.get("workers_builds") or {}
    markers = []
    for f in sorted(root.rglob("*")):
        rel = str(f.relative_to(root))
        if not f.is_file() or rel.startswith((".git/", "tests/", "node_modules/")) or rel in SELF or f.suffix not in SCRIPT_EXT + (".yml", ".yaml", ".toml", ".json", ".jsonc", ""):
            continue
        if f.stat().st_size > 2_000_000:
            continue
        if BUILDS_MARKER.search(f.read_text(encoding="utf-8", errors="replace")):
            markers.append(rel)
    build_scripts = [m for m in markers if m.endswith(".sh")]
    for bs in build_scripts:
        reg = next(({"service": svc, **v} for svc, v in builds_reg.items() if v.get("build_script") == bs), None)
        text = (root / bs).read_text(encoding="utf-8", errors="replace")
        g = guard_line(text)
        guarded = g is not None and (reg or {}).get("deploy_command_after_build", True)
        rows.append({"path": f"workers-builds:{bs}", "type": "workers_builds", "registered_as": reg, "kinds": ["code"],
                     "ops": [f"dashboard deploy command: {(reg or {}).get('deploy_command', 'unknown')}"],
                     "targets": [reg["service"]] if reg else [], "unguarded": [] if guarded else [bs],
                     "credentials": [], "markers": markers})
        if not reg:
            add("UNREGISTERED", f"workers-builds:{bs}", f"Workers Builds markers in {', '.join(markers)}")
        elif not guarded:
            add("UNGUARDED_CODE_PATH", f"workers-builds:{bs}", "build script has no promotion_guard.py before the deploy command")

    # Standalone scripts with writes (recovery / manual paths) not invoked by any scanned pipeline.
    manual = registry.get("manual_operations") or {}
    for f in sorted((root / "scripts").rglob("*")) if (root / "scripts").is_dir() else []:
        rel = str(f.relative_to(root))
        if not f.is_file() or f.suffix not in SCRIPT_EXT or rel in SELF or rel in invoked or rel in build_scripts:
            continue
        ops = ops_in_text(f.read_text(encoding="utf-8", errors="replace"), True)
        if not ops:
            continue
        reg = manual.get(rel)
        rows.append({"path": rel, "type": "script", "registered_as": ({"service": reg.get("service"), "role": "manual_operation"} if reg else None),
                     "kinds": sorted({o["kind"] for o in ops}), "ops": sorted({o["op"] for o in ops}),
                     "targets": [], "unguarded": [], "credentials": []})
        if not reg:
            add("UNREGISTERED_SCRIPT", rel, f"not invoked by any workflow; ops={','.join(sorted({o['op'] for o in ops}))}")
        elif "code" in {o["kind"] for o in ops} and guard_line(f.read_text(encoding="utf-8", errors="replace")) is None and not reg.get("guard"):
            add("UNGUARDED_CODE_PATH", rel, "manual code path without promotion_guard.py")
    findings.sort(key=lambda x: (x["code"], x["path"]))
    return {"rows": rows, "findings": findings}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(pathlib.Path(__file__).resolve().parents[2]))
    ap.add_argument("--registry")
    ap.add_argument("--json", action="store_true", help="print only the JSON result")
    a = ap.parse_args(argv)
    root = pathlib.Path(a.root).resolve()
    reg = json.loads(pathlib.Path(a.registry or root / "ops" / "publishers.json").read_text(encoding="utf-8"))
    res = inventory(root, reg)
    if a.json:
        print(json.dumps(res, sort_keys=True))
    else:
        print("| Path | Type | Registered | Kinds | Targets | Unguarded code writes |")
        print("|---|---|---|---|---|---|")
        for r in res["rows"]:
            reg_s = f"{r['registered_as']['service']}/{r['registered_as']['role']}" if r.get("registered_as") and "role" in r["registered_as"] else (r["registered_as"]["service"] if r.get("registered_as") else "NO")
            print(f"| {r['path']} | {r['type']} | {reg_s} | {','.join(r['kinds'])} | {','.join(r['targets']) or '-'} | {', '.join(r['unguarded']) or '-'} |")
        print()
        for f in res["findings"]:
            print(f"T1_WRITE_PATH_FINDING {f['code']} {f['path']} :: {f['detail']}")
        print("T1_WRITE_PATHS=" + json.dumps({"paths": len(res["rows"]), "findings": len(res["findings"]),
                                             "by_code": {c: sum(1 for f in res["findings"] if f["code"] == c) for c in sorted({f["code"] for f in res["findings"]})}},
                                            sort_keys=True))
    return 1 if res["findings"] else 0


if __name__ == "__main__":
    sys.exit(main())
