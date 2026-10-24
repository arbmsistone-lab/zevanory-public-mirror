"""R4 (PI) guard tests: scripts/ci/no_forged_production_input.py must fail any workflow that sends forged or signed
input to a production host (incident I1), directly or through a repo script it executes.

Every fixture is a throw-away repository tree (workflows + scripts) built in a temporary directory; nothing touches the
network. The scanner under test is loaded from NFPI_SCRIPT when set (mutation runs use a mutated copy), otherwise
from the repository. Assertion messages carry labels (NF01a ...) that scripts/ci/mutants_no_forged_production_input.py
uses as primary/secondary expectations through the shared classifier scripts/ci/mutant_classifier.py.
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(os.environ.get("NFPI_SCRIPT") or ROOT / "scripts/ci/no_forged_production_input.py")


def load():
    spec = importlib.util.spec_from_file_location("nfpi_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


NF = load()
GOOD_JUSTIFICATION = "Fixture entry: first-party operator call reviewed by the owner, kept for the test only."


def wf(steps, env="", gate=None, job_if=None):
    """A minimal workflow whose single job runs the given run-block lines (already indented 10 spaces).
    gate=VAR puts the R4 owner approval gate on vars.VAR as the first step; job_if adds a job-level if."""
    g = ("      - name: R4 owner approval gate (fail-closed)\n        env:\n"
         f"          R4_OWNER_APPROVAL: ${{{{ vars.{gate} }}}}\n        run: |\n"
         "          if [ \"${R4_OWNER_APPROVAL:-}\" != approved ]; then exit 1; fi\n") if gate else ""
    return ("name: fixture\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  j:\n"
            + (f"    if: {job_if}\n" if job_if else "") + "    runs-on: ubuntu-latest\n" + (("    env:\n" + env) if env else "") +
            "    steps:\n" + g + "      - name: step\n        run: |\n" + steps)


SUPPORT = {"tests/t_counter.py": "def test_counter():\n    pass\n",
           "worker/h.mjs": "// handler fixture\nexport const a = 1;\nexport const b = 2;\n"}


def allow_doc(allowed=(), opened=(), gates=()):
    return {"schema": "r4-allow/v2", "allowed": list(allowed), "open_real_risks": list(opened),
            "financial_gates": list(gates)}


def entry(**over):
    """A complete, valid R4 allow entry for the fixture backup call (POST /api/internal/backup/run)."""
    e = {"file": ".github/workflows/a.yml", "line_pattern": "x-backup-token", "endpoint": "/api/internal/backup/run",
         "method": "POST", "identity": {"principal": "ZEVANORY", "credential": "x-backup-token", "impersonates": []},
         "purpose": "Fixture: daily backup into ZEVANORY-owned copies, counts and hashes only.",
         "least_privilege": "Fixture: POST plus token only, bounded parts, no other route reachable.",
         "effects": {k: False for k in ("synthetic_financial_transaction", "opens_sales", "commercial_effect",
                                        "triggers_webhook_or_checkout", "changes_credentials_or_config")},
         "data_scope": {"alters_production_data": False, "deletes_production_data": False,
                        "restores_into_production": False},
         "payload": {"controlled": True, "writes": True, "idempotent": True,
                     "audit_trail": "fixture report key with counts only", "secrets_in_audit": False},
         "handler_evidence": ["worker/h.mjs:1-3"], "counter_proof_test": "tests/t_counter.py::test_counter",
         "risk_acceptance": {"status": "PENDING_OWNER", "by": "", "at": "", "reference": ""}}
    e.update(over)
    return e


def opened(**over):
    e = {"file": ".github/workflows/a.yml", "line_pattern": "x-hub-signature-256", "classification": "REAL_RISK",
         "status": "OPEN_NOT_HOMOLOGATED", "reason": "Fixture: signed call that cannot be allowed; tracked as open risk.",
         "evidence": ["fixture evidence"], "required_fix": "Fixture: remove the signed call.",
         "independent_control": {"type": "owner-approval-gate", "variable": "R4_FIXTURE_OWNER_APPROVAL",
                                 "workflows": [".github/workflows/a.yml"]},
         "risk_acceptance": {"status": "NOT_ACCEPTED", "by": "", "at": "", "reference": ""}}
    e.update(over)
    return e


class Tree:
    def __init__(self, files, allow=None):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for rel, text in {**SUPPORT, **files}.items():
            p = self.root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        self.allow = self.root / "allow.json"
        self.allow.write_text(json.dumps(allow if allow is not None else allow_doc()), encoding="utf-8")

    def hits(self):
        found, _ = NF.scan(self.root)
        remaining, gates, _ = NF.apply_allow(found, NF.load_allow(self.allow, self.root), self.root)
        return remaining + gates

    def main(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = NF.main(["--root", str(self.root), "--allow", str(self.allow), *extra])
        return rc, out.getvalue() + err.getvalue()

    def close(self):
        self.tmp.cleanup()


class Base(unittest.TestCase):
    def tree(self, files, allow=None):
        t = Tree(files, allow)
        self.addCleanup(t.close)
        return t

    def rules(self, hits, file=None):
        return {h["rule"] for h in hits if file is None or h["file"] == file}


class ForgedInputTests(Base):
    def test_nf00_exit_codes_fail_closed(self):
        bad = self.tree({".github/workflows/a.yml": wf(
            "          curl -X POST -H 'x-hub-signature-256: sha256=00' https://edge.zevanory.api.br/api/webhooks/meta\n")})
        rc, out = bad.main()
        self.assertEqual(rc, 1, "NF00a a hit must exit 1: " + out)
        self.assertIn("R4_FORGED_INPUT_SCAN FAIL", out, "NF00b verdict line")
        good = self.tree({".github/workflows/a.yml": wf("          curl -fsS https://zevanory.api.br/api/release\n")})
        rc, out = good.main()
        self.assertEqual(rc, 0, "NF00c a clean tree must exit 0: " + out)

    def test_nf01_curl_post_signed_meta_webhook_on_edge_fails(self):
        t = self.tree({".github/workflows/a.yml": wf(
            "          curl -fsS -X POST \\\n"
            "            -H 'content-type: application/json' \\\n"
            "            -H \"x-hub-signature-256: sha256=$SIG\" \\\n"
            "            --data-binary @/tmp/body.json \\\n"
            "            https://edge.zevanory.api.br/api/webhooks/meta\n")})
        h = t.hits()
        self.assertTrue(any(x["file"] == ".github/workflows/a.yml" and x["line"] == 12 for x in h),
                        f"NF01a hit expected at the curl line: {h}")
        self.assertIn("R4-SIGNED", self.rules(h), f"NF01b x-hub-signature-256 must be flagged: {h}")
        self.assertIn("R4-INBOUND", self.rules(h), f"NF01c /api/webhooks/meta must be flagged: {h}")
        self.assertIn("edge.zevanory.api.br", h[0]["hosts"], "NF01d edge host resolved")

    def test_nf02_node_fetch_post_resend_webhook_with_svix_headers_fails(self):
        t = self.tree({".github/workflows/a.yml": wf(
            "          node --input-type=module <<'JS'\n"
            "          const ORIGIN = 'https://zevanory.api.br';\n"
            "          const r = await fetch(ORIGIN + '/api/webhooks/resend', {\n"
            "            method: 'POST',\n"
            "            headers: {'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,' + sig},\n"
            "            body,\n"
            "          });\n"
            "          JS\n")})
        h = t.hits()
        self.assertIn("R4-SIGNED", self.rules(h), f"NF02a svix-signature must be flagged: {h}")
        self.assertIn("R4-INBOUND", self.rules(h), f"NF02b resend webhook path must be flagged: {h}")

    def test_nf03_get_and_head_readbacks_pass(self):
        t = self.tree({".github/workflows/a.yml": wf(
            "          curl -fsS https://zevanory.api.br/api/release -o /tmp/release.json\n"
            "          curl -sS -I https://vendas.zevanory.api.br/\n"
            "          curl -fsS https://zevanory.api.br/api/health\n"
            "          curl -fsS https://zevanory.api.br/api/internal/certification/e2e/status?order_id=1\n"
            "          curl -fsS -H \"x-zevanory-audit-signature: $SIG\" https://zevanory.api.br/api/sales/status\n"
            "          node -e \"fetch('https://zevanory.api.br/api/webhooks/meta').then(r=>r.status)\"\n")})
        h = t.hits()
        self.assertEqual(h, [], f"NF03a GET/HEAD readbacks (even signed or on inbound paths) must pass: {h}")

    def test_nf04_post_to_provider_apis_passes(self):
        t = self.tree({".github/workflows/a.yml": wf(
            "          curl -fsS -X POST -H \"Authorization: Bearer $RESEND_API_KEY\" -d @mail.json https://api.resend.com/emails\n"
            "          curl -fsS -X POST -H \"Authorization: Bearer $CF\" https://api.cloudflare.com/client/v4/accounts/x/workers/scripts/y/deployments\n"
            "          node --input-type=module <<'JS'\n"
            "          await fetch('https://api.mercadopago.com/v1/payments', {method: 'POST', headers: {'x-signature': s}});\n"
            "          JS\n")})
        h = t.hits()
        self.assertEqual(h, [], f"NF04a provider APIs are not our production inbound endpoints: {h}")

    def test_nf05_workflow_calling_repo_script_that_posts_signed_input_fails(self):
        t = self.tree({
            ".github/workflows/a.yml": wf("          bash scripts/ops/replay.sh\n"),
            "scripts/ops/replay.sh": (
                "#!/usr/bin/env bash\nset -euo pipefail\n"
                "BODY='{\"object\":\"whatsapp_business_account\"}'\n"
                "curl -fsS -X POST -H \"x-hub-signature-256: sha256=$SIG\" -d \"$BODY\" "
                "https://zevanory.api.br/api/webhooks/meta\n")})
        h = t.hits()
        mine = [x for x in h if x["file"] == "scripts/ops/replay.sh"]
        self.assertTrue(mine, f"NF05a the invoked script must be scanned and flagged: {h}")
        self.assertEqual(mine[0]["line"], 4, "NF05b hit reported at the script line")
        self.assertIn(".github/workflows/a.yml", mine[0].get("invoked_by", []), "NF05c chain to the workflow")

    def test_nf06_hmac_near_production_post_fails(self):
        t = self.tree({".github/workflows/a.yml": wf(
            "          node --input-type=module <<'JS'\n"
            "          import {createHmac} from 'node:crypto';\n"
            "          const mac = createHmac('sha256', process.env.APP_SECRET).update(body).digest('hex');\n"
            "          await fetch('https://zevanory.api.br/api/orders/sync', {method: 'POST', headers: {'x-auth': mac}, body});\n"
            "          JS\n")})
        h = t.hits()
        self.assertEqual(self.rules(h), {"R4-HMAC"}, f"NF06a HMAC computed next to a production POST: {h}")

    def test_nf07_python_wrapper_with_production_default_fails(self):
        # The F2 pattern (mercadopago_combo_sandbox.py at a69b0abd): a module-level host default and helpers.
        t = self.tree({
            ".github/workflows/a.yml": wf("          python3 scripts/sandbox_proof.py\n"),
            "scripts/sandbox_proof.py": (
                "import os, urllib.request\n"
                "APP = (os.environ.get('SANDBOX_URL') or 'https://zevanory.api.br').rstrip('/')\n"
                "CERT_PATH = '/api/internal/certification/e2e/'\n"
                "class Client:\n"
                "    def request(self, url, method='GET', body=None, headers=None):\n"
                "        req = urllib.request.Request(url, method=method, headers=headers or {}, data=body)\n"
                "        return urllib.request.urlopen(req).read()\n"
                "    def cert(self, path, method='GET', body=None):\n"
                "        return self.request(APP + CERT_PATH + path, method, body, {'x-cert': 't'})\n"
                "client = Client()\n"
                "client.cert('status')\n"
                "client.cert('checkout', 'POST', b'{}')\n")})
        h = t.hits()
        self.assertEqual([(x["line"], x["rule"]) for x in h if x["file"] == "scripts/sandbox_proof.py"],
                         [(12, "R4-INBOUND")], f"NF07a only the POST call site through two helpers: {h}")

    def test_nf08_workflow_env_production_url_reaches_script(self):
        t = self.tree({
            ".github/workflows/a.yml": wf("          python3 scripts/sandbox_env.py\n",
                                          env="      CERTIFICATION_SANDBOX_URL: https://zevanory.api.br\n"),
            "scripts/sandbox_env.py": (
                "import os, requests\n"
                "base = os.environ['CERTIFICATION_SANDBOX_URL']\n"
                "requests.post(base + '/api/internal/certification/e2e/checkout', json={})\n")})
        h = t.hits()
        self.assertTrue(any(x["file"] == "scripts/sandbox_env.py" and x["rule"] == "R4-INBOUND" for x in h),
                        f"NF08a a production URL set in workflow env must taint the script: {h}")

    def test_nf09_production_workers_dev_fails_isolated_certification_worker_passes(self):
        t = self.tree({".github/workflows/a.yml": wf(
            "          curl -X POST -H \"x-signature: $S\" https://giro-whatsapp-bridge.girolocal-rb.workers.dev/broker/send\n"
            "          curl -X POST -H \"x-certification-e2e-token: $T\" https://zevanory-certification.girolocal-rb.workers.dev/api/internal/certification/e2e/checkout\n")})
        h = t.hits()
        self.assertTrue(any(x["line"] == 12 and x["rule"] == "R4-SIGNED" for x in h),
                        f"NF09a production workers.dev name must be a production host: {h}")
        self.assertFalse(any(x["line"] == 13 for x in h),
                         f"NF09b the isolated certification Worker is not production: {h}")

    def test_nf10_syntax_check_is_not_execution(self):
        t = self.tree({
            ".github/workflows/a.yml": wf("          node --check scripts/never_run.mjs\n"),
            "scripts/never_run.mjs": ("await fetch('https://zevanory.api.br/api/webhooks/meta', "
                                      "{method: 'POST', headers: {'x-hub-signature-256': s}});\n")})
        h = t.hits()
        self.assertEqual(h, [], f"NF10a node --check does not execute the script: {h}")

    def test_nf11_allow_list_is_explicit_and_fail_closed(self):
        files = {".github/workflows/a.yml": wf(
            "          curl -X POST -H \"x-backup-token: $T\" https://zevanory.api.br/api/internal/backup/run\n"),
            ".github/workflows/b.yml": wf("          curl -fsS https://zevanory.api.br/api/release\n")}
        rc, out = self.tree(files, allow_doc([entry()])).main()
        self.assertEqual(rc, 0, "NF11a a complete R4 entry suppresses its hit: " + out)
        rc, out = self.tree(files, allow_doc([entry(), entry(file=".github/workflows/b.yml")])).main()
        self.assertEqual(rc, 2, "NF11b a stale entry fails the scan: " + out)
        rc, out = self.tree(files, allow_doc([entry(purpose="short")])).main()
        self.assertEqual(rc, 2, "NF11c a vague purpose fails the scan: " + out)
        rc, out = self.tree(files, allow_doc([entry(file=".github/workflows/b.yml", line_pattern="x-backup-token")])).main()
        self.assertNotEqual(rc, 0, "NF11d an entry for another file never suppresses a hit: " + out)
        rc, out = self.tree(files, allow_doc([entry(scope="all")])).main()
        self.assertEqual(rc, 2, "NF11e unknown keys fail the scan: " + out)
        missing = self.tree(files)
        missing.allow.unlink()
        rc, out = missing.main()
        self.assertEqual(rc, 2, "NF11f a missing allow-list fails the scan: " + out)
        legacy = self.tree(files, [{"file": ".github/workflows/a.yml", "line_pattern": "x-backup-token",
                                    "justification": "legacy v1 entry without the R4 conditions, must be refused"}])
        rc, out = legacy.main()
        self.assertEqual(rc, 2, "NF11g the v1 free-text allow-list is refused: " + out)

    def test_nf12_no_workflows_is_an_error(self):
        t = self.tree({"scripts/x.sh": "echo hi\n"})
        rc, out = t.main()
        self.assertEqual(rc, 2, "NF12a an empty workflow set must fail closed: " + out)

    def test_nf13_unresolved_signed_target_fails_closed(self):
        t = self.tree({".github/workflows/a.yml": wf(
            "          echo 'canonical https://zevanory.api.br'\n"
            "          curl -X POST -H \"x-hub-signature-256: sha256=$SIG\" -d @b.json \"$TARGET_URL\"\n")})
        h = t.hits()
        self.assertEqual(self.rules(h), {"R4-UNRESOLVED"},
                         f"NF13a a signed POST to an unprovable target in a production-naming file fails: {h}")

    def test_nf14_in_process_worker_fetch_is_not_network(self):
        t = self.tree({
            ".github/workflows/a.yml": wf("          node --test tests/inbound.test.mjs\n"),
            "tests/inbound.test.mjs": (
                "import worker from '../worker/main.mjs';\n"
                "const req = new Request('https://zevanory.api.br/api/webhooks/meta', {method: 'POST', "
                "headers: {'x-hub-signature-256': sig}, body});\n"
                "const res = await worker.fetch(req, env);\n"),
            "worker/main.mjs": "export default { async fetch(request, env) { return new Response('ok'); } };\n"})
        h = t.hits()
        self.assertEqual(h, [], f"NF14a worker.fetch(new Request(...)) is an in-process call: {h}")

    def test_nf15_unsigned_post_to_production_webhook_fails(self):
        t = self.tree({".github/workflows/a.yml": wf(
            "          wget -q --post-data '{}' https://zevanory.api.br/api/webhooks/hotmart -O /dev/null\n")})
        h = t.hits()
        self.assertEqual(self.rules(h), {"R4-INBOUND"}, f"NF15a forged unsigned inbound POST: {h}")

    def test_nf16_curl_data_without_method_is_post(self):
        t = self.tree({".github/workflows/a.yml": wf(
            "          curl -fsS -d '{}' https://zevanory.api.br/api/internal/owner/oauth/tiktok-access\n")})
        h = t.hits()
        self.assertEqual([x["method"] for x in h], ["POST"], f"NF16a curl -d implies POST: {h}")

    def test_nf17_signed_post_to_non_inbound_production_path_fails(self):
        t = self.tree({".github/workflows/a.yml": wf(
            "          curl -X POST -H \"stripe-signature: t=1,v1=$S\" https://controle.zevanory.api.br/api/commercial/tick\n")})
        h = t.hits()
        self.assertEqual(self.rules(h), {"R4-SIGNED"}, f"NF17a a signature header alone fails: {h}")


    def test_nf18_allow_entry_is_bound_to_endpoint_and_method(self):
        # Counter-proof (Sol 2b): a backup entry reused on another endpoint or with another method does not allow.
        other_endpoint = {".github/workflows/a.yml": wf(
            "          curl -X POST -H \"x-backup-token: $T\" https://zevanory.api.br/api/internal/backup/restore\n")}
        rc, out = self.tree(other_endpoint, allow_doc([entry()])).main()
        self.assertNotEqual(rc, 0, "NF18a backup entry on /api/internal/backup/restore must fail: " + out)
        other_method = {".github/workflows/a.yml": wf(
            "          curl -X PUT -H \"x-backup-token: $T\" https://zevanory.api.br/api/internal/backup/run\n")}
        rc, out = self.tree(other_method, allow_doc([entry()])).main()
        self.assertNotEqual(rc, 0, "NF18b backup entry used with PUT must fail: " + out)

    def test_nf19_allow_entry_requires_every_r4_condition(self):
        files = {".github/workflows/a.yml": wf(
            "          curl -X POST -H \"x-backup-token: $T\" https://zevanory.api.br/api/internal/backup/run\n")}
        for field in sorted(NF.ALLOW_REQUIRED):
            e = entry()
            del e[field]
            rc, out = self.tree(files, allow_doc([e])).main()
            self.assertEqual(rc, 2, f"NF19a missing {field} must fail the scan: " + out)
        bad_eff = entry()
        bad_eff["effects"] = dict(bad_eff["effects"], commercial_effect=True)
        rc, out = self.tree(files, allow_doc([bad_eff])).main()
        self.assertEqual(rc, 2, "NF19b a commercial effect is never allowable: " + out)
        rc, out = self.tree(files, allow_doc([entry(payload={"controlled": True, "writes": True, "idempotent": False,
                                                             "audit_trail": "fixture report key with counts only", "secrets_in_audit": False})])).main()
        self.assertEqual(rc, 2, "NF19c a non-idempotent write is refused: " + out)
        rc, out = self.tree(files, allow_doc([entry(identity={"principal": "ZEVANORY", "credential": "x-signature",
                                                              "impersonates": ["mercadopago"]})])).main()
        self.assertEqual(rc, 2, "NF19d an impersonated identity is refused: " + out)
        rc, out = self.tree(files, allow_doc([entry(risk_acceptance={"status": "ACCEPTED", "by": "", "at": "", "reference": ""})])).main()
        self.assertEqual(rc, 2, "NF19e risk acceptance must be explicit (by/at/reference): " + out)
        rc, out = self.tree(files, allow_doc([entry(handler_evidence=["worker/h.mjs:99"])])).main()
        self.assertEqual(rc, 2, "NF19f handler evidence must point at existing lines: " + out)
        rc, out = self.tree(files, allow_doc([entry(counter_proof_test="tests/t_counter.py::test_missing")])).main()
        self.assertEqual(rc, 2, "NF19g the counter-proof test must exist: " + out)

    def test_nf20_signed_hits_are_never_allowable(self):
        files = {".github/workflows/a.yml": wf(
            "          curl -X POST -H \"x-backup-token: $T\" -H \"x-hub-signature-256: $S\" https://zevanory.api.br/api/internal/backup/run\n")}
        rc, out = self.tree(files, allow_doc([entry()])).main()
        self.assertNotEqual(rc, 0, "NF20a a complete entry cannot allow a signed request: " + out)

    def test_nf21_financial_workflows_need_an_independent_owner_gate(self):
        stripe = ".github/workflows/financial-e2e-stripe.yml"
        plain = {stripe: wf("          echo run\n")}
        gated = {stripe: wf("          echo run\n", gate="R4_STRIPE")}
        g = {"workflow": stripe, "variable": "R4_STRIPE", "require_job_if_false": False, "status": "ENFORCED", "reference": "fixture"}
        h = self.tree(plain).hits()
        self.assertTrue(any(x["rule"] == "R4-GATE" for x in h), f"NF21a unregistered financial workflow: {h}")
        h = self.tree(plain, allow_doc(gates=[g])).hits()
        self.assertTrue(any(x["rule"] == "R4-GATE" for x in h), f"NF21b registered gate but no gate step: {h}")
        h = self.tree(gated, allow_doc(gates=[g])).hits()
        self.assertEqual(h, [], f"NF21c gate step first in every job passes: {h}")
        h = self.tree(gated, allow_doc(gates=[dict(g, status="PENDING_FIX_PR")])).hits()
        self.assertTrue(any(x["rule"] == "R4-GATE" for x in h), f"NF21d a stale PENDING gate fails: {h}")
        exact = ".github/workflows/mercadopago-exact-sha-recovery.yml"
        ge = {"workflow": exact, "variable": "R4_MP", "require_job_if_false": True, "status": "ENFORCED", "reference": "fixture"}
        h = self.tree({exact: wf("          echo run\n", gate="R4_MP")}, allow_doc(gates=[ge])).hits()
        self.assertTrue(any(x["rule"] == "R4-GATE" for x in h), f"NF21e retired job must keep if: false: {h}")
        h = self.tree({exact: wf("          echo run\n", gate="R4_MP", job_if="${{ false }}")}, allow_doc(gates=[ge])).hits()
        self.assertEqual(h, [], f"NF21f retired and gated passes: {h}")

    def test_nf22_open_real_risk_needs_its_gate_and_is_never_accepted_here(self):
        signed = "          curl -X POST -H \"x-hub-signature-256: $S\" https://zevanory.api.br/api/webhooks/meta\n"
        rc, out = self.tree({".github/workflows/a.yml": wf(signed)}, allow_doc(opened=[opened()])).main()
        self.assertEqual(rc, 1, "NF22a an open risk without its gate fails: " + out)
        rc, out = self.tree({".github/workflows/a.yml": wf(signed, gate="R4_FIXTURE_OWNER_APPROVAL")},
                            allow_doc(opened=[opened()])).main()
        self.assertEqual(rc, 0, "NF22b gated open risk passes: " + out)
        self.assertIn("R4_OPEN_RISK", out, "NF22c open risks are always reported")
        rc, out = self.tree({".github/workflows/a.yml": wf(signed, gate="R4_FIXTURE_OWNER_APPROVAL")},
                            allow_doc(opened=[opened(risk_acceptance={"status": "ACCEPTED", "by": "owner", "at": "2026-10-24", "reference": "chat"})])).main()
        self.assertEqual(rc, 2, "NF22d acceptance is a separate decision, never recorded on an open risk: " + out)


if __name__ == "__main__":
    unittest.main()
