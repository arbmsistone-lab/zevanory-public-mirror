"""T1 transition simulation only (loaded via PYTHONPATH by tests/test_t1_transition.py).

Replaces the network for scripts/deploy/promotion_guard.py: the panel readback and the
Cloudflare API answer from a JSON state file, so the REAL workflow scripts can be executed
without touching production. Never shipped to or imported by any workflow.
"""
import io
import json
import os
import time
import urllib.error
import urllib.request

time.sleep = lambda s: None  # propagation retries run instantly in the simulation

_STATE = os.environ.get("SIM_STATE", "")


def _state():
    with open(_STATE, encoding="utf-8") as fh:
        return json.load(fh)


def _next(key, spec):
    """A source may be a list (one entry per read, last one repeats): propagation delay."""
    if isinstance(spec, list):
        counter = _STATE + "." + key
        n = int(open(counter).read()) if os.path.exists(counter) else 0
        open(counter, "w").write(str(n + 1))
        return spec[min(n, len(spec) - 1)]
    return spec


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _json(obj):
    return _Resp(json.dumps(obj).encode())


def _fake_urlopen(req, timeout=None):
    url = req.full_url if hasattr(req, "full_url") else str(req)
    st = _state()
    if "api.cloudflare.com" in url:
        cf = _next("cf", st.get("cf", "unreachable"))
        if cf == "unreachable":
            raise urllib.error.URLError("simulated cloudflare api outage")
        if url.endswith("/deployments"):
            return _json({"success": True, "result": {"deployments": [{"versions": [{"version_id": "v1", "percentage": 100}]}]}})
        tag = {} if cf == "untagged" else {"workers/tag": cf}
        return _json({"success": True, "result": {"metadata": {"annotations": tag}}})
    if "zevanory.api.br" in url:
        rb = _next("readback", st.get("readback", "unreachable"))
        if rb == "unreachable":
            raise urllib.error.URLError("simulated network failure")
        if rb == "http500":
            raise urllib.error.HTTPError(url, 503, "simulated service error", {}, None)
        return _json({"sha": rb, "deployment": {"commit_sha": rb}, "release": rb})
    raise urllib.error.URLError("simulation: unexpected host " + url)


urllib.request.urlopen = _fake_urlopen
