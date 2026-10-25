#!/usr/bin/env python3
"""Mutantes causais de scripts/ops/resend_receiving_key_certify.py, classificados pelo classificador COMPARTILHADO
scripts/ci/mutant_classifier.py (#901, sem modificação), conforme a regra R5 do Roteiro Mestre v4.7.

Cada mutante remove uma parte da prova numa CÓPIA temporária do certificador (âncora exata e única; âncora ausente ou
repetida => anchor_ok=False => INCONCLUSIVE, nunca pulada) e roda tests/test_resend_receiving_key_certify.py contra
ela via CERT_MODULE_PATH. A suíte Python roda sob um emissor TAP (``--tap``) no formato do `node --test` (um ponto por
teste, bloco YAML com error/name/code; falhas de subTest são somadas ao ponto do teste), para que o parser, as
contagens exatas e a detecção de infraestrutura do classificador valham sem mudança.

Expectativas: por mutante, 1-3 PRIMÁRIAS = teste RKnn + marcador [RKnn.k] da asserção que codifica a regra quebrada
e é a PRIMEIRA a falhar naquele teste; SECUNDÁRIAS só com justificativa; mais de 4 testes exige broad_reason. Foram
escritas por RACIOCÍNIO sobre cada mutação (qual regra quebra, qual asserção a codifica), antes de rodá-la, nunca
copiando falhas observadas. KILLED só com asserção PRIMÁRIA casada dentro do bloco `not ok`; falha só em
secundária, falha alheia, queda, timeout, TAP incompleto ou contagem diferente => INCONCLUSIVE (nunca conta como
morto). Total da baseline fixado em 21. Sem rede, sem segredo; o original nunca é alterado (hash conferido).

Exit (aggregate): 0 todos KILLED; 1 SURVIVED; 2 baseline/config inválida; 3 INCONCLUSIVE.
Saída final: MUTANTS suite=resend_receiving_key total=N killed=N survived=0 inconclusive=0
Uso: python3 scripts/ci/mutants_resend_receiving_key.py [--jsonl SAIDA]
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import time
import traceback
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
import mutant_classifier as mc  # noqa: E402  (#901, sem modificação)

SRC = REPO / "scripts/ops/resend_receiving_key_certify.py"
TEST_MODULE = "tests.test_resend_receiving_key_certify"
BASELINE_TOTAL = 21

# Testes que recusam (assertRefused: [t.1] código 2, [t.2] KV intocado, [t.3] motivo, [t.4] UNCHANGED, [t.5] sem SET).
REFUSING = ["RK01", "RK02", "RK03", "RK04", "RK05", "RK06", "RK07", "RK08", "RK09", "RK10"]


def P(test, label):
    return {"test_pattern": test, "assertion_pattern": label}


def S(test, label, why):
    return {"test_pattern": test, "assertion_pattern": label, "justification": why}


# id -> (âncora, substituição, expectativas). Raciocínio por mutante no comentário acima de cada um.
MUTANTS = {
    # O item de referência não é lido: toda leitura do item vira 200 com `to` em zevanory.api.br. Quebra a prova 2
    # (outra conta = 404) e, por tabela, toda recusa que dependia do status ou do corpo do item: cada um desses
    # testes passa a receber código 0 e falha no primeiro assert de assertRefused.
    "sem_leitura_do_item_so_lista": (
        'status, body = get("/emails/receiving/" + urllib.parse.quote(ref, safe=""), key)',
        'status, body = 200, {"to": ["suporte@zevanory.api.br"]}',
        {"primary": [P("RK01", "RK01.1"), P("RK09", "RK09.1")],
         "secondary": [S("RK02", "RK02.1", "o corpo do item fixo traz zevanory.api.br, então o domínio errado passa"),
                       S("RK03", "RK03.1", "o corpo do item fixo ignora os domínios sósia do fake"),
                       S("RK04", "RK04.1", "o corpo do item fixo ignora o `to` de outro domínio"),
                       S("RK10", "RK10.1", "o corpo do item fixo substitui o corpo ilegível")],
         "broad_reason": "sem ler o item, todas as recusas baseadas no status ou no corpo do item viram aceite"}),
    # 404 deixa de ter motivo próprio: cai em item_not_200. Código e KV continuam certos; só o motivo muda.
    "404_aceito": (
        'if status == 404:\n        return NAO_COMPROVADO', 'if status == 404 and False:\n        return NAO_COMPROVADO',
        {"primary": [P("RK01", "RK01.3")]}),
    # 201 passa como sucesso do item; o fake não devolve corpo para status != 200, então a recusa vira
    # domain_mismatch: código 2 e KV intactos, motivo errado no subTest status=201.
    "item_qualquer_2xx": (
        "if status != 200:\n        return NAO_COMPROVADO, \"item_not_200\"",
        "if not 200 <= status < 300:\n        return NAO_COMPROVADO, \"item_not_200\"",
        {"primary": [P("RK09", "RK09.3")]}),
    # Sem checagem de domínio: qualquer `to` é aceito e grava (código 0).
    "sem_checagem_de_dominio": (
        'if not facts["domain_match"]:\n        return NAO_COMPROVADO', 'if False:\n        return NAO_COMPROVADO',
        {"primary": [P("RK02", "RK02.1"), P("RK03", "RK03.1"), P("RK04", "RK04.1")],
         "secondary": [S("RK10", "RK10.1", "o corpo ilegível só era recusado pela checagem de domínio")]}),
    # Domínio por sufixo: evil.zevanory.api.br e xzevanory.api.br passam (sósias do RK03).
    "dominio_por_sufixo": (
        'return EXPECTED_DOMAIN in _domains(detail.get("to"))',
        'return any(d.endswith(EXPECTED_DOMAIN) for d in _domains(detail.get("to")))',
        {"primary": [P("RK03", "RK03.1")]}),
    # cc e received_for passam a contar: o RK04 (domínio só em cc/received_for) é aceito.
    "dominio_em_qualquer_campo": (
        'return EXPECTED_DOMAIN in _domains(detail.get("to"))',
        'return EXPECTED_DOMAIN in _domains(detail.get("to")) + _domains(detail.get("cc")) + _domains(detail.get("received_for"))',
        {"primary": [P("RK04", "RK04.1")]}),
    # Substring no repr do `to`: sósias que contêm "zevanory.api.br" passam (RK03); como o repr não é normalizado,
    # o endereço em maiúsculas do RK12 deixa de casar e a chave boa é recusada.
    "dominio_substring": (
        'return EXPECTED_DOMAIN in _domains(detail.get("to"))',
        'return EXPECTED_DOMAIN in str(detail.get("to"))',
        {"primary": [P("RK03", "RK03.1")],
         "secondary": [S("RK12", "RK12.1", "a substring é sensível a maiúsculas; 'SUPORTE@Zevanory.Api.Br' deixa de casar")]}),
    # Referência vazia não tem mais motivo próprio: cai na validação do formato (reference_invalid).
    "sem_referencia_passa": (
        'if not ref:\n        return NAO_COMPROVADO, "reference_missing", facts', 'if False:\n        pass',
        {"primary": [P("RK05", "RK05.3")]}),
    # Formato da referência não validado: ids inválidos chegam ao HTTP; o fake responde 404 => motivo errado.
    "referencia_sem_validacao": (
        "if not ID_RE.fullmatch(ref):", "if False:",
        {"primary": [P("RK06", "RK06.3")]}),
    # Sem pré-condição da lista: lista != 200 com item bom grava (código 0).
    "sem_precondicao_lista": (
        'if status != 200:\n        return NAO_COMPROVADO, "list_not_200", facts', 'if False:\n        pass',
        {"primary": [P("RK08", "RK08.1")]}),
    # Grava a chave mesmo sem prova (mantendo o código 2): todo teste de recusa falha no KV intocado [t.2]; no RK17
    # o wrangler_put falso levanta "[RK17.3] sem KV".
    "grava_mesmo_sem_prova": (
        "if verdict != COMPROVADO:\n        out(\"WORKER_KV_RESEND_RECEIVING_KEY=UNCHANGED\")\n        return 2",
        "if verdict != COMPROVADO:\n        out(\"WORKER_KV_RESEND_RECEIVING_KEY=UNCHANGED\")\n        writer(key)\n        return 2",
        {"primary": [P("RK01", "RK01.2"), P("RK07", "RK07.2"), P("RK08", "RK08.2")],
         "secondary": [S(t, t + ".2", "toda recusa passa a escrever no KV") for t in REFUSING if t not in ("RK01", "RK07", "RK08")]
         + [S("RK17", "RK17.3", "main() sem referência chama o wrangler_put falso, que levanta")],
         "broad_reason": "a gravação sem prova atinge todos os testes de recusa e o main sem referência"}),
    # Sem prova sai 0: todo teste de recusa falha no código [t.1]; RK17 espera 2 do main.
    "sai_zero_sem_prova": (
        "        return 2\n", "        return 0\n",
        {"primary": [P("RK01", "RK01.1"), P("RK07", "RK07.1"), P("RK08", "RK08.1")],
         "secondary": [S(t, t + ".1", "toda recusa passa a sair com código 0") for t in REFUSING if t not in ("RK01", "RK07", "RK08")]
         + [S("RK17", "RK17.1", "main() sem referência devolve o código de run(), agora 0")],
         "broad_reason": "o código de saída da recusa é comum a todos os testes de recusa e ao main"}),
    # Falha do wrangler vira sucesso.
    "falha_de_gravacao_vira_sucesso": (
        "        return 3\n", "        return 0\n",
        {"primary": [P("RK13", "RK13.1")]}),
    # O id de referência vai para o log (primeiro caso do RK14 já tem a referência). Usa o nome do parâmetro de run();
    # a versão anterior deste mutante citava `ref` (variável de certify()) e "morria" por NameError, o que pela R5 é
    # INCONCLUSIVE, não KILLED.
    "loga_id_de_referencia": (
        'out("RESEND_RECEIVING_REFERENCE_STATUS=%s" % facts["item_status"])',
        'out("RESEND_RECEIVING_REFERENCE_STATUS=%s ref=%s" % (facts["item_status"], reference_email_id))',
        {"primary": [P("RK14", "RK14.1")]}),
    # A chave vai no argv do wrangler.
    "chave_em_argv": (
        '"--path", path, "--remote"]', '"--path", path, "--remote", key]',
        {"primary": [P("RK18", "RK18.1")]}),
    # Arquivo temporário legível por todos.
    "tempfile_legivel": (
        "fd, path = tempfile.mkstemp()", "fd, path = tempfile.mkstemp(); os.chmod(path, 0o644)",
        {"primary": [P("RK18", "RK18.2")]}),
    # Arquivo temporário com a chave não é removido.
    "tempfile_nao_removido": (
        "            os.remove(path)", "            pass",
        {"primary": [P("RK18", "RK18.4")]}),
    # Erro HTTP vira 200 em http_get.
    "http_erro_vira_200": (
        "return e.code, None", "return 200, None",
        {"primary": [P("RK15", "RK15.1")]}),
}


# ---------------------------------------------------------------- emissor TAP da suíte Python
def _yaml_str(text):
    text = re.sub(r"\s*\n\s*", " | ", str(text)).strip()[:3000]
    return "'" + text.replace("'", "''") + "'"


def _label(test):
    m = re.match(r"test_(rk\d+)", test._testMethodName)
    return (m.group(1).upper() + " " if m else "") + test._testMethodName


class TapResult(unittest.TestResult):
    """Um ponto por teste. Falhas de subTest e do próprio teste somam no mesmo ponto (a 1ª define name/code)."""

    def __init__(self):
        super().__init__()
        self.points, self._cur = [], None

    def startTest(self, test):
        super().startTest(test)
        self._cur = {"name": _label(test), "errs": [], "directive": None, "t0": time.time()}

    def _err(self, kind, code, text):
        self._cur["errs"].append((kind, code, text))

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._err("AssertionError", "ERR_ASSERTION", str(err[1]))

    def addError(self, test, err):
        super().addError(test, err)
        self._err(err[0].__name__, "", "".join(traceback.format_exception_only(err[0], err[1])))

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is None:
            return
        if issubclass(err[0], test.failureException):
            self._err("AssertionError", "ERR_ASSERTION", str(err[1]))
        else:
            self._err(err[0].__name__, "", "".join(traceback.format_exception_only(err[0], err[1])))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._cur["directive"] = "SKIP"

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._cur["directive"] = "TODO"

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._err("UnexpectedSuccess", "", "unexpected success")

    def stopTest(self, test):
        super().stopTest(test)
        c = self._cur
        self.points.append((c["name"], not c["errs"], c["errs"], c["directive"], (time.time() - c["t0"]) * 1000))


def tap_main():
    sys.path.insert(0, str(REPO))
    suite = unittest.defaultTestLoader.loadTestsFromName(TEST_MODULE)
    res = TapResult()
    suite.run(res)
    out = ["TAP version 13"]
    counts = {"pass": 0, "fail": 0, "skipped": 0, "todo": 0}
    for i, (name, ok, errs, directive, ms) in enumerate(res.points, 1):
        out.append(f"# Subtest: {name}")
        out.append(f"{'ok' if ok else 'not ok'} {i} - {name}" + (f" # {directive}" if directive else ""))
        out += ["  ---", f"  duration_ms: {ms:.3f}", "  type: 'test'"]
        if errs:
            kind, code, _ = errs[0]
            out += ["  location: 'tests/test_resend_receiving_key_certify.py'", "  failureType: 'testCodeFailure'",
                    f"  error: {_yaml_str(' || '.join(e[2] for e in errs))}"]
            if code:
                out.append(f"  code: '{code}'")
            out.append(f"  name: '{kind}'")
        out.append("  ...")
        key = {"SKIP": "skipped", "TODO": "todo"}.get(directive) or ("pass" if ok else "fail")
        counts[key] += 1
    n = len(res.points)
    out += [f"1..{n}", f"# tests {n}", "# suites 0", f"# pass {counts['pass']}", f"# fail {counts['fail']}",
            "# cancelled 0", f"# skipped {counts['skipped']}", f"# todo {counts['todo']}", "# duration_ms 1"]
    print("\n".join(out))
    return 1 if counts["fail"] else 0


# ---------------------------------------------------------------- runner
def run_suite(module_path):
    env = {**os.environ, "CERT_MODULE_PATH": str(module_path), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    return mc.run_command([sys.executable, str(Path(__file__).resolve()), "--tap"], cwd=str(REPO), timeout=300, env=env)


def main(argv):
    jsonl = Path(argv[argv.index("--jsonl") + 1]) if "--jsonl" in argv else None
    try:
        config = mc.load_mutant_config({mid: spec for mid, (_, _, spec) in MUTANTS.items()})
        for mid, spec in config.items():
            if any(not (isinstance(e.get("assertion_pattern"), str) and e["assertion_pattern"].strip()) for e in spec["primary"]):
                raise mc.ConfigError(f"{mid}: primária sem marcador de asserção")
    except mc.ConfigError as e:
        print(f"CONFIG_INVALID {e}")
        return mc.EXIT_BAD_BASELINE
    original = SRC.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    base = run_suite(SRC)
    parsed = mc.parse_tap(base.get("stdout", ""), stderr=base.get("stderr", ""))
    bl = mc.validate_baseline(BASELINE_TOTAL, base.get("return_code"), parsed["summary"], parsed["failures"],
                              timed_out=base.get("timed_out", False), signal=base.get("signal"))
    print(json.dumps({"baseline": bl["verdict"], "ok": bl["ok"], "reason": bl["reason"], "counts": bl["counts"]}))
    if not bl["ok"]:
        print(base.get("stdout", "")[-4000:], base.get("stderr", "")[-4000:], file=sys.stderr)
        return mc.EXIT_BAD_BASELINE
    titles = [p.get("test_id") or "" for p in parsed["summary"].get("points") or []]
    for mid, spec in config.items():
        for e in spec["primary"] + spec["secondary"]:
            n = sum(1 for t in titles if mc._test_matches(e["test_pattern"], t))
            if n != 1:
                print(f"CONFIG_INVALID {mid}: test_pattern {e['test_pattern']!r} casa com {n} testes da baseline")
                return mc.EXIT_BAD_BASELINE
    results = []
    text = original.decode("utf-8")
    for mid, (anchor, repl, _) in MUTANTS.items():
        spec = config[mid]
        ok = text.count(anchor) == 1
        mutated = text.replace(anchor, repl, 1) if ok else text
        with tempfile.TemporaryDirectory() as d:
            copy = Path(d) / "resend_receiving_key_certify.py"
            copy.write_text(mutated, encoding="utf-8")
            run = run_suite(copy)
        res = mc.classify_run(BASELINE_TOTAL, run, expected=spec, allowlist=spec["allowlist"], anchor_ok=ok,
                              mutant_id=mid)
        results.append(res)
        print(f"MUTANT {mid} {res['verdict']}" + ("" if res["verdict"] == mc.KILLED else f" ({res['reason'][:300]})"))
        print("RESULT " + json.dumps({k: res.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests",
                                                              "secondary_tests", "unexpected_failures")}, ensure_ascii=False))
    if hashlib.sha256(SRC.read_bytes()).hexdigest() != digest:
        print("ORIGINAL_MODIFIED", file=sys.stderr)
        return mc.EXIT_INCONCLUSIVE
    if jsonl:
        jsonl.write_text("".join(json.dumps(r) + "\n" for r in results), encoding="utf-8")
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(f"MUTANTS suite=resend_receiving_key total={len(results)} killed={summary['KILLED']} "
          f"survived={summary['SURVIVED']} inconclusive={summary['INCONCLUSIVE']}")
    return code


if __name__ == "__main__":
    if "--tap" in sys.argv:
        sys.exit(tap_main())
    sys.exit(main(sys.argv[1:]))
