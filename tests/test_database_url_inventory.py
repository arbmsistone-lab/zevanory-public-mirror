"""B07 T4: contrato offline de scripts/ops/database_url_inventory.py e .github/workflows/database-url-consumer-inventory.yml.

Só URLs FALSAS (nunca reais). Prova: só hashes saem no log (nunca usuário/senha/banco/host/endpoint), host direto e do
pooler do mesmo endpoint dão o mesmo hash, divergência falha com o nome do consumidor, a tabela de consumidores bate
exatamente com os workflows que leem *DATABASE_URL por Environment. (O hash do Worker, worker/database-identity.mjs,
é comparado com o do Python em tests/test_database_identity_worker.py — commit classe B separado.)
Mutantes: scripts/ci/mutants_database_url_inventory.py.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(os.environ.get("DBINV_SCRIPT", ROOT / "scripts/ops/database_url_inventory.py"))
WORKFLOW = Path(os.environ.get("DBINV_WORKFLOW", ROOT / ".github/workflows/database-url-consumer-inventory.yml"))

# Vetores FALSOS. NEW = "zevanory-db-2" fictício; OLD = projeto antigo fictício; CERT = certificação fictícia.
NEW_HOST = "ep-fake-new-000111.sa-east-1.aws.neon.tech"
NEW = f"postgresql://fakeuser:FAKE_PASSWORD_1@{NEW_HOST}/fakedb?sslmode=require"
NEW_POOLED = "postgres://pooluser7:FAKE_PASSWORD_2@EP-FAKE-NEW-000111-POOLER.sa-east-1.aws.neon.tech.:5432/x"
OLD = "postgresql://fakeuser:FAKE_PASSWORD_3@ep-fake-old-999888.us-east-2.aws.neon.tech/fakedb"
CERT = "postgresql://certuser9:FAKE_PASSWORD_4@ep-fake-cert-555.us-east-2.aws.neon.tech/certdb"
NEW_SHA = hashlib.sha256(NEW_HOST.encode()).hexdigest()
SECRETS = ("fakeuser", "pooluser7", "certuser9", "FAKE_PASSWORD", "fakedb", "certdb", "ep-fake", "neon.tech", "sslmode")


def run(args, env=None, curl_body=None, curl_code="200"):
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        if curl_body is not None:
            (d / "body").write_text(curl_body)
            (d / "curl").write_text("#!/usr/bin/env bash\necho \"$*\" > %s/args\nwhile [ $# -gt 0 ]; do [ \"$1\" = -o ] && cp %s/body \"$2\"; shift; done\nprintf %s\n"
                                    % (d, d, curl_code))
            (d / "curl").chmod(0o755)
        base = {"PATH": f"{d}:{os.environ['PATH']}", "PYTHONDONTWRITEBYTECODE": "1", "RUNNER_TEMP": str(d),
                "EXPECTED_HOST_SHA256": NEW_SHA}
        base.update(env or {})
        p = subprocess.run([sys.executable, str(SCRIPT)] + args, env=base, capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=30)
        a = (d / "args").read_text() if (d / "args").exists() else ""
        return p.returncode, p.stdout + p.stderr, a


def rows(out):
    return [dict(kv.split("=", 1) for kv in l.split()[1:]) for l in out.splitlines() if l.startswith("DBURL_CONSUMER ")]


class Identity(unittest.TestCase):
    def ident(self, url, gha=False):
        rc, out, _ = run(["consumers", "gh-pages-automacao"], {"DBINV_DATABASE_URL": url, **({"GITHUB_ACTIONS": "true"} if gha else {})})
        return rc, out, rows(out)[0]

    def test_pooler_and_direct_host_of_the_same_endpoint_hash_equal_and_only_hashes_are_printed(self):
        for url, pooled in ((NEW, "no"), (NEW_POOLED, "yes")):
            rc, out, r = self.ident(url)
            self.assertEqual(rc, 0, out)
            self.assertEqual(r["host_sha256"], NEW_SHA)
            self.assertEqual(r["endpoint_sha256"], hashlib.sha256(b"ep-fake-new-000111").hexdigest())
            self.assertEqual((r["pooled"], r["status"]), (pooled, "MATCH"))
            for s in SECRETS:
                self.assertNotIn(s, out.lower() if s.islower() else out, s)

    def test_under_actions_host_endpoint_user_and_password_are_masked(self):
        rc, out, _ = self.ident(NEW, gha=True)
        self.assertEqual(rc, 0, out)
        masks = {l[len("::add-mask::"):] for l in out.splitlines() if l.startswith("::add-mask::")}
        self.assertEqual(masks, {NEW_HOST, "ep-fake-new-000111", "fakeuser", "FAKE_PASSWORD_1"})
        self.assertFalse([l for l in out.splitlines() if not l.startswith("::add-mask::") and "FAKE_PASSWORD" in l])

    def test_non_postgres_or_hostless_values_are_unparseable_and_fail(self):
        for bad in ("not a url", "postgres://", "https://ep-x.neon.tech/db", "postgresql://u:p@/db",
                    "postgresql://u:p@[::1/db", "postgresql://u:p@h_o_st/db"):
            rc, out, r = self.ident(bad)
            self.assertEqual(rc, 1, bad)
            self.assertEqual((r["status"], r["host_sha256"]), ("UNPARSEABLE", "none"), bad)

    def test_non_neon_host_has_no_endpoint_hash(self):
        rc, out, r = self.ident("postgresql://u:p@db.example.internal/x")
        self.assertEqual(r["endpoint_sha256"], "none")
        self.assertEqual(r["host_sha256"], hashlib.sha256(b"db.example.internal").hexdigest())
        self.assertEqual((rc, r["status"]), (1, "MISMATCH"))


class Consumers(unittest.TestCase):
    def test_all_consumers_on_the_new_database_pass_with_exact_rows(self):
        cases = {"producao-critica": {"DBINV_DATABASE_URL": NEW, "DBINV_RESTORE_TARGET_DATABASE_URL": NEW_POOLED},
                 "gh-pages-automacao": {"DBINV_DATABASE_URL": NEW_POOLED},
                 "sandbox-financial-approved": {"DBINV_CERTIFICATION_DATABASE_URL": CERT}}
        want = {"producao-critica": [("DATABASE_URL", "central-production-deploy.yml,financial-ddl-readonly-check.yml,production-secret-readiness.yml", "MATCH"),
                                     ("RESTORE_TARGET_DATABASE_URL", "restore-new-database.yml", "MATCH")],
                "gh-pages-automacao": [("DATABASE_URL", "plan-probe.yml", "MATCH")],
                "sandbox-financial-approved": [("CERTIFICATION_DATABASE_URL", "certification-isolated-deploy.yml", "ISOLATED")]}
        for env, secrets in cases.items():
            rc, out, _ = run(["consumers", env], secrets)
            self.assertEqual(rc, 0, out)
            self.assertEqual([(r["secret"], r["workflows"], r["status"]) for r in rows(out)], want[env])
            n_wf = sum(len(w.split(",")) for _, w, _ in want[env])
            self.assertIn(f"DBURL_INVENTORY=PASS env={env} secret_bindings={len(want[env])} effective_consumers={n_wf}", out)
            for s in SECRETS:
                self.assertNotIn(s, out)

    def test_any_divergence_fails_naming_the_consumer_and_still_reports_all(self):
        rc, out, _ = run(["consumers", "producao-critica"], {"DBINV_DATABASE_URL": OLD, "DBINV_RESTORE_TARGET_DATABASE_URL": NEW})
        self.assertEqual(rc, 1)
        self.assertEqual([r["status"] for r in rows(out)], ["MISMATCH", "MATCH"])
        self.assertIn("DBURL_INVENTORY_FAIL: env=producao-critica DATABASE_URL[central-production-deploy.yml,"
                      "financial-ddl-readonly-check.yml,production-secret-readiness.yml]=MISMATCH", out)
        self.assertNotIn("DBURL_INVENTORY=PASS", out)
        rc, out, _ = run(["consumers", "producao-critica"], {"DBINV_DATABASE_URL": NEW})
        self.assertEqual(rc, 1)
        self.assertIn("RESTORE_TARGET_DATABASE_URL[restore-new-database.yml]=ABSENT", out)
        rc, out, _ = run(["consumers", "sandbox-financial-approved"], {"DBINV_CERTIFICATION_DATABASE_URL": NEW_POOLED})
        self.assertEqual(rc, 1)
        self.assertIn("CERTIFICATION_DATABASE_URL[certification-isolated-deploy.yml]=NOT_ISOLATED", out)

    def test_bad_input_is_refused_before_reading_any_consumer(self):
        for exp in ("", "abc", NEW_SHA.upper()[:-1] + "Z", NEW_SHA + "0"):
            rc, out, _ = run(["consumers", "gh-pages-automacao"], {"EXPECTED_HOST_SHA256": exp, "DBINV_DATABASE_URL": NEW})
            self.assertEqual(rc, 1, exp)
            self.assertEqual(rows(out), [], exp)
        rc, out, _ = run(["consumers", "outro-env"], {"DBINV_DATABASE_URL": NEW})
        self.assertEqual((rc, rows(out)), (1, []))
        rc, out, _ = run(["consumers"])
        self.assertEqual(rc, 1)

    def test_worker_health_field_is_compared(self):
        cases = [(json.dumps({"ready": True, "database_host_sha256": NEW_SHA}), "200", 0, "MATCH"),
                 (json.dumps({"ready": False, "database_host_sha256": NEW_SHA}), "503", 0, "MATCH"),
                 (json.dumps({"database_host_sha256": "0" * 64}), "200", 1, "MISMATCH"),
                 (json.dumps({"ready": True}), "200", 1, "MISSING_FIELD"),
                 (json.dumps({"database_host_sha256": "postgres://u:FAKE_PASSWORD_9@h/db"}), "200", 1, "INVALID_FIELD"),
                 ("<html>", "200", 1, "HTTP_200"), ("", "000", 1, "HTTP_000"),
                 (json.dumps({"database_host_sha256": NEW_SHA}), "302", 1, "HTTP_302")]
        for body, code, rc_want, status in cases:
            rc, out, args = run(["worker"], curl_body=body, curl_code=code)
            self.assertEqual((rc, rows(out)[0]["status"]), (rc_want, status), body)
            self.assertIn("https://zevanory.api.br/api/health", args)
            self.assertNotIn("FAKE_PASSWORD", out)


class WorkflowContract(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()
        self.doc = yaml.safe_load(self.text)

    def test_manual_read_only_one_job_per_environment(self):
        self.assertEqual(list(self.doc[True]), ["workflow_dispatch"])
        self.assertEqual(self.doc["permissions"], {"contents": "read"})
        jobs = self.doc["jobs"]
        self.assertEqual(list(jobs), ["producao-critica", "gh-pages-automacao", "sandbox-financial-approved", "cloudflare-worker", "verdict"])
        sys.path.insert(0, str(SCRIPT.parent))
        import importlib.util
        spec = importlib.util.spec_from_file_location("dbinv", SCRIPT)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        for env, table in m.CONSUMERS.items():
            job = jobs[env]
            self.assertEqual(job["environment"], env)
            self.assertNotIn("permissions", job)
            step = job["steps"][-1]
            self.assertEqual(step["run"], f"python3 scripts/ops/database_url_inventory.py consumers {env}")
            self.assertEqual({k: v for k, v in step["env"].items() if k.startswith("DBINV_")},
                             {f"DBINV_{s}": "${{ secrets.%s }}" % s for s in table})
            self.assertEqual(step["env"]["EXPECTED_HOST_SHA256"], "${{ inputs.expected_host_sha256 }}")
        self.assertNotIn("environment", jobs["cloudflare-worker"])
        self.assertNotIn("secrets", json.dumps(jobs["cloudflare-worker"]))
        self.assertNotIn("secrets", json.dumps(jobs["verdict"]))
        self.assertEqual(jobs["verdict"]["needs"], list(m.CONSUMERS) + ["cloudflare-worker"])
        self.assertEqual(jobs["verdict"]["if"], "always() && github.ref == 'refs/heads/gh-pages'")
        self.assertIn('"$R_PROD$R_AUTO$R_CERT$R_WORKER" != "successsuccesssuccesssuccess"', self.text)
        # Nada além de ler: nenhum deploy, nenhuma conexão a banco, input nunca interpolado em `run`.
        for w in ("wrangler", "psql", "pg@", "npm install", "write", "curl -X"):
            self.assertNotIn(w, self.text)
        self.assertFalse(re.search(r"run:.*\$\{\{\s*inputs", self.text))

    def test_consumer_table_matches_every_workflow_that_reads_a_database_url_secret(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("dbinv2", SCRIPT)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        found = {}
        for wf in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            if wf.name == "database-url-consumer-inventory.yml":
                continue
            doc = yaml.safe_load(wf.read_text())
            for job in (doc.get("jobs") or {}).values():
                env = job.get("environment")
                env = env.get("name") if isinstance(env, dict) else env
                for s in sorted(set(re.findall(r"secrets\.([A-Z_]*DATABASE_URL)\b", json.dumps(job)))):
                    found.setdefault(env, {}).setdefault(s, set()).add(wf.name)
        table = {env: {s: set(w) for s, (w, _) in t.items()} for env, t in m.CONSUMERS.items()}
        self.assertEqual(found, table)
        # Números exatos (auditoria Sol): 5 vínculos de segredo e 7 consumidores efetivos, contando o Worker.
        bindings = sum(len(t) for t in found.values()) + 1
        consumers = len({w for t in found.values() for ws in t.values() for w in ws}) + 1
        self.assertEqual((bindings, consumers), (5, 7))
        self.assertEqual((m.SECRET_BINDINGS, m.EFFECTIVE_CONSUMERS), (5, 7))
        verdict = (ROOT / ".github/workflows/database-url-consumer-inventory.yml").read_text()
        self.assertIn('echo "DBURL_VERDICT=PASS secret_bindings=5 effective_consumers=7"', verdict)
        self.assertNotRegex(verdict, r"DBURL_VERDICT=PASS consumers=")


if __name__ == "__main__":
    unittest.main()
