"""Classificador estrito de mutantes sobre a saída TAP de `node --test --test-reporter=tap` (auditoria Sol #898).

Regra (um mutante só é KILLED pela causa esperada):
  KILLED       saída normal de falha de teste (rc == 1), resumo TAP completo e coerente
               (tests == baseline, pass + fail == tests, fail >= 1, cancelled == skipped == todo == 0,
               e o número de resultados de topo "ok"/"not ok" == tests), ao menos uma falha numa asserção
               PRIMARY (teste + trecho dentro do campo `error` do bloco `not ok`) e toda outra falha em
               asserção PRIMARY ou em teste SECONDARY com justificativa causal (regra Sol, auditoria 128);
  SURVIVED     rc == 0 e resumo completo, todos os testes passando;
  INCONCLUSIVE qualquer outra coisa: queda (rc != 0/1, erro de sintaxe ou de módulo), tempo esgotado
               (rc None), resumo ausente ou incompleto, falha só em SECONDARY, falha não relacionada.
validate_spec(): PRIMARY com 1 a 3 asserções e justificativa; SECONDARY sem justificativa ou mais de 4 testes sem
broad_reason => o runner se recusa a começar.
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


MAX_PRIMARY = 3
MAX_TESTS_WITHOUT_BROAD = 4
MIN_JUSTIFICATION = 20


def validate_spec(mid, spec):
    """Problemas do mapa causal de um mutante (lista vazia = válido). Qualquer problema impede o runner de começar."""
    probs = []
    p = spec.get("p") if isinstance(spec, dict) else None
    if not isinstance(p, list) or not 1 <= len(p) <= MAX_PRIMARY:
        probs.append(f"{mid}: PRIMARY deve ter de 1 a {MAX_PRIMARY} asserções")
        p = p if isinstance(p, list) else []
    for item in p:
        if not (isinstance(item, tuple) and len(item) == 2 and all(isinstance(x, str) and x.strip() for x in item)):
            probs.append(f"{mid}: PRIMARY inválida {item!r} (esperado (teste, trecho do error))")
    if len(str(spec.get("why", "")).strip()) < MIN_JUSTIFICATION:
        probs.append(f"{mid}: PRIMARY sem justificativa (why)")
    sec = spec.get("s", {}) or {}
    if not isinstance(sec, dict):
        probs.append(f"{mid}: SECONDARY deve ser {{teste: justificativa}}")
        sec = {}
    for test, why in sec.items():
        if len(str(why or "").strip()) < MIN_JUSTIFICATION:
            probs.append(f"{mid}: SECONDARY {test!r} sem justificativa causal")
    tests = {t for t, _ in p if isinstance(t, str)} | set(sec)
    if len(tests) > MAX_TESTS_WITHOUT_BROAD and len(str(spec.get("broad", "")).strip()) < MIN_JUSTIFICATION:
        probs.append(f"{mid}: {len(tests)} testes exigem broad_reason explícito")
    return probs


def classify(rc, out, total, primary, secondary=None):
    """-> (veredito, motivo).
    primary   [(id do teste, trecho do error)]: ao menos uma falha precisa ser uma delas;
    secondary {id do teste: justificativa}: falhas aceitas além das primárias (nunca sozinhas)."""
    secondary = secondary or {}
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
    is_primary = lambda r: any(r["id"] == t and label in r["error"] for t, label in primary)
    hits = [r["id"] for r in failed if is_primary(r)]
    if not hits:
        return INCONCLUSIVE, f"nenhuma asserção PRIMARY falhou (falhas: {[r['id'] for r in failed]})"
    stray = sorted({r["id"] for r in failed if not is_primary(r) and r["id"] not in secondary})
    if stray:
        return INCONCLUSIVE, f"falha fora de PRIMARY/SECONDARY justificada: {stray}"
    return KILLED, ""
