#!/usr/bin/env python3
"""Mutantes de scripts/ops/resend_receiving_key_certify.py: cada um remove uma parte da prova e a suíte
tests/test_resend_receiving_key_certify.py precisa FALHAR. Sem rede, sem segredo. Saída final:
MUTANTS suite=resend_receiving_key total=N killed=N survived=0
"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "scripts/ops/resend_receiving_key_certify.py"

MUTANTS = [
    ("sem_leitura_do_item_so_lista", 'status, body = get("/emails/receiving/" + urllib.parse.quote(ref, safe=""), key)',
     'status, body = 200, {"to": ["suporte@zevanory.api.br"]}'),
    ("404_aceito", 'if status == 404:\n        return NAO_COMPROVADO', 'if status == 404 and False:\n        return NAO_COMPROVADO'),
    ("item_qualquer_2xx", "if status != 200:\n        return NAO_COMPROVADO, \"item_not_200\"",
     "if not 200 <= status < 300:\n        return NAO_COMPROVADO, \"item_not_200\""),
    ("sem_checagem_de_dominio", 'if not facts["domain_match"]:\n        return NAO_COMPROVADO', 'if False:\n        return NAO_COMPROVADO'),
    ("dominio_por_sufixo", 'return EXPECTED_DOMAIN in _domains(detail.get("to"))',
     'return any(d.endswith(EXPECTED_DOMAIN) for d in _domains(detail.get("to")))'),
    ("dominio_em_qualquer_campo", 'return EXPECTED_DOMAIN in _domains(detail.get("to"))',
     'return EXPECTED_DOMAIN in _domains(detail.get("to")) + _domains(detail.get("cc")) + _domains(detail.get("received_for"))'),
    ("dominio_substring", 'return EXPECTED_DOMAIN in _domains(detail.get("to"))',
     'return EXPECTED_DOMAIN in str(detail.get("to"))'),
    ("sem_referencia_passa", 'if not ref:\n        return NAO_COMPROVADO, "reference_missing", facts', 'if False:\n        pass'),
    ("referencia_sem_validacao", "if not ID_RE.fullmatch(ref):", "if False:"),
    ("sem_precondicao_lista", 'if status != 200:\n        return NAO_COMPROVADO, "list_not_200", facts', 'if False:\n        pass'),
    ("grava_mesmo_sem_prova", "if verdict != COMPROVADO:\n        out(\"WORKER_KV_RESEND_RECEIVING_KEY=UNCHANGED\")\n        return 2",
     "if verdict != COMPROVADO:\n        out(\"WORKER_KV_RESEND_RECEIVING_KEY=UNCHANGED\")\n        writer(key)\n        return 2"),
    ("sai_zero_sem_prova", "        return 2\n", "        return 0\n"),
    ("falha_de_gravacao_vira_sucesso", "        return 3\n", "        return 0\n"),
    ("loga_id_de_referencia", 'out("RESEND_RECEIVING_REFERENCE_STATUS=%s" % facts["item_status"])',
     'out("RESEND_RECEIVING_REFERENCE_STATUS=%s ref=%s" % (facts["item_status"], ref))'),
    ("chave_em_argv", '"--path", path, "--remote"]', '"--path", path, "--remote", key]'),
    ("tempfile_legivel", "fd, path = tempfile.mkstemp()", "fd, path = tempfile.mkstemp(); os.chmod(path, 0o644)"),
    ("tempfile_nao_removido", "            os.remove(path)", "            pass"),
    ("http_erro_vira_200", "return e.code, None", "return 200, None"),
]


def run_suite(module_path):
    env = dict(os.environ, CERT_MODULE_PATH=str(module_path), PYTHONDONTWRITEBYTECODE="1")
    r = subprocess.run([sys.executable, "-m", "unittest", "tests.test_resend_receiving_key_certify"],
                       cwd=ROOT, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    return r.returncode


def main():
    base = SRC.read_text()
    if run_suite(SRC) != 0:
        print("BASELINE_FAILED"); return 1
    killed = survived = 0
    with tempfile.TemporaryDirectory() as d:
        for name, old, new in MUTANTS:
            if base.count(old) != 1:
                print(f"MUTANT {name} NOT_APPLICABLE"); survived += 1; continue
            p = pathlib.Path(d) / f"{name}.py"
            p.write_text(base.replace(old, new, 1))
            if run_suite(p) != 0:
                killed += 1; print(f"MUTANT {name} KILLED")
            else:
                survived += 1; print(f"MUTANT {name} SURVIVED")
    print(f"MUTANTS suite=resend_receiving_key total={len(MUTANTS)} killed={killed} survived={survived}")
    return 0 if survived == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
