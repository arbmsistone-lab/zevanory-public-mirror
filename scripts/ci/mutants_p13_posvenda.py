#!/usr/bin/env python3
"""Mutantes causais do ensaio sintético P13 (política de 7 dias, contestação 7.3 e pacote de respostas),
classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/p13-posvenda-ensaio.test.mjs (V1-V14). Sem rede, sem produção, sem
segredos. Cada mutante altera UMA regra numa cópia mínima da árvore em diretório temporário (o repositório nunca é
alterado): scripts/p13/decisao-reembolso-7d.mjs, scripts/p13/contestacao-7-3.mjs, scripts/p13/respostas-check.mjs e
docs/p13/respostas-prontas.md.
Expectativas (mutants_p13_posvenda_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Vn.k]) e secondary com justification, escritas por raciocínio ANTES de rodar.
Validação antes de qualquer mutante (exit 2): config inválida, primary sem marcador, test_pattern que não casa com
nenhum teste da baseline, mutante sem config ou config órfã. INCONCLUSIVE repete 1 vez; persistindo, o job falha.
Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p13_posvenda.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p13-posvenda-ensaio.test.mjs"]
COPY_DIRS = ["scripts/p13", "docs/p13"]
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "worker/politica-unica.mjs", "data/politica-unica.json"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
R, C, K, P = "scripts/p13/decisao-reembolso-7d.mjs", "scripts/p13/contestacao-7-3.mjs", "scripts/p13/respostas-check.mjs", "docs/p13/respostas-prontas.md"

M = {
    "N01 prazo medido no tratamento e não na solicitação": (R, "now: solicitado });", "now });"),
    "N02 decisão anterior ignorada": (R, "if (decisaoAnterior && typeof", "if (false && decisaoAnterior && typeof"),
    "N03 já reembolsado não conferido": (R, "  if (pedido.estado === \"reembolsado\") return out(\"ja_reembolsado\", \"nenhuma_segunda_reversao\");\n", ""),
    "N04 contestação aberta não conferida": (R, "  if (pedido.estado === \"contestado\") return out(\"contestacao_em_andamento\", \"seguir_procedimento_7_3_sem_reembolso_paralelo\", { revisao_humana: true });\n", ""),
    "N05 exceção aceita sem validação": (R, "if (excecaoValida(excecao)) return out(\"excecao_autorizada\"", "if (true) return out(\"excecao_autorizada\""),
    "N06 exceção autorizada por qualquer pessoa": (R, "excecao.autorizada_por === \"proprietario\" &&", "Boolean(excecao.autorizada_por) &&"),
    "N07 assunto sensível sem revisão humana": (R, "revisao_humana: Boolean(extra.revisao_humana || sensivel),", "revisao_humana: Boolean(extra.revisao_humana),"),
    "N08 prazo H-6 de 7 dias": (R, "export const HOTMART_RESPOSTA_DIAS = 5;", "export const HOTMART_RESPOSTA_DIAS = 7;"),
    "N09 vício tratado como fora do prazo comum": (R, "  if (MOTIVOS_VICIO.has(solicitacao.motivo)) return", "  if (false) return"),
    "N10 recebimento ignorado no legado": (R, "deliveredAt: recebido,", "deliveredAt: aprovado,"),
    "N11 evidência sem checagem de privacidade": (C, "if (problemasDePrivacidade(i?.texto).length) throw", "if (false) throw"),
    "N12 resposta de disputa sem revisão humana": (C, "      if (ctx.revisado_por !== \"proprietario\") throw new ContestacaoError(\"revisao_humana_obrigatoria\");\n      if (at > c.prazo_ate)", "      if (at > c.prazo_ate)"),
    "N13 prazo perdido não detectado": (C, "if (at > c.prazo_ate) {", "if (false) {"),
    "N14 falha crítica de P12 não marcada": (C, "ctx.resultado === \"desfavoravel\" && ctx.causa === \"falha_entrega\"", "false"),
    "N15 evidência de entrega não exigida": (C, "      if (!itens.some((i) => i?.tipo === \"registro_acesso\" || i?.tipo === \"registro_envio\")) throw new ContestacaoError(\"sem_evidencia_de_entrega\");\n", ""),
    "N16 verificador aceita e-mail não oficial": (K, "if (e.toLowerCase() !== SUPPORT_EMAIL) p.push(\"email_nao_oficial\");", "if (false) p.push(\"email_nao_oficial\");"),
    "N17 resposta pública sem revisão aceita": (K, "  if (PUBLICAS.test(t.id) && !obrigatoria) p.push(\"publica_sem_revisao_obrigatoria\");\n", ""),
    "N18 decisão sensível sem revisão aceita": (K, "  if (CATEGORIAS_SENSIVEIS.has(t.categoria) && !obrigatoria) p.push(\"sensivel_sem_revisao_obrigatoria\");\n", ""),
    "N19 texto de prazo fora da política aceito": (K, "  if (t.categoria === \"reembolso_fora_do_prazo\" && !t.texto.includes(CUSTOMER_RULE_7D)) p.push(\"prazo_diferente_da_politica\");\n", ""),
    "N20 campo fora da lista aceito": (K, "if (!CAMPOS_PERMITIDOS.has(m[1])) p.push(", "if (false) p.push("),
    "N21 pacote com contestação sem revisão obrigatória": (P, "- Revisão humana: OBRIGATÓRIA (contestação)\n```text\nDisputa", "- Revisão humana: dispensada (sem revisão)\n```text\nDisputa"),
}

ALLOW_FILE = Path(os.environ.get("P13_POSVENDA_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p13_posvenda_allow.json"))


def load_config(path=None, titles=None, mutants=None):
    raw = json.loads(Path(path or ALLOW_FILE).read_text(encoding="utf-8"))
    specs = raw.get("mutants") if isinstance(raw, dict) else None
    if not isinstance(specs, dict):
        raise mc.ConfigError("config sem a seção 'mutants'")
    cfg = mc.load_mutant_config(specs)
    mutants = M if mutants is None else mutants
    missing, orphan = sorted(set(mutants) - set(cfg)), sorted(set(cfg) - set(mutants))
    if missing or orphan:
        raise mc.ConfigError(f"mutantes sem config {missing} / config órfã {orphan}")
    for mid, spec in cfg.items():
        for e in spec["primary"]:
            if not (isinstance(e.get("assertion_pattern"), str) and e["assertion_pattern"].strip()):
                raise mc.ConfigError(f"{mid}: primary sem assertion_pattern")
        if titles is not None:
            for e in spec["primary"] + spec["secondary"]:
                if not any(mc._test_matches(e["test_pattern"], t) for t in titles):
                    raise mc.ConfigError(f"{mid}: test_pattern não casa com nenhum teste: {e['test_pattern'][:60]}")
    return cfg


def build(tmp, mutation=None):
    for rel in COPY_DIRS:
        shutil.copytree(Path(REPO, *rel.split("/")), Path(tmp, *rel.split("/")), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for rel in COPY_FILES:
        dst = Path(tmp, *rel.split("/"))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(REPO, *rel.split("/")), dst)
    if mutation:
        rel, old, new = mutation
        f = Path(tmp, *rel.split("/"))
        text = f.read_bytes().decode("utf-8").replace("\r\n", "\n")
        if text.count(old) != 1:
            return False
        with open(f, "w", encoding="utf-8", newline="\n") as h:
            h.write(text.replace(old, new, 1))
    return True


def run_suite(root):
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": "", "PYTHONDONTWRITEBYTECODE": "1"}
    return mc.run_command([NODE, "--test", "--test-concurrency=1", "--test-reporter=tap", "--test-reporter-destination=stdout", *TESTS],
                          cwd=root, timeout=TIMEOUT, env=env)


def run_mutant(name, mutation, total, spec):
    with tempfile.TemporaryDirectory() as tmp:
        ok = build(tmp, mutation)
        run = run_suite(tmp) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(total, run, expected=spec, allowlist=spec.get("allowlist") or [], anchor_ok=ok, mutant_id=name)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp)
        base = run_suite(tmp)
    parsed = mc.parse_tap(base.get("stdout", ""), stderr=base.get("stderr", ""))
    total = parsed["summary"].get("tests")
    vb = mc.validate_baseline(total if isinstance(total, int) else -1, base.get("return_code"), parsed["summary"], parsed["failures"],
                              timed_out=base.get("timed_out", False), signal=base.get("signal"))
    if not vb["ok"]:
        print("BASELINE FAILED", vb["reason"])
        print(base.get("stdout", "")[-3000:])
        return mc.EXIT_BAD_BASELINE
    titles = [p.get("test_id") for p in parsed["summary"].get("points") or []]
    print(f"BASELINE PASS tests={total}")
    try:
        cfg = load_config(titles=titles)
    except mc.ConfigError as e:
        print("CONFIG_INVALID", e)
        return mc.EXIT_BAD_BASELINE

    def judge(item):
        name, mutation = item
        res = run_mutant(name, mutation, total, cfg[name])
        if res["verdict"] == mc.INCONCLUSIVE:
            first = res["reason"]
            res = run_mutant(name, mutation, total, cfg[name])
            if res["verdict"] == mc.INCONCLUSIVE:
                res["reason"] = f"{first} | repetição: {res['reason']}"
        return res

    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
        results = list(ex.map(judge, M.items()))
    for r in results:
        print(f"MUTANT {r['mutant_id']} {r['verdict']}" + ("" if r["verdict"] == mc.KILLED else f" ({r['reason'][:300]})"))
        print("RESULT " + json.dumps({k: r.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests", "assertion_ids", "secondary_tests", "unexpected_failures")}, ensure_ascii=False))
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(f"MUTANTS total={len(results)} killed={summary['KILLED']} survived={summary['SURVIVED']} inconclusive={summary['INCONCLUSIVE']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
