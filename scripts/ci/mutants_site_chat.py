#!/usr/bin/env python3
"""Mutantes do chat do site (worker/site-chat.mjs, proxy em worker/sales-public-worker.mjs, widget em
sales-overlay/site-chat.{js,css}, guarda de tráfego sintético). Cada mutante altera uma CÓPIA temporária do
repositório (o original nunca é tocado), roda as quatro suítes do chat e precisa FALHAR (KILLED).
Imprime `MUTANT <id> KILLED|SURVIVED`; sai != 0 se algum sobreviver ou se a suíte sem mutação falhar.
Sem rede, sem segredo, sem PostgreSQL. Uso: python3 scripts/ci/mutants_site_chat.py [raiz-do-repo]
"""
import os, shutil, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
CHAT = "worker/site-chat.mjs"
SALES = "worker/sales-public-worker.mjs"
JS = "sales-overlay/site-chat.js"
CSS = "sales-overlay/site-chat.css"
GUARD = "tests/site-chat-no-synthetic-traffic.test.mjs"
SUITES = ["tests/site-chat.test.mjs", "tests/site-chat-widget.test.mjs", "tests/site-chat-no-synthetic-traffic.test.mjs", "tests/site-chat-eval.test.mjs"]
DIRS = ["worker", "data", "tests", "sales-overlay", "sales-public", "scripts", ".github"]
FILES = ["product.css", "wrangler.sales.toml", "wrangler.public-router.toml"]
BAD_WORKFLOW = "jobs:\n  smoke:\n    runs-on: ubuntu-latest\n    steps:\n      - run: curl -X POST https://vendas.zevanory.api.br" + "/api/chat -d '{}'\n"

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
}


def sub(text, old, new):
    assert text.count(old) == 1, f"âncora não única/ausente: {old[:70]!r}"
    return text.replace(old, new, 1)


def run_suite(root):
    env = {**os.environ, "NODE_NO_WARNINGS": "1"}
    env.pop("SITE_CHAT_PG_HOST", None)
    p = subprocess.run(["node", "--test", *SUITES], cwd=root, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=300, env=env, stdin=subprocess.DEVNULL)
    return p.returncode


def build(tmp, mutation=None):
    for d in DIRS:
        shutil.copytree(REPO / d, Path(tmp) / d, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"))
    for f in FILES:
        if (REPO / f).exists():
            shutil.copyfile(REPO / f, Path(tmp) / f)
    if mutation:
        rel, old, new = mutation
        f = Path(tmp) / rel
        if old is None:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(new, encoding="utf-8")
        else:
            f.write_text(sub(f.read_text(encoding="utf-8"), old, new), encoding="utf-8")


def one(item):
    name, mutation = item
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp, mutation)
        return name, run_suite(tmp) != 0


def main():
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp)
        if run_suite(tmp) != 0:
            print("BASELINE FAILED")
            return 2
    print("BASELINE PASS")
    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 2)) as ex:
        results = list(ex.map(one, M.items()))
    survived = [n for n, killed in results if not killed]
    for n, killed in results:
        print(f"MUTANT {n} {'KILLED' if killed else 'SURVIVED'}")
    print(f"MUTANTS total={len(results)} killed={len(results) - len(survived)} survived={len(survived)}")
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(main())
