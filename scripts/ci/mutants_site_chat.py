#!/usr/bin/env python3
"""Mutantes do chat do site (worker/site-chat.mjs, proxy em worker/sales-public-worker.mjs, widget em
sales-overlay/site-chat.{js,css}, política data/site-chat-policy.json, wrangler e gerador das páginas), classificados
pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (#901), no modelo de scripts/ci/mutants_support_email.py
(#900). Auditoria Sol (#897): o runner antigo contava `run_suite(tmp) != 0` como KILLED, sem parser, sem asserção
causal e sem INCONCLUSIVE.

Config: scripts/ci/mutants_site_chat_allow.json, seção "mutants" no formato de load_mutant_config. Por mutante:
primary (1-3) com test_pattern (id do teste, ex. "SC07") E assertion_pattern NÃO nulo (marcador [SCnn.k]/[SWnn.k]/
[SGnn.k]/[SEnn.k] presente na mensagem da asserção, conferido DENTRO do bloco `not ok` daquele teste); secondary com
justification; broad_reason quando há mais de 4 testes. As expectativas foram escritas por raciocínio sobre cada
mutação, antes de rodá-la (docs/evidence/site-chat-mutant-causality.md). Nenhuma allowlist causal.
Validação antes de qualquer mutante (exit 2): baseline diferente de BASELINE_TOTAL testes ou não verde, config
inválida, primária sem marcador, test_pattern que não casa com nenhum teste da baseline, marcador que não existe nos
arquivos de teste, mutante sem config ou config órfã.
KILLED só com asserção primária casada no bloco do teste primário e nada fora de primary ∪ secondary; todo o resto
(outra asserção do mesmo teste primário, falha só em secundário, falha fora da lista, todo/skip/cancelled, TAP
incoerente com plano/resumo, TypeError/queda/timeout/sinal, âncora ausente ou repetida) é INCONCLUSIVE.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Cada mutante altera uma CÓPIA temporária (o repositório nunca é tocado). Sem rede, sem segredo, sem PostgreSQL.
Uso: python3 scripts/ci/mutants_site_chat.py [raiz-do-repo]     |     --doc  (imprime a tabela de causalidade)
"""
import json, os, re, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (#901, sem modificação)

REPO = Path(__file__).resolve().parents[2]  # a linha de comando pode trocar (ver __main__); importado, é a raiz
CHAT = "worker/site-chat.mjs"
SALES = "worker/sales-public-worker.mjs"
JS = "sales-overlay/site-chat.js"
CSS = "sales-overlay/site-chat.css"
GUARD = "tests/site-chat-no-synthetic-traffic.test.mjs"
POLICY = "data/site-chat-policy.json"
SUITES = ["tests/site-chat.test.mjs", "tests/site-chat-widget.test.mjs", "tests/site-chat-no-synthetic-traffic.test.mjs", "tests/site-chat-eval.test.mjs"]
BASELINE_TOTAL = 33  # contagem exata da suíte do chat (igual ao gate do workflow site-chat-contract)
DIRS = ["worker", "data", "tests", "sales-overlay", "sales-public", "scripts", ".github"]
FILES = ["product.css", "wrangler.sales.toml", "wrangler.public-router.toml"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
BAD_WORKFLOW = "jobs:\n  smoke:\n    runs-on: ubuntu-latest\n    steps:\n      - run: curl -X POST https://vendas.zevanory.api.br" + "/api/chat -d '{}'\n"
ALLOW_FILE = Path(os.environ.get("SITE_CHAT_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_site_chat_allow.json"))

M = {
    # interruptor (desligado por padrão, fail-closed)
    "K1 env switch ignored": (CHAT, 'const enabledEnv = String(env.SITE_CHAT_ENABLED || "").toLowerCase() === "true";', "const enabledEnv = true;"),
    "K2 KV kill ignored": (CHAT, 'killed = String(k || "").trim().toLowerCase() === "off";', "killed = false;"),
    "K3 KV error opens chat": (CHAT, "} catch { killed = true; }", "} catch { killed = false; }"),
    "K4 sales proxy ignores switch": (SALES, "if(!siteChatEnabled(env)||!env?.CORE", "if(!env?.CORE"),
    "K5 widget injected while off": (SALES, "SITE_CHAT_PAGES.has(page)&&siteChatEnabled(env);", "SITE_CHAT_PAGES.has(page);"),
    "K6 public host served": (CHAT, 'if (url.hostname !== "chat.internal" || !url.pathname', "if (!url.pathname"),
    # verdade comercial / preço
    "P1 money allowed while closed": (CHAT, "  if (!salesOpen && (/r\\$|\\breais\\b", "  if (false && (/r\\$|\\breais\\b"),
    "P2 generated text not validated": (CHAT, "if (gen.text && validateSiteReply(gen.text, { salesOpen, catalog }).ok)", "if (gen.text)"),
    "P3 closed price answer bypassed": (CHAT, "if (!salesOpen) return { body: CLOSED_PRICE_ANSWER,", "if (false) return { body: CLOSED_PRICE_ANSWER,"),
    "P4 stale catalog trusted": (CHAT, "const stale = fingerprint !== approved;", "const stale = false;"),
    "P5 conflicting source answered": (CHAT, '  if (needsCatalog && (!catalog.ok || (slug && catalog.conflicts.includes(slug)))) return escalate("source_conflict");\n', ""),
    "P6 promise allowed": (CHAT, "  if (/\\b(garanto|garantimos|prometo", "  if (false && /\\b(garanto|garantimos|prometo"),
    "P7 right denial allowed": (CHAT, "  if (/(nao (tem|ha|existe) (direito", "  if (false && /(nao (tem|ha|existe) (direito"),
    "P8 deadline outside source allowed": (CHAT, 'issues.push("deadline_outside_source");', ""),
    # vendas fechadas / checkout
    "C1 checkout mention allowed": (CHAT, 'if (hasCheckoutCta(body) || CHECKOUT_RE.test(body)) issues.push("checkout");', ""),
    "C2 ambiguous sales status = open": (CHAT, "    return v === true;", "    return v !== false;"),
    "C3 sales status error = open": (CHAT, '} catch { breakerFailure("sales_status"); return false; }', '} catch { breakerFailure("sales_status"); return true; }'),
    "C4 widget links checkout": (JS, " && !/^\\/(comprar|assinar)\\b/.test(u.pathname)", ""),
    # limites
    "R1 per-session limit dropped": (CHAT, "    [`s:${s.sess}:m`, minuteWin(now), L.per_session_per_minute], [`i:${ip}:m`", "    [`i:${ip}:m`"),
    "R2 limits never enforced": (CHAT, "const over = buckets.find(([b, , max]) => !(counts.get(b) <= max));", "const over = buckets.find(() => false);"),
    "R3 turn limit removed": (CHAT, "if (s.row.turns >= L.turns_max) {", "if (false) {"),
    "R4 size limit removed": (CHAT, "if (message.length > L.message_max_chars) return json(413", "if (false) return json(413"),
    "R5 KV write per message": (CHAT, "  const salesOpen = await salesOpenNow(deps);", '  await env.ZEVANORY_PRIVATE_ARTIFACTS?.put?.("site-chat:last", "1");\n  const salesOpen = await salesOpenNow(deps);'),
    "R6 breaker never opens": (CHAT, "if (breaker.fails.length >= 3) breaker.openUntil = now + 120_000;", ""),
    # escalonamento
    "E1 escalation without protocol": (CHAT, "      const t = await openTicket(sql, { sess: s.sess, category: reply.escalate.category, now, sandbox: flags.sandbox });", "      const t = null;"),
    "E2 confirmation resent": (CHAT, "let confirmed = Boolean(t.customer_confirmed_at);", "let confirmed = false;"),
    "E3 complaint not escalated": (CHAT, 'for (const cat of ["human_request", "security", "legal", "lgpd", "complaint", "payment"])', 'for (const cat of ["human_request", "security", "legal", "lgpd", "payment"])'),
    "E4 sensitive data not escalated": (CHAT, '  if (red.sensitive) return { kind: "escalate", category: "sensitive_data" };\n', ""),
    "E5 second correction ignored": (CHAT, "if (CORRECTION.test(n) && corrections + 1 >= 2)", "if (CORRECTION.test(n) && corrections + 1 >= 9)"),
    # escalonamento só para suporte@ ou /atendimento; nunca WhatsApp, wa.me ou telefone (#892)
    "E6 whatsapp mention allowed": (CHAT, '  if (WHATSAPP_RE.test(body) || WHATSAPP_PUBLIC_RE.test(body) || BANNED_NUMBER_RE.test(body)) issues.push("whatsapp");\n', ""),
    "E7 phone number allowed": (CHAT, '  if (hasPhoneNumber(body)) issues.push("phone");\n', ""),
    "E8 banned number not flagged as whatsapp": (CHAT, "if (WHATSAPP_RE.test(body) || WHATSAPP_PUBLIC_RE.test(body) || BANNED_NUMBER_RE.test(body))", "if (WHATSAPP_RE.test(body))"),
    "E9 escalation without email/form": (CHAT, "const HANDOFF_ASK = `Informe seu e-mail abaixo para receber a confirmação e a resposta da equipe. Se preferir, escreva para ${SUPPORT_EMAIL} ou use o formulário ${ATENDIMENTO_URL}`;", 'const HANDOFF_ASK = "Informe seu e-mail abaixo para receber a confirmação e a resposta da equipe.";'),
    "E10 form URL rejected by validator": (CHAT, "`${CORE_ORIGIN}/entrega/reenviar`, ATENDIMENTO_URL, ...Object", "`${CORE_ORIGIN}/entrega/reenviar`, ...Object"),
    # privacidade / isolamento
    "L1 message content logged": (CHAT, '  siteChatLog("reply", { category: reply.category, mode: reply.mode, created: Boolean(protocol) });', '  console.log("SITE_CHAT reply", message);'),
    "L2 transcript not redacted": (CHAT, "const stored = redactSensitive(message).text;", "const stored = message;"),
    "S1 synthetic header accepted": (CHAT, 'if (h.get(k)) return sandbox ? "" : "synthetic_header";', 'if (h.get(k)) return "";'),
    "S2 sandbox falls back to Resend": (CHAT, "const mailer = flags.sandbox ? deps.mailer : (deps.mailer || resendMailer(env, deps.fetchImpl));", "const mailer = deps.mailer || resendMailer(env, deps.fetchImpl);"),
    "S3 synthetic email accepted": (CHAT, 'if (!sandbox && body.email && SYNTH_EMAIL.test(String(body.email).trim())) return "synthetic_email";', ""),
    # acessibilidade e 390 px
    "A1 aria-live removed": (JS, '"aria-live": "polite", "aria-relevant": "additions"', '"aria-relevant": "additions"'),
    "A2 Escape does not close": (JS, '    if (e.key === "Escape") { e.preventDefault(); close(); return; }\n', ""),
    "A3 new answer steals focus": (JS, "    log.appendChild(li);", "    log.appendChild(li); input.focus();"),
    "A4 widget opens by itself": (JS, 'document.addEventListener("DOMContentLoaded", mount); else mount();', 'document.addEventListener("DOMContentLoaded", mount); else mount(); open();'),
    "A5 dialog unlabeled": (JS, '"aria-modal": "true", "aria-labelledby": "zc-title", hidden: true', '"aria-modal": "true", hidden: true'),
    "W1 mobile panel not full screen": (CSS, ".zc-panel{inset:0;right:0;bottom:0;width:100%;", ".zc-panel{right:0;bottom:0;width:420px;"),
    "W2 fixed width breaks 256px": (CSS, ".zc-entry{max-width:100%;width:min(960px,calc(100% - 32px));", ".zc-entry{max-width:100%;width:400px;"),
    "W3 panel under the buy-bar": (CSS, "bottom:16px;z-index:40;", "bottom:16px;z-index:10;"),
    "W4 small touch targets": (CSS, "justify-content:center;min-height:44px;min-width:44px;", "justify-content:center;min-height:32px;min-width:44px;"),
    "W5 low contrast": (CSS, "--zc-muted:#b6c2d3", "--zc-muted:#4a5568"),
    # guarda de tráfego sintético
    "G1 synthetic workflow added": (".github/workflows/zz-site-chat-smoke.yml", None, BAD_WORKFLOW),
    "G2 guard rule removed": (GUARD, '  ["chat_endpoint", /\\/api\\/chat\\b/i],\n', ""),
    # padrão desligado em todas as fontes (política, wrangler, gerador, Workers)
    "D1 policy enabled by default": (POLICY, '"enabled_default": false,', '"enabled_default": true,'),
    "D2 wrangler enables chat": ("wrangler.sales.toml", "[vars]\nZEVANORY_SALES_PUBLIC_RELEASE_SHA", "[vars]\nSITE_CHAT_ENABLED = \"true\"\nZEVANORY_SALES_PUBLIC_RELEASE_SHA"),
    "D3 generator injects widget": ("scripts/build_sales_public.py", "        if 'src=\"/whatsapp-contact.js\"' not in html:", "        html = html.replace(\"</body>\", '<script src=\"/site-chat.js\" defer></script></body>', 1)\n        if 'src=\"/whatsapp-contact.js\"' not in html:"),
    "D4 sales worker defaults on": (SALES, 'export const siteChatEnabled=env=>String(env?.SITE_CHAT_ENABLED||"").toLowerCase()==="true";', 'export const siteChatEnabled=env=>String(env?.SITE_CHAT_ENABLED||"true").toLowerCase()==="true";'),
    "D5 central worker defaults on": (CHAT, 'const enabledEnv = String(env.SITE_CHAT_ENABLED || "").toLowerCase() === "true";', 'const enabledEnv = String(env.SITE_CHAT_ENABLED || "true").toLowerCase() === "true";'),
}


def _marker_literal(pattern):
    return isinstance(pattern, str) and pattern and not pattern.startswith("re:")


def load_config(path=None, titles=None, mutants=None, sources=None):
    """Lê e valida a config (load_mutant_config + regras deste runner). Levanta mc.ConfigError."""
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
        if spec["allowlist"]:
            raise mc.ConfigError(f"{mid}: allowlist causal não é permitida neste runner")
        for e in spec["primary"]:
            if not (isinstance(e.get("assertion_pattern"), str) and e["assertion_pattern"].strip()):
                raise mc.ConfigError(f"{mid}: primary sem assertion_pattern (marcador da asserção é obrigatório)")
        for e in spec["primary"] + spec["secondary"]:
            if titles is not None and not any(mc._test_matches(e["test_pattern"], t) for t in titles):
                raise mc.ConfigError(f"{mid}: test_pattern não casa com nenhum teste: {e['test_pattern'][:60]}")
            ap = e.get("assertion_pattern")
            if sources is not None and _marker_literal(ap) and ap not in sources:
                raise mc.ConfigError(f"{mid}: marcador {ap} não existe nos arquivos de teste")
    return cfg


def build(tmp, mutation=None):
    """Copia a árvore; aplica a mutação. Devolve False se a âncora não for única (INCONCLUSIVE)."""
    for d in DIRS:
        shutil.copytree(REPO / d, Path(tmp) / d, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"))
    for f in FILES:
        if (REPO / f).exists():
            shutil.copyfile(REPO / f, Path(tmp) / f)
    if mutation:
        rel, old, new = mutation
        f = Path(tmp, *rel.split("/"))
        if old is None:
            if f.exists():
                return False
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(new, encoding="utf-8")
            return True
        text = f.read_bytes().decode("utf-8").replace("\r\n", "\n")
        if text.count(old) != 1:
            return False
        with open(f, "w", encoding="utf-8", newline="\n") as h:
            h.write(text.replace(old, new, 1))
    return True


def run_suite(root, suites=None):
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": ""}
    env.pop("SITE_CHAT_PG_HOST", None)
    return mc.run_command([NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", *(suites or SUITES)],
                          cwd=str(root), timeout=TIMEOUT, env=env)


def run_mutant(name, mutation, total, spec):
    with tempfile.TemporaryDirectory() as tmp:
        ok = build(tmp, mutation)
        run = run_suite(tmp) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(total, run, expected=spec, allowlist=[], anchor_ok=ok, mutant_id=name)


def test_sources():
    return "\n".join((REPO / s).read_text(encoding="utf-8") for s in SUITES)


def doc_table(path=None):
    raw = json.loads(Path(path or ALLOW_FILE).read_text(encoding="utf-8"))
    changes, specs = raw.get("changes", {}), raw["mutants"]
    fmt = lambda e: f"**{e['test_pattern']}** `{e['assertion_pattern']}`" + (f" — {e['why']}" if e.get("why") else "")
    rows = ["| mutant_id | mudança introduzida | asserção primária (teste + marcador) | secundárias (justificativa causal) |", "|---|---|---|---|"]
    for name in M:
        s = specs[name]
        sec = "<br>".join(f"{e['test_pattern']} `{e.get('assertion_pattern')}`: {e['justification']}" for e in s.get("secondary") or []) or "só primário"
        if s.get("broad_reason"):
            sec += f"<br>*broad_reason:* {s['broad_reason']}"
        rows.append(f"| {name.split(' ')[0]} | {changes.get(name, name)} | " + "<br>".join(fmt(e) for e in s["primary"]) + f" | {sec} |")
    return "\n".join(rows)


def main():
    if "--doc" in sys.argv:
        print(doc_table())
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp)
        base = run_suite(tmp)
    parsed = mc.parse_tap(base.get("stdout", ""), stderr=base.get("stderr", ""))
    vb = mc.validate_baseline(BASELINE_TOTAL, base.get("return_code"), parsed["summary"], parsed["failures"],
                              timed_out=base.get("timed_out", False), signal=base.get("signal"))
    if not vb["ok"]:
        print("BASELINE FAILED", vb["reason"])
        return mc.EXIT_BAD_BASELINE
    titles = [p.get("test_id") for p in parsed["summary"].get("points") or []]
    print(f"BASELINE PASS tests={BASELINE_TOTAL}")
    try:
        cfg = load_config(titles=titles, sources=test_sources())
    except mc.ConfigError as e:
        print("CONFIG_INVALID", e)
        return mc.EXIT_BAD_BASELINE

    def judge(item):
        name, mutation = item
        res = run_mutant(name, mutation, BASELINE_TOTAL, cfg[name])
        if res["verdict"] == mc.INCONCLUSIVE:
            first = res["reason"]
            res = run_mutant(name, mutation, BASELINE_TOTAL, cfg[name])
            if res["verdict"] == mc.INCONCLUSIVE:
                res["reason"] = f"{first} | repetição: {res['reason']}"
        return res

    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 2)) as ex:
        results = list(ex.map(judge, M.items()))
    for r in results:
        print(f"MUTANT {r['mutant_id']} {r['verdict']}" + ("" if r["verdict"] == mc.KILLED else f" ({r['reason'][:300]})"))
        print("RESULT " + json.dumps({k: r.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests", "assertion_ids", "secondary_tests", "unexpected_failures")}, ensure_ascii=False))
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(f"MUTANTS total={len(results)} killed={summary['KILLED']} survived={summary['SURVIVED']} inconclusive={summary['INCONCLUSIVE']}")
    return code


if __name__ == "__main__":
    ARGS = [a for a in sys.argv[1:] if not a.startswith("-")]
    if ARGS:
        REPO = Path(ARGS[0]).resolve()
    sys.exit(main())
