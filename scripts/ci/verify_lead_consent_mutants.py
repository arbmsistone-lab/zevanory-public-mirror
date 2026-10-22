#!/usr/bin/env python3
"""Prove each consent-flow mutant is killed by its expected E2E assertion."""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKER = pathlib.Path("worker/lead-magnet.mjs")
TEST = "tests/integration/lead-consent-postgres.test.mjs"
CASES = [
    (
        "token reutilizável",
        [
            ("token_hash=null, token_expires_at=null,", "token_hash=token_hash, token_expires_at=token_expires_at,"),
            ("and status='pending' returning email", "returning email"),
        ],
        "double opt-in inicia a sequência uma vez; GET não confirma e token não reutiliza",
    ),
    (
        "token sem expiração",
        [("and token_expires_at > now()", "")],
        "token expirado não confirma o lead nem envia conteúdo",
    ),
    (
        "opt-out ignorado",
        [
            (
                "delete from zevanory_leads where ${match.column}=$1 returning email, subject_ref, consent_version",
                "select email, subject_ref, consent_version from zevanory_leads where ${match.column}=$1",
            )
        ],
        "opt-out de um clique é idempotente e impede qualquer envio posterior",
    ),
    (
        "envio antes da confirmação",
        [
            (
                '  const sent = await sendEmail(env, { to: email, subject: "Confirme seu e-mail para receber o checklist",',
                '  await sendEmail(env, { to: email, subject: "mutante prematuro", text: "conteúdo antes da confirmação" });\n'
                '  const sent = await sendEmail(env, { to: email, subject: "Confirme seu e-mail para receber o checklist",',
            )
        ],
        "registra data/hora, texto aceito, versão e origem do consentimento no PostgreSQL",
    ),
    (
        "consentimento sem texto",
        [
            (
                'const CONSENT_TEXT = "Quero receber o checklist e até 2 e-mails com dicas e os produtos da ZEVANORY. Posso cancelar a qualquer momento. Li a Política de Privacidade."' + ";",
                'const CONSENT_TEXT = "";',
            )
        ],
        "registra data/hora, texto aceito, versão e origem do consentimento no PostgreSQL",
    ),
    (
        "consentimento sem versão",
        [('const CONSENT_VERSION = "lead-magnet-v1-2026-10-07";', 'const CONSENT_VERSION = "";')],
        "registra data/hora, texto aceito, versão e origem do consentimento no PostgreSQL",
    ),
]


def run_test(directory, env, test_name=None):
    command = ["node", "--test", "--test-reporter=tap"]
    if test_name:
        command.extend(["--test-name-pattern", re.escape(test_name)])
    command.append(TEST)
    return subprocess.run(
        command,
        cwd=directory,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def die(message):
    print(f"INCONCLUSIVE: {message}", file=sys.stderr)
    raise SystemExit(1)


def main():
    env = dict(os.environ)
    if not env.get("P08_PG_HOST"):
        die("P08_PG_HOST ausente; PostgreSQL real efêmero obrigatório")

    with tempfile.TemporaryDirectory(prefix="p08-lead-mutants-") as tmp:
        sandbox = pathlib.Path(tmp)
        shutil.copytree(ROOT / "worker", sandbox / "worker")
        shutil.copytree(ROOT / "db/migrations", sandbox / "db/migrations")
        test_dest = sandbox / TEST
        test_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / TEST, test_dest)

        baseline = run_test(sandbox, env)
        if any(
            marker not in baseline.stdout
            for marker in ("# tests 5", "# pass 5", "# skipped 0", "# fail 0", "# cancelled 0")
        ) or baseline.returncode != 0:
            die("suíte base não passou com 5/5 e zero pulados\n" + baseline.stdout)

        original = (sandbox / WORKER).read_text(encoding="utf-8")
        for name, edits, expected_test in CASES:
            mutated = original
            for old, new in edits:
                if mutated.count(old) != 1:
                    die(f"mutação {name!r} não encontrou exatamente uma ocorrência de {old!r}")
                mutated = mutated.replace(old, new, 1)

            (sandbox / WORKER).write_text(mutated, encoding="utf-8")
            result = run_test(sandbox, env, expected_test)
            failed_tests = [line for line in result.stdout.splitlines() if line.startswith("not ok ")]
            if (
                result.returncode == 0
                or len(failed_tests) != 1
                or not failed_tests[0].endswith(f" - {expected_test}")
                or "ERR_ASSERTION" not in result.stdout
            ):
                die(f"mutante {name!r} não morreu pela asserção esperada\n{result.stdout}")
            print(f"KILLED por asserção: {name}")
            (sandbox / WORKER).write_text(original, encoding="utf-8")

    print(f"MUTANTES_KILLED={len(CASES)}/{len(CASES)}")


if __name__ == "__main__":
    main()
