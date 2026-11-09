#!/usr/bin/env python3
"""Mutantes causais do lembrete de abandono Hotmart (worker/abandono-hotmart.mjs, worker/cp-nc011-routing.mjs,
migrations/d1/0003_abandono_v1.sql), classificados pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py
(sem modificação). Plano de abandono, Revisão 5b, seção 5.2: M01-M53; M54-M58 cobrem as condições do GPT-6
(reconciliação paginada sem ambiguidade/incompletude -> enviado; compra concorrente sem leitura atrasada; sem sessões);
M59-M61 cobrem a supressão manual (token de operador, só pseudônimo) e a regra de DDL em worker/**; M62-M65, as
observações da contra-auditoria (página vazia, gancho com D1 falhando, html no filtro, prefixo Bearer).

Suíte (uma execução `node --test`, TAP): tests/abandono-hotmart.test.mjs (AB1-AB11, REG) + tests/abandono-ensaio.test.mjs
(EN1-EN5), com D1 que executa SQL de verdade (node:sqlite) aplicando as migrações reais. Sem rede, sem Cloudflare, sem
Resend, sem segredos. Cada mutante altera UMA regra (uma ou mais edições ancoradas, cada âncora única) numa cópia da
árvore em diretório temporário; o repositório nunca é alterado.
Expectativas (mutants_abandono_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [ABn.k]/[ENn]/[REG.n] da asserção que codifica a regra), secondary com
justification. Validação antes de qualquer mutante (exit 2): config inválida, primary sem marcador, test_pattern que não
casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_abandono.py [raiz-do-repo] [--discover]
  --discover  só imprime, por mutante, os testes/marcadores que falharam (conferência manual; não classifica).
"""
import json, os, re, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
DISCOVER = "--discover" in sys.argv[1:]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/abandono-hotmart.test.mjs", "tests/abandono-ensaio.test.mjs"]
COPY_DIRS = ["worker", "data", "migrations", "tests/helpers", "tests/t4_sim"]
COPY_FILES = TESTS + ["admin.css"]
TIMEOUT = 600
NODE = shutil.which("node") or "node"
J, R, S = "worker/abandono-hotmart.mjs", "worker/cp-nc011-routing.mjs", "migrations/d1/0003_abandono_v1.sql"

HOTTOK_401 = '  if (!given || !(await constantTimeEqual(given, secret))) return json(401, { ok: false, error: "unauthorized" });\n'
ELSE_RETRY = "    } else {\n      beat.retry++;\n    }\n  }"
RESERVA_COMPRA = "WHERE NOT EXISTS (SELECT 1 FROM abandono_compra_v1 WHERE ref=?1 AND criado_ms > ?6)\n  AND NOT EXISTS (SELECT 1 FROM abandono_supressao_v1 WHERE ref=?1)\n  AND (SELECT count"
INGEST_CHECK = ('  if (check.unavailable || !check.value) return done("d1_unavailable");\n  if (check.value.sup) return done("suppressed");\n'
                '  if (check.value.compra) return done("buyer");\n  if (check.value.envio) return done("dedupe");\n')

M = {
    "M01 hottok sempre aceito": [(J, HOTTOK_401, "")],
    "M02 hottok comparado por startsWith": [(J, HOTTOK_401, '  if (!given || !secret.startsWith(given)) return json(401, { ok: false, error: "unauthorized" });\n')],
    "M03 segredo ausente aceita o evento": [(J, '  if (secret.length < 16) return json(503, { ok: false, error: "hotmart_not_configured" });\n  const given = request.headers.get("x-hotmart-hottok");\n' + HOTTOK_401,
        '  if (secret.length >= 16) { const given = request.headers.get("x-hotmart-hottok"); if (!given || !(await constantTimeEqual(given, secret))) return json(401, { ok: false, error: "unauthorized" }); }\n')],
    "M04 lista de produtos aceita qualquer ID": [(J, "? KIT_BY_PRODUCT_ID[productId] : null;", '? KIT_BY_PRODUCT_ID[productId] : "ia-na-pratica";')],
    "M05 purchaseOpenFor ignorado na ingestão": [(J, '  if ((await purchaseOpenFor(env, slug)) !== true) return done("sales_closed");\n', "")],
    "M06 purchaseOpenFor ignorado no envio": [(J, "    if ((await purchaseOpenFor(env, pend.slug)) !== true) { await abandonPend(ref); continue; }\n", "")],
    "M07 dedupe por produto em vez de global": [(J, "(SELECT 1 FROM abandono_envio_v1 WHERE ref=?1) AS envio`, ref, now - DEDUPE_MS));", "(SELECT 1 FROM abandono_envio_v1 WHERE ref=?1 AND slug=?3) AS envio`, ref, now - DEDUPE_MS, slug));")],
    "M08 e-mail sem normalização no ref": [(J, '"abandono:v1:" + normalizeEmail(email)) : null;', '"abandono:v1:" + String(email ?? "")) : null;')],
    "M09 meta.changes da reserva ignorado": [(J, "    if (res.value !== 1) {\n      const st = ", "    if (false) {\n      const st = ")],
    "M10 compra não apaga a pendência": [(J, "  try { if (kv?.get && (await kv.get(PEND_PREFIX + ref))) await kv.delete(PEND_PREFIX + ref); } catch {}\n  if (wrote.unavailable)", "  if (wrote.unavailable)")],
    "M11 marcador de compra não consultado na ingestão": [(J, '  if (check.value.compra) return done("buyer");\n', "")],
    "M12 retenção apaga a supressão": [(J, 'await run(db, "DELETE FROM abandono_compra_v1 WHERE criado_ms < ?1", cut)]);', 'await run(db, "DELETE FROM abandono_compra_v1 WHERE criado_ms < ?1", cut), await run(db, "DELETE FROM abandono_supressao_v1 WHERE criado_ms < ?1", cut)]);')],
    "M13 supressão fora da instrução de reserva": [(J, "  AND NOT EXISTS (SELECT 1 FROM abandono_supressao_v1 WHERE ref=?1)\n  AND (SELECT count", "  AND (SELECT count")],
    "M14 retenção de abandono_envio_v1 de 1 dia": [(J, '"DELETE FROM abandono_envio_v1 WHERE criado_ms < ?1", cut)', '"DELETE FROM abandono_envio_v1 WHERE criado_ms < ?1", now - 86400000)')],
    "M15 descarte de pendência velha removido": [(J, "    if (!(Number(pend.received_at) >= now - STALE_MS)) { await abandonPend(ref); continue; }\n", "")],
    "M16 console.info com o e-mail": [(J, '  return done("queued", 202);', '  console.info("abandono_debug", email);\n  return done("queued", 202);')],
    "M17 ABANDONO_STAGE ignorado na ingestão": [(J, '  if (stage === "desligado") return done("disabled");\n  if (stage === "aquecimento") return done("aquecimento");\n', "")],
    "M18 desvio de roteamento removido": [(R, 'if(String(body?.event||"").toUpperCase()==="PURCHASE_OUT_OF_SHOPPING_CART")return handleHotmartAbandonment(request,env);\n', "")],
    "M19 hotmartLockViolations não checado": [(J, '      if (abandonmentLockViolations(mail).length) throw new Error("lock");\n', "")],
    "M20 List-Unsubscribe-Post removido": [(J, ', "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }', " }")],
    "M21 guarda desligado removida de noteHotmartPurchase": [(J, '  if (stageOf(opts) === "desligado") return { skipped: "disabled" };\n  const productId = String(data?.product?.id ?? "");\n  if (!Object.prototype.hasOwnProperty.call(KIT_BY_PRODUCT_ID, productId)) return { skipped: "product_not_allowed" };',
        '  const productId = String(data?.product?.id ?? "");\n  if (!Object.prototype.hasOwnProperty.call(KIT_BY_PRODUCT_ID, productId)) return { skipped: "product_not_allowed" };')],
    "M22 erro do Resend apaga a pendência": [(J, ELSE_RETRY, "    } else {\n      beat.retry++;\n      await dropPend(ref);\n    }\n  }")],
    "M23 erro do Resend marca nao_confirmado": [(J, ELSE_RETRY, '    } else {\n      beat.retry++;\n      await close(ref, "reservado");\n    }\n  }')],
    "M24 teto diário com <= em vez de <": [(J, "  AND (SELECT count(*) FROM abandono_envio_v1 WHERE dia=?3) < ?7", "  AND (SELECT count(*) FROM abandono_envio_v1 WHERE dia=?3) <= ?7")],
    "M25 429 não interrompe a execução": [(J, "      beat.retry++;\n      stop = true;", "      beat.retry++;")],
    "M26 regra de país trocada por XX": [(J, 'iso.trim().toUpperCase() !== "BR") return done("non_br");', 'iso.trim().toUpperCase() === "XX") return done("non_br");')],
    "M27 sonda depois da checagem de version/event": [(J, '  console.info("abandono_shape", JSON.stringify(shape));\n  if (!shape.version_ok || !shape.event_ok) return json(422, { ok: false, error: "invalid_hotmart_event" });\n',
        '  if (!shape.version_ok || !shape.event_ok) return json(422, { ok: false, error: "invalid_hotmart_event" });\n  console.info("abandono_shape", JSON.stringify(shape));\n')],
    "M28 sonda loga e-mail e ID do produto": [(J, '  console.info("abandono_shape", JSON.stringify(shape));\n', '  console.info("abandono_shape", JSON.stringify({ ...shape, email: data?.buyer?.email, product: productId }));\n')],
    "M29 BILLET_PRINTED fora do gancho": [(J, '"PURCHASE_COMPLETE", "PURCHASE_BILLET_PRINTED", "PURCHASE_DELAYED"]', '"PURCHASE_COMPLETE", "PURCHASE_DELAYED"]')],
    "M30 gancho fora do ramo KIT_ORDER_INGEST_ENABLED": [(R, "  if(!digital.ok)return digital;\n  await abandonoPurchaseHook(env,body);\n", "  if(!digital.ok)return digital;\n")],
    "M31 token t comparado com !==": [(J, "  if (!(await constantTimeEqual(t, expected))) return page(", "  if (t !== expected) return page(")],
    "M32 dreno inline quando o SELF falha": [(J, "  const out = await dispatchSelf(env, DRAIN_PATH, keyDrain(s), nowMs);\n  return beatOf(out.via, out.result);",
        '  const out = await dispatchSelf(env, DRAIN_PATH, keyDrain(s), nowMs);\n  if (out.via === "self_failed") return beatOf("inline", await runAbandonmentDue(env, { ...opts, now: nowMs }));\n  return beatOf(out.via, out.result);')],
    "M33 rota de dreno aceita sem token": [(J, "  if (!s || !(await internalAuthorized(request, keyDrain(s), DRAIN_PATH, nowMs))) return json(401,", "  if (!s) return json(401,")],
    "M34 preço por literal no texto": [(J, "  const p = productBySlug(slug);\n  const [s2, s3]", "  const p = { ...productBySlug(slug), price: 97 };\n  const [s2, s3]")],
    "M35 409 de idempotência marcado como enviado": [(J, "    } else if (out.kind === \"reconcile\") {\n      await d1(env, (db) => run(db, \"UPDATE abandono_envio_v1 SET estado='reconciliar', tentativas=0 WHERE",
        "    } else if (out.kind === \"reconcile\") {\n      await d1(env, (db) => run(db, \"UPDATE abandono_envio_v1 SET estado='enviado', resend_id='sem-confirmacao' WHERE")],
    "M36 dispatchAbandonmentDrain sem conferir o estágio": [(J, '  if (stageOf(opts) !== "ativo") return { skipped: "disabled" };\n  if (!env?.DIARIO) return { skipped: "d1_unavailable" };\n  const s = privacySecret(env);\n  if (!s) return { skipped: "not_configured" };\n  const out = await dispatchSelf(env, DRAIN_PATH',
        '  if (!env?.DIARIO) return { skipped: "d1_unavailable" };\n  const s = privacySecret(env);\n  if (!s) return { skipped: "not_configured" };\n  const out = await dispatchSelf(env, DRAIN_PATH')],
    "M37 409 tratado como erro comum": [(J, '    if (r.status === 409 && (payload?.name === "invalid_idempotent_request" || payload?.name === "concurrent_idempotent_requests")) return { kind: "reconcile" };\n', "")],
    "M38 reconciliação sem conferir a tag": [(J, '    if (tag(RESEND_TAG.name) === RESEND_TAG.value && tag("abandono_ref") === ref.slice(0, 40) && item.subject === subject', "    if (item.subject === subject")],
    "M39 RECONCILE_MAX ignorado": [(J, "        } else if (n >= RECONCILE_MAX || !pend || ", "        } else if (!pend || ")],
    "M40 retomada além de 23 h": [(J, "export const RETRY_WINDOW_MS = 23 * 3600_000;", "export const RETRY_WINDOW_MS = 48 * 3600_000;")],
    "M41 retomada sem conferir body_sha": [(J, "      if (row.body_sha !== bodySha) {", "      if (false) {")],
    "M42 marcador de compra fora da instrução de reserva": [(J, RESERVA_COMPRA, "WHERE NOT EXISTS (SELECT 1 FROM abandono_supressao_v1 WHERE ref=?1)\n  AND (SELECT count")],
    "M43 gancho de compra não aguardado": [(R, "try{await noteHotmartPurchase(env,body?.data).catch(()=>null)}catch{}", "try{noteHotmartPurchase(env,body?.data).catch(()=>null)}catch{}")],
    "M44 aquecimento cria pendência": [(J, '  if (stage === "aquecimento") return done("aquecimento");\n', "")],
    "M45 sem D1 a ingestão cria pendência": [(J, '  if (!env?.DIARIO) return done("d1_unavailable");\n  const email', "  const email"),
        (J, INGEST_CHECK, '  if (check.value?.sup) return done("suppressed");\n  if (check.value?.compra) return done("buyer");\n  if (check.value?.envio) return done("dedupe");\n')],
    "M46 batimento do dreno com ref": [(J, "  return { ok: true, supkv_fundidas: fusion.fused, ...beat };", "  return { ok: true, supkv_fundidas: fusion.fused, ...beat, due: (listed?.keys || []).map((k) => String(k.name)) };")],
    "M47 d1() relança o erro": [(J, "  try { return { ok: true, value: await fn(db) }; } catch { return { unavailable: true }; }", "  return { ok: true, value: await fn(db) };")],
    "M48 gatilho de DELETE removido da 0003": [(S, "CREATE TRIGGER IF NOT EXISTS abandono_supressao_v1_sem_delete\nBEFORE DELETE ON abandono_supressao_v1\nBEGIN\n  SELECT RAISE(ABORT, 'abandono_supressao_v1_permanente');\nEND;\n", "")],
    "M49 retenção só no estágio ativo": [(J, '  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();\n  if (stageOf(opts) === "desligado") return { skipped: "disabled" };\n  if (!env?.DIARIO) return { at:',
        '  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();\n  if (stageOf(opts) !== "ativo") return { skipped: "disabled" };\n  if (!env?.DIARIO) return { at:')],
    "M50 descadastro sem supkv": [(J, 'return page(400, "Link inválido", "O link de descadastro não confere.");\n  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;\n  let kvOk = false;\n  try { await kv.put(SUPKV_PREFIX + ref, JSON.stringify({ at: now })); kvOk = true; } catch {}\n',
        'return page(400, "Link inválido", "O link de descadastro não confere.");\n  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;\n  let kvOk = false;\n')],
    "M51 reconciliação compara o to antes do subject": [(J, '      if (item?.subject !== subject) continue;\n      if (!Number.isFinite(created)) return { incomplete: "date" };\n      if (created < start || created > end) continue;\n      if (toList(item?.to).includes(target)) {',
        '      const hit = toList(item?.to).includes(target);\n      if (item?.subject !== subject) continue;\n      if (!Number.isFinite(created)) return { incomplete: "date" };\n      if (created < start || created > end) continue;\n      if (hit) {')],
    "M52 supressão gravada com INSERT OR REPLACE": [(J, '"INSERT OR IGNORE INTO abandono_supressao_v1 (ref, criado_ms) VALUES (?1, ?2)"', '"INSERT OR REPLACE INTO abandono_supressao_v1 (ref, criado_ms) VALUES (?1, ?2)"')],
    "M53 descadastro 503 mesmo com supkv gravado": [(J, "  if (!kvOk && db.unavailable) return page(503", "  if (db.unavailable) return page(503")],
    "M54 reconciliação lê só a primeira página": [(J, "    if (!listed.has_more || oldest < start) { complete = true; break; }", "    complete = true; break;")],
    "M55 reconciliação ambígua vira enviado": [(J, "  if (confirmed.length > 1) return { ambiguous: confirmed.length };", "  if (confirmed.length > 1) return { found: confirmed[0] };")],
    "M56 consulta incompleta tratada como completa": [(J, '  if (!complete) return { incomplete: "pages" };\n', "")],
    "M57 compra decidida por leitura separada antes da reserva": [(J, RESERVA_COMPRA, "WHERE NOT EXISTS (SELECT 1 FROM abandono_supressao_v1 WHERE ref=?1)\n  AND (SELECT count"),
        (J, "    const res = await reserveSend(env, { ref, slug: pend.slug, now, bodySha });",
         '    const pre = await d1(env, (db) => first(db, "SELECT 1 AS c FROM abandono_compra_v1 WHERE ref=?1 AND criado_ms > ?2", ref, since));\n'
         "    if (pre.value?.c) { await dropPend(ref); beat.canceled++; continue; }\n    const res = await reserveSend(env, { ref, slug: pend.slug, now, bodySha });")],
    "M59 supressão manual sem token de operador": [(J, '  if (!bearer || !verifyOperatorToken(env, bearer, { minLength: 32, log: null })) return json(401, { ok: false, error: "unauthorized" });\n', "")],
    "M60 supressão manual grava o e-mail": [(J, "  const ref = await abandonoRef(env, body.email);\n  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;\n  let kvOk = false;\n  try { await kv.put(SUPKV_PREFIX + ref, JSON.stringify({ at: now }));",
        "  const ref = await abandonoRef(env, body.email);\n  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;\n  let kvOk = false;\n  try { await kv.put(SUPKV_PREFIX + ref, JSON.stringify({ at: now, email: body.email }));")],
    "M61 retenção remove o gatilho da supressão (DDL no worker)": [(J, "    const cut = now - DEDUPE_MS;\n    const del =", '    const cut = now - DEDUPE_MS;\n    await d1(env, (db) => run(db, "DROP TRIGGER IF EXISTS abandono_supressao_v1_sem_delete"));\n    const del =')],
    "M58 D1 com API de sessões (read replicas)": [(J, "  const db = env?.DIARIO;\n", '  const db = typeof env?.DIARIO?.withSession === "function" ? env.DIARIO.withSession("first-unconstrained") : env?.DIARIO;\n')],
    "M62 página vazia com has_more tratada como fim da lista": [(J, '    if (listed.has_more && !listed.data.length) return { incomplete: "empty_page" };\n', "")],
    "M63 gancho de compra retorna antes de apagar a pendência quando o D1 falha": [(J, '  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;\n  try { if (kv?.get && (await kv.get(PEND_PREFIX + ref))) await kv.delete(PEND_PREFIX + ref); } catch {}\n  if (wrote.unavailable) return { skipped: "d1_unavailable" };\n',
        '  if (wrote.unavailable) return { skipped: "d1_unavailable" };\n  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;\n  try { if (kv?.get && (await kv.get(PEND_PREFIX + ref))) await kv.delete(PEND_PREFIX + ref); } catch {}\n')],
    "M64 filtro de conteúdo não checa o html enviado": [(J, "    ...hotmartLockViolations(maskFixed(mail, mail.html), mail.slug),\n", "")],
    "M65 supressão manual sem exigir o prefixo Bearer": [(J, '  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";', '  const bearer = auth.replace(/^Bearer /, "");')],
}

ALLOW_FILE = Path(os.environ.get("ABANDONO_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_abandono_allow.json"))


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


def build(tmp, edits=()):
    for rel in COPY_DIRS:
        shutil.copytree(Path(REPO, *rel.split("/")), Path(tmp, *rel.split("/")), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for rel in COPY_FILES:
        dst = Path(tmp, *rel.split("/"))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(REPO, *rel.split("/")), dst)
    for rel, old, new in edits:
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


def run_mutant(name, edits, total, spec):
    with tempfile.TemporaryDirectory() as tmp:
        ok = build(tmp, edits)
        run = run_suite(tmp) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(total, run, expected=spec, allowlist=spec.get("allowlist") or [], anchor_ok=ok, mutant_id=name), run


def discover(name, edits):
    with tempfile.TemporaryDirectory() as tmp:
        ok = build(tmp, edits)
        run = run_suite(tmp) if ok else {"stdout": ""}
    parsed = mc.parse_tap(run.get("stdout", ""), stderr=run.get("stderr", ""))
    fails = []
    for f in parsed["failures"]:
        if f.get("is_suite"):
            continue
        lab = re.search(r"\[(?:AB|EN|REG)[0-9.]+[a-z]?(?:/[a-z0-9]+)?\]", f.get("error") or f.get("block") or "")
        fails.append(f"{f.get('test_id', '?')[:40]} {lab.group(0) if lab else '(sem marcador:' + (f.get('kind') or '?') + ') ' + (f.get('error') or '')[:160]}")
    return name, ok, fails


def main():
    if DISCOVER:
        with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
            for name, ok, fails in ex.map(lambda kv: discover(*kv), M.items()):
                print(f"DISCOVER {name} anchor_ok={ok}")
                for f in fails:
                    print("   ", f)
        return 0
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
        name, edits = item
        res, _ = run_mutant(name, edits, total, cfg[name])
        if res["verdict"] == mc.INCONCLUSIVE:
            first = res["reason"]
            res, _ = run_mutant(name, edits, total, cfg[name])
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
