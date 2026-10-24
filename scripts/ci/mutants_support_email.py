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
        "tests/support-email-forward.test.mjs", "tests/helpers/text.mjs", "docs/ops/EMAIL_SUPORTE.md",
        "scripts/deploy/prepare-central-candidate.py"]

M = {
    # assinatura (fail-closed)
    "S1 signature check bypassed": (FWD, "  if (!ok) {\n    log(\"signature_rejected\");", "  if (false) {\n    log(\"signature_rejected\");"),
    "S2 timestamp tolerance ignored": (FWD, "if (Math.abs(Math.floor(nowMs / 1000) - ts) > TOLERANCE_S) return false;", ""),
    "S3 any v1 value accepted": (FWD, 'return version === "v1" && Boolean(value) && safeEqual(value, expected);', 'return version === "v1" && Boolean(value);'),
    "S4 missing secret accepted": (FWD, '!String(secret || "").startsWith("whsec_")', 'false'),
    # encaminhamento / destino
    "F1 reply-to dropped": (FWD, '...(replyTo ? { reply_to: [replyTo] } : {})', '...{}'),
    "F2 subject prefix dropped": (FWD, "subject: `${FORWARD_SUBJECT_PREFIX} ${cleanSubject(detail.subject)}`", "subject: `${cleanSubject(detail.subject)}`"),
    "F3 forward target hardcoded fallback": (FWD, '  if (!EMAIL_RE.test(v)) return "";\n  if (v.endsWith', '  if (!EMAIL_RE.test(v)) v = "owner@gmail.com";\n  if (v.endsWith'),
    "F4 self-domain forward allowed": (FWD, 'if (v.endsWith("@" + SUPPORT_DOMAIN)) return ""; // suporte@ -> suporte@ seria laço', ''),
    "F5 contato alias removed": (FWD, 'SUPPORT_ALIASES = Object.freeze(["suporte", "contato"])', 'SUPPORT_ALIASES = Object.freeze(["suporte"])'),
    "F6 content logged": (FWD, 'log("forwarded", { alias: row.alias, attachments: attachments.length, ack: status });', 'log("forwarded", { alias: row.alias, attachments: attachments.length, ack: status, text });'),
    "F7 send key used to read received mail": (FWD, "const rKey = await receivingKey(env);", "const rKey = sendKey;"),
    # (4) dono nunca exposto
    "O1 forward sent from owner address": (FWD, "from: FROM, to: [c.forwardTo], subject: `${FORWARD_SUBJECT_PREFIX} ${cleanSubject(", "from: c.forwardTo, to: [c.forwardTo], subject: `${FORWARD_SUBJECT_PREFIX} ${cleanSubject("),
    "O2 ack reply-to points to owner": (FWD, "reply_to: [SUPPORT_ADDRESS], subject: \"Recebemos", "reply_to: [c.forwardTo], subject: \"Recebemos"),
    "O3 ack sent from owner address": (FWD, "body: { from: FROM, to: [sender]", "body: { from: c.forwardTo, to: [sender]"),
    # (1) outbox durável
    "D1 duplicate re-forwarded (no lease state check)": (FWD, "where email_id = $1 and state in ('forward_pending','ack_pending') and next_attempt_at <= now()\n      and (lease_until", "where email_id = $1 and next_attempt_at <= now()\n      and (lease_until"),
    "D2 ack failure finalizes (never retried)": (FWD, '  if (!sent.ok) return failSend(c, emailId, row, "ack", sent);', '  if (!sent.ok) { await c.sql.query(SQL.acked, [emailId]); return { state: "done" }; }'),
    "D3 forward failure goes dead at once": (FWD, 'return retry(c, emailId, row, step, "send", "send_" + reason, { permanent: cls === "permanent" || cls === "not_found" });', 'return retry(c, emailId, row, step, "send", "send_" + reason, { permanent: true });'),
    "D4 backoff ignored": (FWD, "and state in ('forward_pending','ack_pending') and next_attempt_at <= now()\n      and (lease_until", "and state in ('forward_pending','ack_pending')\n      and (lease_until"),
    "D5 lease ignored": (FWD, "      and (lease_until is null or lease_until < now())\n      and attempts < $2 and created_at > now() - make_interval(hours => $3::int)\n      and read_failures < $4 and send_failures < $5\n    returning state", "      and attempts < $2 and created_at > now() - make_interval(hours => $3::int)\n      and read_failures < $4 and send_failures < $5\n    returning state"),
    "D6 no dead state (infinite retries)": (FWD, "  const force = permanent || Number(row?.attempts) >= MAX_ATTEMPTS || !withinBudget(row);", "  const force = false;"),
    "D7 forward idempotency key dropped": (FWD, 'idempotencyKey: `support-fwd/${emailId}`', 'idempotencyKey: ""'),
    "D8 ack idempotency key dropped": (FWD, 'idempotencyKey: `support-ack/${emailId}`', 'idempotencyKey: ""'),
    "D9 webhook fails when step fails (not durable 200)": (FWD, 'return json(200, { accepted: true, duplicate, alias, state: result.state, ack: result.ack });', 'return json(result.state === "done" ? 200 : 503, { accepted: true, duplicate, alias, state: result.state, ack: result.ack });'),
    "D10 cron drain removed": (COMPAT, "  await dispatchSupportDrain(normalized, { sqlFactory: whatsappProofDatabase })", "  void (dispatchSupportDrain, { sqlFactory: whatsappProofDatabase })"),
    # (2) cota atômica
    "Q1 sender quota not enforced": (FWD, "on conflict (bucket, day) do nothing returning 1 as ok", "on conflict (bucket, day) do update set n = zevanory_support_ack_quota.n + 1 returning 1 as ok"),
    "Q2 daily cap not enforced": (FWD, "where zevanory_support_ack_quota.n < $3", ""),
    "Q3 global reserved even without sender slot": (FWD, "select 'all', $2::date, 1 from s", "select 'all', $2::date, 1 from r"),
    "Q4 row lock dropped": (FWD, "where email_id = $1 and state = 'forward_pending' for update", "where email_id = $1 and state = 'forward_pending'"),
    # (3) HMAC
    "H1 plain hash instead of HMAC": (FWD, 'const mac = await hmacSign(new TextEncoder().encode("zevanory-support-sender-v1:" + secret), "sender:" + String(address || "invalid").toLowerCase());', 'const mac = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(address || "invalid").toLowerCase())));'),
    "H2 missing privacy secret accepted": (FWD, "return v.length >= 32 ? v : \"\";", "return v || \"fallback-secret-fallback-secret-xx\";"),
    # laço / confirmação
    "L1 auto-submitted ignored": (FWD, 'if (auto && auto !== "no") return "auto_submitted";', ''),
    "L2 automated verdict ignored": (FWD, "  if (automated) {\n    const status", "  if (false) {\n    const status"),
    "L4 noreply sender acked": (FWD, 'return "noreply_sender";', 'return "";'),
    "L5 own domain acked": (FWD, 'if (domain === SUPPORT_DOMAIN || domain.endsWith("." + SUPPORT_DOMAIN)) return "own_domain";', ''),
    "L6 ack without Auto-Submitted": (FWD, '"Auto-Submitted": "auto-replied", ', ''),
    # (5) HTML e anexos
    "X1 script content kept": (FWD, 'const DROP_WITH_CONTENT = ["script", ', 'const DROP_WITH_CONTENT = ['),
    "X2 any tag allowed": (FWD, "if (!ALLOWED_TAGS.has(name)) continue;", "if (!ALLOWED_TAGS.has(name)) { out += m[0]; continue; }"),
    "X3 javascript href allowed": (FWD, "return /^(https?:|mailto:)/i.test(v) ?", "return v ?"),
    "X4 nested drop not iterated": (FWD, "for (let prev = null; prev !== s;) { prev = s; s = s.replace(drop, \"\"); }", "s = s.replace(drop, \"\");"),
    "X5 html output cap removed": (FWD, 'return out.length > MAX_HTML_OUT ? "" : out;', "return out;"),
    "X6 executable extension accepted": (FWD, "!EXEC_EXT.test(filename) && ", ""),
    "X7 executable content-type accepted": (FWD, " && !EXEC_TYPE.test(type);", ";"),
    "X8 unknown size accepted": (FWD, "Number.isFinite(size) && size > 0 && size <= MAX_ATTACHMENT_BYTES", "(!Number.isFinite(size) || size <= MAX_ATTACHMENT_BYTES)"),
    "X9 attachment count cap removed": (FWD, " && accepted.length < MAX_ATTACHMENTS", ""),
    "X10 attachment total cap removed": (FWD, "total + size <= MAX_ATTACHMENTS_TOTAL && ", ""),
    # rev. 3: leitura obrigatória antes de aceitar, orçamento, 409, alertas
    "R1 receiving key not required before accepting": (FWD, '!rKey && "receiving_key", ', ''),
    "B1 lease ignores attempts/lifetime": (FWD, "      and attempts < $2 and created_at > now() - make_interval(hours => $3::int)\n      and read_failures < $4 and send_failures < $5\n    returning state", "      and read_failures < $4 and send_failures < $5\n    returning state"),
    "B2 code budget ignores attempts": (FWD, "return Number(row?.attempts) >= 1 && Number(row?.attempts) <= MAX_ATTEMPTS && Number.isFinite", "return Number(row?.attempts) >= 1 && Number.isFinite"),
    "B3 code budget ignores lifetime": (FWD, " && nowAgeS < RETRY_LIFETIME_HOURS * 3600\n", "\n"),
    "B4 reap removed": (FWD, "  await c.sql.query(SQL.reap, [MAX_ATTEMPTS, RETRY_LIFETIME_HOURS, MAX_READ_FAILURES, MAX_SEND_FAILURES]);\n", ""),
    "B5 lifetime beyond idempotency window": (FWD, "export const RETRY_LIFETIME_HOURS = 23;", "export const RETRY_LIFETIME_HOURS = 48;"),
    "B6 due ignores budget": (FWD, "      and attempts < $2 and created_at > now() - make_interval(hours => $3::int)\n      and read_failures < $4 and send_failures < $5 order by", "      order by"),
    "I1 409 idempotent treated as failure": (FWD, 'const already = sent?.status === 409 && String(sent?.data?.name || "") === "invalid_idempotent_request";', "const already = false;"),
    "A1 dead alert never sent": (FWD, "if (dead > 0 && await send(", "if (false && await send("),
    "A2 alert rate limit removed": (FWD, "SQL.alertReserve, [kind, ALERT_EVERY_HOURS]", "SQL.alertReserve, [kind, 0]"),
    "A3 alert slot not released on failure": (FWD, "if (!r.ok) { await c.sql.query(SQL.alertRelease, [kind]).catch(() => null); return false; }", "if (!r.ok) return false;"),
    "A4 dead rows not marked alerted": (FWD, "])) await c.sql.query(SQL.deadAlerted, []);", "])) void 0;"),
    "A5 backlog count threshold ignored": (FWD, "if (pending >= BACKLOG_ALERT_COUNT || (pending", "if ((pending"),
    "A6 backlog age threshold ignored": (FWD, " || (pending > 0 && oldest >= BACKLOG_ALERT_AGE_MINUTES)", ""),
    # P0 2026-10-24: leitura com motivo, dreno em invocação própria, supressão e Reply-To do chamado
    "C1 reason codes collapsed": (FWD, "export function resendReason(res) {\n  const st = Number(res?.status) || 0;", "export function resendReason(res) {\n  return \"unavailable\";\n  const st = Number(res?.status) || 0;"),
    "C2 key-permission alert not sent": (FWD, "  if (/key_permission/.test(reason)) await alertKeyRejected(c, reason).catch(() => null);\n", ""),
    "C3 401 not classified as key permission": (FWD, "if (st === 401 || st === 403) return", "if (st === 403) return"),
    "C4 last_reason not stored": (FWD, "force, String(reason).slice(0, 60), kind,", "force, null, kind,"),
    "C5 network error classes lost": (FWD, 'if (!st) return ["timeout", "network_dns", "network_reset"].includes(res?.error) ? res.error : "network";', 'if (!st) return "network";'),
    "K1 drain run not logged": (FWD, '  log("drain", { source: opts.source || "direct", ...out });\n', ""),
    "K2 drain token not checked": (FWD, 'if (!okToken) return json(401, { error: "unauthorized" });', ""),
    "K3 drain token window widened": (FWD, "for (let d = -5; d <= 5 && !okToken; d++)", "for (let d = -600; d <= 600 && !okToken; d++)"),
    "K4 dispatch never uses SELF": (FWD, 'if (secret && self && typeof self.fetch === "function") {', "if (false) {"),
    "K5 drain error class lost": (FWD, 'if (/too many subrequests/i.test(m)) return "too_many_subrequests";', ""),
    "K6 drain route removed from worker": (COMPAT, "      if (drained) return drained;\n", ""),
    "K7 drain dispatched after preflight": (COMPAT, "  await dispatchSupportDrain(normalized, { sqlFactory: whatsappProofDatabase }).then(", "  await runSalesPreflight(normalized).catch(() => null);\n  await dispatchSupportDrain(normalized, { sqlFactory: whatsappProofDatabase }).then("),
    "S1 whatsapp sender ack not suppressed": (FWD, '  if (ACK_SUPPRESSED_SENDERS.includes(addr)) return "automated_provider";\n', ""),
    "S2 suppression by suffix (too broad)": (FWD, 'if (ACK_SUPPRESSED_SENDERS.includes(addr)) return "automated_provider";', 'if (addr.endsWith("support.whatsapp.com") || addr.includes("support.whatsapp.com")) return "automated_provider";'),
    "W1 whatsapp ticket reply-to ignored": (FWD, "      if (ticket && WHATSAPP_TICKET_RE.test(ticket)) return ticket;\n", ""),
    "W2 ticket digit bounds removed": (FWD, "export const WHATSAPP_TICKET_RE = /^[0-9]{5,20}@support\\.whatsapp\\.com$/;", "export const WHATSAPP_TICKET_RE = /^[0-9]+@support\\.whatsapp\\.com$/;"),
    "W3 ticket reply-to for any sender": (FWD, "  if (sender === WHATSAPP_SUPPORT_FROM) {", "  if (true) {"),
    # Sol 114-4: um mutante causal por grupo de casos
    "G1a sender from body header": (FWD, "export function isAutomated({ from, subject, headers, forwardTo }) {\n  const addr = providerAddress(from);", "export function isAutomated({ from, subject, headers, forwardTo }) {\n  const addr = providerAddress(headerMap(headers).from || from);"),
    "G1b multiple addresses accepted": (FWD, "  if (/[\\r\\n\\0]/.test(s) || (s.match(/@/g) || []).length !== 1) return \"\";\n", "  if (/[\\r\\n\\0]/.test(s)) return \"\";\n"),
    "G2a reply-to with two recipients takes first": (FWD, "    if (rt.length === 1) {", "    if (rt.length >= 1) {"),
    "G2b CRLF/multi in reply-to accepted": (FWD, "      const ticket = providerAddress(rt[0]);", "      const ticket = addressOf(String(rt[0]).split(/[\\r\\n,]/)[0]);"),
    "G2c reply-to from headers (outside metadata)": (FWD, "    const rt = Array.isArray(detail?.reply_to) ? detail.reply_to : detail?.reply_to ? [detail.reply_to] : [];", "    const rt = [...(Array.isArray(detail?.reply_to) ? detail.reply_to : []), ...(headerMap(detail?.headers)[\"reply-to\"] ? [headerMap(detail?.headers)[\"reply-to\"]] : [])].slice(-1);"),
    "G3 skipped marked when forward fails": (FWD, '  if (!(sent.ok || already) || !forwardId) return failSend(c, emailId, row, "forward", sent);', '  if (!(sent.ok || already) || !forwardId) { if (isAutomated({ from: detail.from, forwardTo: c.forwardTo })) { await c.sql.query(SQL.forwardedNoAck, [emailId, "skipped_automated_provider", "x"]); return { state: "done", ack: "skipped_automated_provider" }; } return failSend(c, emailId, row, "forward", sent); }'),
    "G5a 404 permanent at once": (FWD, 'if (/^http_404/.test(reason)) return "not_found";', 'if (/^http_404/.test(reason)) return "permanent";'),
    "G5b 404 transient forever": (FWD, "(cls === \"not_found\" && Number(row?.age_s) >= NOT_FOUND_GRACE_MINUTES * 60)", "false"),
    "G5c 400/422 transient": (FWD, 'if (/^http_(400|422)/.test(reason)) return "permanent";', 'if (/^http_(400|422)/.test(reason)) return "transient";'),
    "G5d 429/5xx permanent": (FWD, 'if (/^(http_429|http_5xx|timeout|network|invalid_json|unexpected_body)/.test(reason)) return "transient";', 'if (/^(timeout|network|invalid_json|unexpected_body)/.test(reason)) return "transient";'),
    "G6 shared read/send budget": (FWD, "      send_failures = send_failures + case when $5 = 'send' then 1 else 0 end,", "      send_failures = send_failures + 1,"),
    "G6b code shares counter": (FWD, "  const failures = Number(kind === \"read\" ? row?.read_failures : row?.send_failures) || 0;", "  const failures = (Number(row?.read_failures) || 0) + (Number(row?.send_failures) || 0);\n  if (kind === \"read\" && failures + 1 >= MAX_SEND_FAILURES) permanent = true;"),
    "G7 global suppression API call": (FWD, "async function stepAck(c, emailId, row, detailIn) {", "async function suppressGlobally(c, a) { return resendCall(c.fetchImpl, \"/suppressions\", { key: c.sendKey, method: \"POST\", body: { email: a } }); }\nasync function stepAck(c, emailId, row, detailIn) {"),
    "G8a email id logged": (FWD, 'log(dead ? step + "_dead" : step + "_retry", { kind, reason, failures: failures + 1 });', 'log(dead ? step + "_dead" : step + "_retry", { kind, reason, failures: failures + 1, id: emailId });'),
    "G8b overdue never flagged": (FWD, "  out.overdue = pendingNow > 0 && oldestNow >= BACKLOG_ALERT_AGE_MINUTES;", "  out.overdue = false;"),
    "G8c cron stays green on overdue": (COMPAT, '  if (supportOverdue) { console.error("support_backlog_overdue"); throw new Error("support_backlog_overdue"); }', '  if (supportOverdue) { console.error("support_backlog_overdue"); }'),
    "G9 body text drives reply-to": (FWD, "  const replyTo = forwardReplyTo(detail);", "  const replyTo = (String(detail.text || \"\").match(/Reply-To:\\s*(\\S+@\\S+)/i) || [])[1] || forwardReplyTo(detail);"),
    # caminho da sandbox / legado inalterado
    "P1 sandbox address handled here": (FWD, "  if (!alias) return null;", "  if (!alias) return json(200, { accepted: true, ignored: true });"),
    "P2 delivery events swallowed": (FWD, 'if (event?.type !== "email.received") return null;', 'if (event?.type !== "email.received") return json(200, { accepted: true });'),
    "P3 original body consumed": (FWD, "const raw = await request.clone().text();", "const raw = await request.text();"),
    "W1 whatsapp ticket reply-to ignored": (FWD, "      if (ticket && WHATSAPP_TICKET_RE.test(ticket)) return ticket;\n", ""),
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
