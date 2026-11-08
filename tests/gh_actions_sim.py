"""Avaliador mínimo de expressões do GitHub Actions para os testes que EXECUTAM passos reais de workflow.

Cobre o subconjunto usado nos workflows de deploy: literais ('x', true, false, null, números), caminhos de
contexto (secrets.X, needs.J.outputs.Y, steps.S.outputs.Y, vars.X, github.X, inputs.X), ==, !=, !, &&, || e
parênteses, com a semântica documentada (docs.github.com/actions/reference/evaluate-expressions-in-workflows-and-actions):
&& e || devolvem um dos operandos (como em JavaScript), comparação de strings sem distinção de maiúsculas, valor
falso = '', false, null, 0. O resultado final vira string como o runner faz (true -> 'true', null -> '').
Não é um módulo de teste (o nome não começa com test_); é importado por tests/test_p21_token_cutover.py e
tests/test_diario_d1_credentials.py.
"""
import re

_TOK = re.compile(r"\s*(?:(?P<str>'(?:[^']|'')*')|(?P<num>\d+(?:\.\d+)?)|(?P<op>==|!=|&&|\|\||!|\(|\))|(?P<id>[A-Za-z_][A-Za-z0-9_.\-]*))")


def _tokens(src):
    out, i = [], 0
    while i < len(src):
        if src[i:].strip() == "":
            break
        m = _TOK.match(src, i)
        if not m or m.end() == i:
            raise ValueError("expressão não suportada pelo simulador: " + src[i:])
        i = m.end()
        out.append((m.lastgroup, m.group(m.lastgroup)))
    return out


def truthy(v):
    return not (v is None or v is False or v == "" or v == 0)


def _eq(a, b):
    if isinstance(a, str) and isinstance(b, str):
        return a.lower() == b.lower()
    if isinstance(a, bool) or isinstance(b, bool):
        return str(a).lower() == str(b).lower()
    return a == b


class _P:
    def __init__(self, toks, resolve):
        self.t, self.i, self.resolve = toks, 0, resolve

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self, val=None):
        k, v = self.peek()
        if val is not None and v != val:
            raise ValueError(f"esperado {val!r}, achado {v!r}")
        self.i += 1
        return k, v

    def expr(self):
        left = self.and_()
        while self.peek()[1] == "||":
            self.take()
            right = self.and_()
            left = left if truthy(left) else right
        return left

    def and_(self):
        left = self.cmp()
        while self.peek()[1] == "&&":
            self.take()
            right = self.cmp()
            left = right if truthy(left) else left
        return left

    def cmp(self):
        left = self.unary()
        while self.peek()[1] in ("==", "!="):
            _, op = self.take()
            right = self.unary()
            left = _eq(left, right) if op == "==" else not _eq(left, right)
        return left

    def unary(self):
        if self.peek()[1] == "!":
            self.take()
            return not truthy(self.unary())
        return self.atom()

    def atom(self):
        k, v = self.take()
        if v == "(":
            r = self.expr()
            self.take(")")
            return r
        if k == "str":
            return v[1:-1].replace("''", "'")
        if k == "num":
            return float(v) if "." in v else int(v)
        if k == "id":
            if v == "true":
                return True
            if v == "false":
                return False
            if v == "null":
                return None
            return self.resolve(v)
        raise ValueError("token inesperado: " + str(v))


def evaluate_expr(inner, resolve):
    p = _P(_tokens(inner), resolve)
    r = p.expr()
    if p.i != len(p.t):
        raise ValueError("sobra na expressão: " + inner)
    return r


def to_str(v):
    if v is True:
        return "true"
    if v is False:
        return "false"
    if v is None:
        return ""
    return str(v)


def evaluate_value(value, resolve):
    """Valor de uma chave env/if do YAML: texto puro, texto entre aspas ou exatamente uma ${{ ... }}."""
    v = value.strip()
    m = re.fullmatch(r"\$\{\{\s*(.+?)\s*\}\}", v)
    if not m:
        if "${{" in v:
            raise ValueError("interpolação parcial não suportada pelo simulador: " + v)
        return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'" else v
    return to_str(evaluate_expr(m.group(1), resolve))


def resolver(secrets, outputs=None, fake_prefixes=("vars.", "github.", "inputs.")):
    """secrets: {nome: valor}; outputs: {'steps.x.outputs.y' | 'needs.j.outputs.y': valor}."""
    outputs = outputs or {}

    def resolve(path):
        if path.startswith("secrets."):
            return secrets.get(path[len("secrets."):], "")
        if path.startswith(("steps.", "needs.")):
            return outputs.get(path, "")
        if path.startswith(fake_prefixes):
            return "fake-" + path
        raise ValueError("contexto não suportado pelo simulador: " + path)
    return resolve
