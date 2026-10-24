"""Classificador estrito de mutantes sobre a saída TAP de `node --test --test-reporter=tap` (auditoria Sol #898).

Regra (um mutante só é KILLED pela causa esperada):
  KILLED       saída normal de falha de teste (rc == 1), resumo TAP completo e coerente
               (tests == baseline, pass + fail == tests, fail >= 1, cancelled == skipped == todo == 0,
               e o número de resultados de topo "ok"/"not ok" == tests), TODAS as falhas em testes da
               allowlist do mutante e o rótulo esperado DENTRO do campo `error` de um bloco `not ok`
               da allowlist (rótulo numa linha `ok`, no nome do teste ou em outro bloco não conta);
  SURVIVED     rc == 0 e resumo completo, todos os testes passando;
  INCONCLUSIVE qualquer outra coisa: queda (rc != 0/1, erro de sintaxe ou de módulo), tempo esgotado
               (rc None), resumo ausente ou incompleto, falha fora da allowlist, rótulo ausente do bloco.
O chamador repete uma vez um INCONCLUSIVE; se persistir, o job falha.
Sem dependências; texto já normalizado (CRLF -> LF) pelo chamador.
"""
import re

KILLED, SURVIVED, INCONCLUSIVE = "KILLED", "SURVIVED", "INCONCLUSIVE"
_RESULT = re.compile(r"^(not ok|ok) \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$")
_KEYS = ("tests", "pass", "fail", "cancelled", "skipped", "todo")


def summary(out):
    s = {}
    for k in _KEYS:
        m = re.search(rf"^# {k} (\d+)$", out, re.M)
        s[k] = int(m.group(1)) if m else None
    return s


def test_id(name):
    """Identificador estável do teste: o prefixo "(g1)" etc.; sem prefixo, o nome inteiro."""
    m = re.match(r"^(\([a-z0-9]+\))", name)
    return m.group(1) if m else name.strip()


def results(out):
    """Resultados de TOPO (coluna 0) com o texto do campo `error` do diagnóstico YAML de cada um."""
    lines = out.split("\n")
    found = []
    for i, line in enumerate(lines):
        m = _RESULT.match(line)
        if not m:
            continue
        ok = m.group(1) == "ok"
        err = []
        if not ok:
            j, inside = i + 1, False
            while j < len(lines) and not _RESULT.match(lines[j]) and not lines[j].startswith("# Subtest:") and lines[j] != "  ...":
                ln = lines[j]
                if re.match(r"^  error:", ln):
                    inside = True
                    err.append(ln[len("  error:"):])
                elif inside and re.match(r"^  [A-Za-z_]+:", ln):
                    inside = False
                elif inside:
                    err.append(ln)
                j += 1
        found.append({"ok": ok, "name": m.group(2), "id": test_id(m.group(2)), "error": "\n".join(err)})
    return found


def classify(rc, out, expect, total, allowed):
    """-> (veredito, motivo). `allowed`: ids de teste que este mutante pode derrubar."""
    if rc is None:
        return INCONCLUSIVE, "tempo esgotado"
    s = summary(out)
    res = results(out)
    complete = (s["tests"] == total and None not in s.values() and s["pass"] + s["fail"] == total
                and s["cancelled"] == 0 and s["skipped"] == 0 and s["todo"] == 0 and len(res) == total)
    if not complete:
        return INCONCLUSIVE, f"rc={rc} resumo incompleto ou incoerente {s} resultados_topo={len(res)}"
    failed = [r for r in res if not r["ok"]]
    if rc == 0 and not failed and s["fail"] == 0:
        return SURVIVED, ""
    if rc != 1 or not failed or len(failed) != s["fail"]:
        return INCONCLUSIVE, f"rc={rc} saída anormal (falhas={len(failed)} resumo={s})"
    outside = sorted({r["id"] for r in failed if r["id"] not in allowed})
    if outside:
        return INCONCLUSIVE, f"falha fora da allowlist: {outside}"
    if not any(expect in r["error"] for r in failed):
        return INCONCLUSIVE, f"rótulo esperado ausente dos blocos `not ok` ({[r['id'] for r in failed]})"
    return KILLED, ""
