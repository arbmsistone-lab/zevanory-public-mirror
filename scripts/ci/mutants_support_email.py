#!/usr/bin/env python3
"""Mutantes do encaminhamento suporte@ (worker/support-email-forward.mjs + fiação no compat).
Cada mutante altera uma CÓPIA temporária (o original nunca é modificado), roda
tests/support-email-forward.test.mjs contra ela e precisa FALHAR (KILLED).
Imprime `MUTANT <id> KILLED|SURVIVED`; sai != 0 se algum sobreviver ou se a suíte sem mutação falhar.
Sem rede, sem segredo, sem PostgreSQL. Uso: python3 scripts/ci/mutants_support_email.py [raiz-do-repo]
"""
import os, shutil, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
FWD = "worker/support-email-forward.mjs"
COMPAT = "worker/cloudflare-worker.compat.mjs"
COPY = [FWD, COMPAT, "worker/politica-unica.mjs", "worker/sandbox-proof-v2.mjs", "data/politica-unica.json",
        "tests/support-email-forward.test.mjs", "tests/helpers/text.mjs"]

M = {
    # assinatura (fail-closed)
    "S1 signature check bypassed": (FWD, "  if (!ok) {\n    log(\"signature_rejected\");", "  if (false) {\n    log(\"signature_rejected\");"),
    "S2 timestamp tolerance ignored": (FWD, "if (Math.abs(Math.floor(nowMs / 1000) - ts) > TOLERANCE_S) return false;", ""),
    "S3 any v1 value accepted": (FWD, 'return version === "v1" && Boolean(value) && safeEqual(value, expected);', 'return version === "v1" && Boolean(value);'),
    "S4 missing secret accepted": (FWD, '!String(secret || "").startsWith("whsec_")', 'false'),
    # encaminhamento
    "F1 reply-to dropped": (FWD, '...(sender ? { reply_to: [sender] } : {})', '...{}'),
    "F2 subject prefix dropped": (FWD, "const subject = `${FORWARD_SUBJECT_PREFIX} ${cleanSubject(", "const subject = `${cleanSubject("),
    "F3 forward target hardcoded fallback": (FWD, '  if (!EMAIL_RE.test(v)) return "";\n  // Encaminhar', '  if (!EMAIL_RE.test(v)) v = "owner@gmail.com";\n  // Encaminhar'),
    "F4 self-domain forward allowed": (FWD, 'if (v.endsWith("@" + SUPPORT_DOMAIN)) return "";', ''),
    "F5 contato alias removed": (FWD, 'SUPPORT_ALIASES = Object.freeze(["suporte", "contato"])', 'SUPPORT_ALIASES = Object.freeze(["suporte"])'),
    "F6 content logged": (FWD, 'log("forwarded", { alias, attachments: attachments.length, ack });', 'log("forwarded", { alias, attachments: attachments.length, ack, text });'),
    "F7 send key used to read received mail": (FWD, "const rKey = await receivingKey(env);", "const rKey = sendKey;"),
    # idempotência
    "D1 duplicate re-forwarded": (FWD, "  if (!Array.isArray(claim) || !claim.length) {", "  if (false) {"),
    "D2 failure not marked for retry": (FWD, "      await markFailed();\n      log(\"forward_failed\", { alias, status: Number(sent?.status) || 0 });", "      log(\"forward_failed\", { alias, status: Number(sent?.status) || 0 });"),
    "D3 forward without dedupe when DB is down": (FWD, '    log("dedupe_unavailable", { alias });\n    return json(503, { error: "support_dedupe_unavailable", accepted: false });\n  }\n  if (!Array', '    claim = [{}];\n  }\n  if (!Array'),
    # laço / confirmação
    "L1 auto-submitted ignored": (FWD, 'if (auto && auto !== "no") return "auto_submitted";', ''),
    "L2 automated verdict ignored": (FWD, 'if (automated) return "skipped_" + automated;', ''),
    "L3 per-sender rate limit removed": (FWD, 'if (Number(recent?.[0]?.n) > 0) return "rate_limited_sender";', ''),
    "L4 noreply sender acked": (FWD, 'return "noreply_sender";', 'return "";'),
    "L5 own domain acked": (FWD, 'if (domain === SUPPORT_DOMAIN || domain.endsWith("." + SUPPORT_DOMAIN)) return "own_domain";', ''),
    "L6 ack without Auto-Submitted": (FWD, '"Auto-Submitted": "auto-replied", ', ''),
    # caminho da sandbox / legado inalterado
    "P1 sandbox address handled here": (FWD, "  if (!alias) return null;", "  if (!alias) return json(200, { accepted: true, ignored: true });"),
    "P2 delivery events swallowed": (FWD, 'if (event?.type !== "email.received") return null;', 'if (event?.type !== "email.received") return json(200, { accepted: true });'),
    "P3 original body consumed": (FWD, "const raw = await request.clone().text();", "const raw = await request.text();"),
    "W1 compat wiring removed": (COMPAT, "      if (support) return support;\n", ""),
}


def sub(text, old, new):
    assert text.count(old) == 1, f"âncora não única/ausente: {old[:60]!r}"
    return text.replace(old, new, 1)


def run_suite(root):
    env = {**os.environ, "NODE_NO_WARNINGS": "1"}
    p = subprocess.run(["node", "--test", "tests/support-email-forward.test.mjs"], cwd=root, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=180, env=env, stdin=subprocess.DEVNULL)
    return p.returncode


def build(tmp, mutation=None):
    for rel in COPY:
        dst = Path(tmp) / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO / rel, dst)
    if mutation:
        rel, old, new = mutation
        f = Path(tmp) / rel
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
