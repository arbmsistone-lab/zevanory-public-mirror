#!/usr/bin/env python3
"""Mutantes causais do ensaio sintético de entrega P12 (DEC-06: entrega na Hotmart; registro idempotente na ZEVANORY),
classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/p12-entrega-ensaio.test.mjs (E1-E21). Sem rede (fetch substituído),
sem Cloudflare, sem segredos. Cada mutante altera UMA regra numa cópia mínima da árvore em diretório temporário
(o repositório nunca é alterado): eventos imutáveis por transação e resumo derivado (worker/sales-ledger.mjs, NC-989-01), 503 em registro de entrega não
gravado (worker/cp-nc012-digital-hotmart.mjs), chave por ciclo da entrega mensal (worker/cp-durable-ledger.mjs),
onboarding microvitória (worker/onboarding-microvitoria.mjs) e a matriz 12-B.4 (data/p12-degradacao-12b4.json +
scripts/ci/p12_degradacao.mjs).
Expectativas (mutants_p12_entrega_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [En.k] da asserção que codifica a regra) e secondary com justification,
escritas por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida,
primary sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p12_entrega.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p12-entrega-ensaio.test.mjs"]
COPY_DIRS = ["worker", "data"]
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "scripts/ci/p12_degradacao.mjs"] + [
    f"sales-public/{s}.html" for s in ("ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo", "privacidade")]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
L, H, C = "worker/sales-ledger.mjs", "worker/cp-nc012-digital-hotmart.mjs", "worker/cp-durable-ledger.mjs"
O, D, X = "worker/onboarding-microvitoria.mjs", "data/p12-degradacao-12b4.json", "scripts/ci/p12_degradacao.mjs"

M = {
    "M05 atividade não gravada ignorada": (H, "if(!out||(out.emitted!==true&&out.duplicate!==true))return json(503,", "if(false)return json(503,"),
    "M06 atividade duplicada tratada como falha": (H, "if(!out||(out.emitted!==true&&out.duplicate!==true))return json(503,", "if(!out||out.emitted!==true)return json(503,"),
    "M07 estorno sem registro de atividade": (H, "STOP.has(event)?{type:\"refund_requested\"", "false?{type:\"refund_requested\""),
    "M08 flag do onboarding aceita qualquer valor": (O, "  return value === true || value === \"true\";\n", "  return Boolean(value);\n"),
    "M09 envio real destravado no código": (O, "export const ONBOARDING_SEND_ENABLED = false;", "export const ONBOARDING_SEND_ENABLED = true;"),
    "M10 prazo da microvitória em 48 h": (O, "export const MICROVITORIA_DEADLINE_MS = 24 * HOUR;", "export const MICROVITORIA_DEADLINE_MS = 48 * HOUR;"),
    "M11 envio depois do prazo permitido": (O, "  if (nowMs >= plan.deadline_ms) return { action: \"alert\", reason: \"prazo_24h_perdido\" };\n", ""),
    "M12 estorno não cancela a microvitória": (O, "  if (reversed) return { action: \"cancel\", reason: \"estorno_ou_cancelamento\" };\n", ""),
    "M13 chave da entrega mensal por evento": (C, "this.canonicalId+\"/delivery/\"+cycle", "this.canonicalId+\"/delivery/\"+eventKey"),
    "M14 avaliador 12-B.4 ignora dependências": (X, ".filter((p) => (p.direitos || []).includes(r) && !(p.deps_recebimento || []).includes(c.falha))", ".filter((p) => (p.direitos || []).includes(r))"),
    "M15 caminho sem dependência aceito": (X, "    if (!Array.isArray(p?.deps_recebimento) || !p.deps_recebimento.length) problems.push(\"sem_deps_recebimento:\" + p?.id);\n", ""),
    "M16 suporte@ sem o direito de acesso na matriz": (D, "\"id\": \"suporte_email\",\n   \"direitos\": [\"acesso_conteudo\", ", "\"id\": \"suporte_email\",\n   \"direitos\": ["),
    "M18 base legal divergente da política publicada": (O, "  referencia: \"LGPD art. 7º, IX\",\n", "  referencia: \"LGPD art. 7º, V\",\n"),
    # NC-989-01/02/03 (contra-auditorias do PR #989): eventos imutáveis por conteúdo, partição por dia estável,
    # resumo derivado só dos dias quentes/sujos, marcador com TTL e orçamento de cota.
    "M19 resumo por leitura-modificação-gravação como fonte (sem evento imutável)": (L, "  await kv.put(r.key, r.value, { expirationTtl: SALES_EVENT_TTL_DAYS * DAY, metadata: r.meta });", "  await kv.put(SALES_SUMMARY_KEY, JSON.stringify(applySale(parse(await kv.get(SALES_SUMMARY_KEY)), r.meta.facts, kind, r.ref)));"),
    "M20 derivação parte do resumo atual (projeção usada como fonte)": (L, "  const s = baseline ? JSON.parse(JSON.stringify(baseline)) : emptySummary();", "  const s = parse(await kv.get(SALES_SUMMARY_KEY)) || emptySummary();"),
    "M21 postback lista o prefixo global de eventos": (L, "metadata: r.meta });\n  if (cold)", "metadata: r.meta });\n  await listNames(kv, SALES_EVENT_PREFIX);\n  if (cold)"),
    "M22 chave por transação não determinística": (L, "  const h = (await sha(\"hotmart:\" + txn)).slice(0, 32);", "  const h = (await sha(\"hotmart:\" + txn + \":\" + Math.random())).slice(0, 32);"),
    "M23 TTL do evento abaixo de 400 dias": (L, "{ expirationTtl: SALES_EVENT_TTL_DAYS * DAY, metadata: r.meta }", "{ expirationTtl: (SALES_EVENT_TTL_DAYS - 1) * DAY, metadata: r.meta }"),
    "M24 contagem de entradas não únicas (por chave, não por transação+desfecho)": (L, "    const id = m[2] + \":\" + m[3];", "    const id = name;"),
    "M25 falha da listagem engolida (projeção de lista parcial ou vazia)": (L, "    const page = await kv.list({ prefix, cursor, limit: KV_LIST_LIMIT });", "    const page = await kv.list({ prefix, cursor, limit: KV_LIST_LIMIT }).catch(() => ({ keys: [], list_complete: true }));"),
    "M26 reentrega não regrava o marcador que faltou": (L, "    if (cold) await markDirty(kv, r.day, now);\n    return", "    return"),
    "M27 evento gravado só se o grupo for novo (ordem de chegada decide)": (L, "  if (event === \"PURCHASE_COMPLETE\" && approvedTwin) return", "  if (group) return"),
    "M28 representativo pela ordem da listagem, não pela precedência": (L, "    if (!g.rep || rank(meta.event) < rank(g.rep.meta.event) || (meta.event === g.rep.meta.event && m[5] < g.rep.ph)) g.rep =", "    if (!g.rep) g.rep ="),
    "M29 marcador legado ignorado": (L, "  if ((await kv.get(LEGACY_TXN_STATE + r.ref + \":\" + r.outcome)) === \"1\") return", "  if (false) return"),
    "M30 base legada não gravada antes da projeção": (L, "    await kv.put(SALES_LEGACY_BASELINE_KEY, String(rawSummary));\n", ""),
    "M31 paginação do list ignorada (limite de tamanho)": (L, "    if (page?.list_complete) break;", "    break;"),
    "M32 falha de gravação do evento engolida": (L, "metadata: r.meta });\n  if (cold)", "metadata: r.meta }).catch(() => {});\n  if (cold)"),
    "M33 leitura com falha engolida (KV fora sem 503)": (L, "  if ((await kv.get(LEGACY_TXN_STATE + r.ref + \":\" + r.outcome)) === \"1\") return", "  if ((await kv.get(LEGACY_TXN_STATE + r.ref + \":\" + r.outcome).catch(() => null)) === \"1\") return"),
    "M34 chave do evento sem payloadhash (conteúdo diferente sobrescreve)": (L, "key: base + event.toLowerCase() + \":\" + ph,", "key: base + event.toLowerCase() + \":\" + \"0\".repeat(16),"),
    "M35 total recalculado de todos os eventos (lista global)": (L, "  const touch = [...new Set([...hot, ...dirty, ...catchUp, sweepDay(now)])].sort();", "  const touch = [...new Set([...hot, ...dirty, ...catchUp, sweepDay(now), ...[...(await listNames(kv, SALES_EVENT_PREFIX)).keys()].map((k) => k.slice(SALES_EVENT_PREFIX.length, SALES_EVENT_PREFIX.length + 8))])].sort();"),
    "M36 dia frio sem marcador": (L, "  if (cold) await markDirty(kv, r.day, now);\n  return group", "  return group"),
    "M37 marcador nunca regravado (sem renovação a cada 2 h)": (L, "  if (Number.isFinite(at) && at > now - DIRTY_REFRESH_MS) return false;", "  if (Number.isFinite(at) && at > 0) return false;"),
    "M38 marcador apagado depois do recomputo sem verificação": (L, "    computed.set(day, p);\n", "    computed.set(day, p);\n    if (dirty.includes(day)) await kv.delete(SALES_DIRTY_PREFIX + day);\n"),
    "M39 divergência de conteúdo não sinalizada": (L, "    for (const [event, set] of g.variants) if (set.size > 1) divergent.push(", "    for (const [event, set] of g.variants) if (false) divergent.push("),
    "M40 recuperação de dias sem projeção desligada": (L, "  const catchUp = Array.from({ length: CATCH_UP_DAYS }", "  const catchUp = Array.from({ length: 0 }"),
}

ALLOW_FILE = Path(os.environ.get("P12_ENTREGA_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p12_entrega_allow.json"))


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
