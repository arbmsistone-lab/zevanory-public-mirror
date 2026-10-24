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


def wf(steps, env=""):
    """A minimal workflow whose single job runs the given run-block lines (already indented 10 spaces)."""
    return ("name: fixture\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  j:\n"
            "    runs-on: ubuntu-latest\n" + (("    env:\n" + env) if env else "") +
            "    steps:\n      - name: step\n        run: |\n" + steps)


class Tree:
    def __init__(self, files, allow=None):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for rel, text in files.items():
            p = self.root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        self.allow = self.root / "allow.json"
        self.allow.write_text(json.dumps(allow if allow is not None else []), encoding="utf-8")

    def hits(self):
        found, _ = NF.scan(self.root)
        return NF.apply_allow(found, NF.load_allow(self.allow))

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
        ok = self.tree(files, [{"file": ".github/workflows/a.yml", "line_pattern": "/api/internal/backup/run",
                                "justification": GOOD_JUSTIFICATION}])
        rc, out = ok.main()
        self.assertEqual(rc, 0, "NF11a an explicit justified entry suppresses its hit: " + out)
        stale = self.tree(files, [{"file": ".github/workflows/a.yml", "line_pattern": "/api/internal/backup/run",
                                   "justification": GOOD_JUSTIFICATION},
                                  {"file": ".github/workflows/b.yml", "line_pattern": "nothing-here",
                                   "justification": GOOD_JUSTIFICATION}])
        rc, out = stale.main()
        self.assertEqual(rc, 2, "NF11b a stale entry fails the scan: " + out)
        short = self.tree(files, [{"file": ".github/workflows/a.yml", "line_pattern": "/api/internal/backup/run",
                                   "justification": "ok"}])
        rc, out = short.main()
        self.assertEqual(rc, 2, "NF11c an unjustified entry fails the scan: " + out)
        other = self.tree(files, [{"file": ".github/workflows/b.yml", "line_pattern": "/api/internal/backup/run",
                                   "justification": GOOD_JUSTIFICATION}])
        rc, out = other.main()
        self.assertNotEqual(rc, 0, "NF11d an entry for another file never suppresses a hit: " + out)
        extra = self.tree(files, [{"file": ".github/workflows/a.yml", "line_pattern": "/api/internal/backup/run",
                                   "justification": GOOD_JUSTIFICATION, "scope": "all"}])
        rc, out = extra.main()
        self.assertEqual(rc, 2, "NF11e unknown keys fail the scan: " + out)
        missing = self.tree(files)
        missing.allow.unlink()
        rc, out = missing.main()
        self.assertEqual(rc, 2, "NF11f a missing allow-list fails the scan: " + out)

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


if __name__ == "__main__":
    unittest.main()
