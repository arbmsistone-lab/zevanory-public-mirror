#!/usr/bin/env python3
"""F7: measure real consumption against the free-tier limits the owner relies on.
Fails (alert) at >= 70% of any limit, and also when a metric cannot be measured
(not proven = failed). Only aggregates are printed; the repository is public."""
import datetime, hashlib, hmac, json, os, sys, time, urllib.error, urllib.request

ACCOUNT = os.environ.get("CF_ACCOUNT_ID") or "1b26415802588185a86c1d4d3ebf5bdb"
CF_TOKEN = os.environ.get("CF_TOKEN", "").strip()
AUDIT_KEY = os.environ.get("CERTIFICATION_E2E_TOKEN", "").strip()
RESEND = os.environ.get("RESEND_API_KEY", "").strip()
ALERT = 0.70
LIMITS = {  # free plans (documented limits)
    "workers_requests_day": 100_000,
    "workers_cpu_ms_per_invocation": 10.0,
    "kv_reads_day": 100_000,
    "kv_writes_day": 1_000,
    "kv_deletes_day": 1_000,
    "kv_lists_day": 1_000,
    "resend_emails_day": 100,
    "resend_emails_month": 3_000,
    "neon_storage_bytes": 512 * 1024 * 1024,
}
now = datetime.datetime.now(datetime.timezone.utc)
since = (now - datetime.timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
until = now.strftime("%Y-%m-%dT%H:%M:%SZ")
results, failures = {}, []

def note(level, title, msg): print(f"::{level} title={title}::{msg}"[:900], flush=True)

def http(url, headers=None, data=None, method="GET"):
    req = urllib.request.Request(url, headers=headers or {}, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"{}")
        except Exception: return e.code, {}
    except Exception as e: return 0, {"error": type(e).__name__}

def record(metric, used, limit, unit=""):
    pct = used / limit if limit else 1
    results[metric] = {"used": used, "limit": limit, "pct": round(pct * 100, 1)}
    if pct >= ALERT: failures.append(f"{metric}={round(pct*100,1)}%")
    note("notice" if pct < ALERT else "error", "F7_USAGE", f"{metric}: {used}{unit} / {limit}{unit} ({round(pct*100,1)}%)")

def unavailable(metric, why):
    results[metric] = {"unavailable": why}; failures.append(f"{metric}:unmeasured({why})")
    note("error", "F7_USAGE", f"{metric}: NOT MEASURED ({why})")

# 1. Cloudflare Workers + KV via GraphQL analytics (read-only).
def gql(query):
    return http("https://api.cloudflare.com/client/v4/graphql",
                {"Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json"},
                json.dumps({"query": query}).encode(), "POST")
if not CF_TOKEN:
    unavailable("workers_requests_day", "no_token"); unavailable("kv_reads_day", "no_token")
else:
    q = '{viewer{accounts(filter:{accountTag:"%s"}){workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:"%s",datetime_leq:"%s"}){sum{requests errors subrequests}quantiles{cpuTimeP99}dimensions{scriptName}}}}}' % (ACCOUNT, since, until)
    code, body = gql(q)
    rows = (((body.get("data") or {}).get("viewer") or {}).get("accounts") or [{}])[0].get("workersInvocationsAdaptive") if code == 200 else None
    if rows is None or body.get("errors"):
        unavailable("workers_requests_day", f"graphql_{code}_{str((body.get('errors') or [{}])[0].get('message',''))[:60]}")
    else:
        total = sum(r["sum"]["requests"] for r in rows); errors = sum(r["sum"]["errors"] for r in rows)
        record("workers_requests_day", total, LIMITS["workers_requests_day"])
        worst = max(((r["quantiles"]["cpuTimeP99"] or 0) / 1000.0, r["dimensions"]["scriptName"]) for r in rows) if rows else (0, "-")
        record("workers_cpu_ms_per_invocation", round(worst[0], 2), LIMITS["workers_cpu_ms_per_invocation"], "ms")
        note("notice", "F7_WORKERS", f"scripts={len({r['dimensions']['scriptName'] for r in rows})} errors_24h={errors} worst_p99_cpu_script={worst[1]}")
    q = '{viewer{accounts(filter:{accountTag:"%s"}){kvOperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"%s",datetime_leq:"%s"}){sum{requests}dimensions{actionType}}}}}' % (ACCOUNT, since, until)
    code, body = gql(q)
    rows = (((body.get("data") or {}).get("viewer") or {}).get("accounts") or [{}])[0].get("kvOperationsAdaptiveGroups") if code == 200 else None
    if rows is None or body.get("errors"):
        unavailable("kv_reads_day", f"graphql_{code}_{str((body.get('errors') or [{}])[0].get('message',''))[:60]}")
    else:
        by = {}
        for r in rows: by[r["dimensions"]["actionType"]] = by.get(r["dimensions"]["actionType"], 0) + r["sum"]["requests"]
        record("kv_reads_day", by.get("read", 0), LIMITS["kv_reads_day"])
        record("kv_writes_day", by.get("write", 0), LIMITS["kv_writes_day"])
        record("kv_deletes_day", by.get("delete", 0), LIMITS["kv_deletes_day"])
        record("kv_lists_day", by.get("list", 0), LIMITS["kv_lists_day"])
    # Breakdown of writes by namespace and hour to find the writers (aggregates only).
    q = '{viewer{accounts(filter:{accountTag:"%s"}){kvOperationsAdaptiveGroups(limit:2000,filter:{datetime_geq:"%s",datetime_leq:"%s",actionType:"write"}){sum{requests}dimensions{namespaceId datetimeHour}}}}}' % (ACCOUNT, since, until)
    code, body = gql(q)
    rows = (((body.get("data") or {}).get("viewer") or {}).get("accounts") or [{}])[0].get("kvOperationsAdaptiveGroups") if code == 200 else None
    if rows:
        ns, hours = {}, {}
        for r in rows:
            d = r["dimensions"]; n = r["sum"]["requests"]
            ns[d["namespaceId"][:8]] = ns.get(d["namespaceId"][:8], 0) + n
            hours[d["datetimeHour"][11:13]] = hours.get(d["datetimeHour"][11:13], 0) + n
        note("notice", "F7_KV_WRITES_BY_NAMESPACE", json.dumps(dict(sorted(ns.items(), key=lambda x: -x[1])), sort_keys=False))
        note("notice", "F7_KV_WRITES_BY_HOUR_UTC", json.dumps(dict(sorted(hours.items()))))
    # Per-script CPU and requests (ZEVANORY scripts are the launch scope).
    q = '{viewer{accounts(filter:{accountTag:"%s"}){workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:"%s",datetime_leq:"%s"}){sum{requests errors}quantiles{cpuTimeP50 cpuTimeP99}dimensions{scriptName}}}}}' % (ACCOUNT, since, until)
    code, body = gql(q)
    rows = (((body.get("data") or {}).get("viewer") or {}).get("accounts") or [{}])[0].get("workersInvocationsAdaptive") if code == 200 else None
    if rows:
        per = {}
        for r in rows:
            k = r["dimensions"]["scriptName"]; e = per.setdefault(k, [0, 0, 0.0, 0.0])
            e[0] += r["sum"]["requests"]; e[1] += r["sum"]["errors"]
            e[2] = max(e[2], (r["quantiles"]["cpuTimeP50"] or 0) / 1000); e[3] = max(e[3], (r["quantiles"]["cpuTimeP99"] or 0) / 1000)
        for k, (req_, err, p50, p99) in sorted(per.items(), key=lambda x: -x[1][0])[:8]:
            note("notice", "F7_WORKER_SCRIPT", f"{k}: req={req_} err={err} cpu_p50={p50:.1f}ms cpu_p99={p99:.1f}ms")

# 2. Neon storage via the signed read-only runtime-identity endpoint.
if len(AUDIT_KEY) < 32:
    unavailable("neon_storage_bytes", "no_audit_key")
else:
    path, ts = "/api/internal/audit/runtime-identity", str(int(time.time()))
    sig = hmac.new(AUDIT_KEY.encode(), ("GET\n" + path + "\n" + ts).encode(), hashlib.sha256).hexdigest()
    code, body = http("https://zevanory.api.br" + path, {"Accept": "application/json", "User-Agent": "ZEVANORY-AuditReadOnly/1.0",
                      "x-zevanory-audit-ts": ts, "x-zevanory-audit-signature": sig})
    db = (body or {}).get("database") or {}
    if code == 200 and isinstance(db.get("size_bytes"), int) and db.get("size_bytes") > 0:
        record("neon_storage_bytes", db["size_bytes"], LIMITS["neon_storage_bytes"], "B")
        note("notice", "F7_DB", f"host_suffix={db.get('provider_host_suffix')} postgres={db.get('postgres_version')}")
    else:
        unavailable("neon_storage_bytes", f"identity_http_{code}")

# 3. Resend sends (list API, paginated; only timestamps are read).
if not RESEND:
    unavailable("resend_emails_day", "no_key")
else:
    day_ago, month_start = now - datetime.timedelta(hours=24), now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    day = month = 0; after = None; ok = True
    for _ in range(40):
        code, body = http("https://api.resend.com/emails?limit=100" + (f"&after={after}" if after else ""), {"Authorization": "Bearer " + RESEND})
        if code != 200: ok = False; break
        items = body.get("data") or []
        for it in items:
            try: t = datetime.datetime.fromisoformat(str(it.get("created_at")).replace(" ", "T").replace("Z", "+00:00"))
            except Exception: continue
            if t.tzinfo is None: t = t.replace(tzinfo=datetime.timezone.utc)
            if t >= day_ago: day += 1
            if t >= month_start: month += 1
        if not body.get("has_more") or not items: break
        last = items[-1]
        if datetime.datetime.fromisoformat(str(last.get("created_at")).replace(" ", "T").replace("Z", "+00:00")).replace(tzinfo=datetime.timezone.utc) < month_start: break
        after = last.get("id")
    if ok:
        record("resend_emails_day", day, LIMITS["resend_emails_day"])
        record("resend_emails_month", month, LIMITS["resend_emails_month"])
    else:
        unavailable("resend_emails_day", f"list_http_{code}")

if failures:
    note("error", "F7_FREE_TIER", "ALERT/NOT_PROVEN: " + "; ".join(failures))
    sys.exit(1)
note("notice", "F7_FREE_TIER", "PASS: every free-tier metric measured and below 70%")
