#!/usr/bin/env python3
"""Mutantes causais da separação de credenciais sandbox x produção (F2 item 9; roteiro 3.1 seção 7), classificados pelo
classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/production-payment-credential-isolation.test.mjs (P1-P7, Worker real),
tests/production-secret-names.test.mjs (N1-N15) e tests/ci/credential-separation-gate.test.mjs (G1-G11, gate real em
python3 + PyYAML). Cada mutante altera UMA regra do código de produção (worker/*.mjs, certification-worker.mjs), do gate
(scripts/ci/credential_separation_gate.py) ou do readback/remoção (scripts/ci/production-secret-names.mjs), numa cópia
mínima da árvore em diretório temporário (o repositório nunca é alterado).
Expectativas (mutants_credential_separation_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Xn.k] da asserção que codifica a regra) e secondary com justification, escritas
por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida, primary
sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_credential_separation.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/production-payment-credential-isolation.test.mjs", "tests/production-secret-names.test.mjs",
         "tests/ci/credential-separation-gate.test.mjs", "tests/ci/production-worker-state.test.mjs"]
COPY_DIRS = ["worker", "data", "tests/t4_sim", "tests/helpers", ".github/workflows"]
COPY_FILES = TESTS + ["certification-worker.mjs", "admin.css", "ops/r9-debt.json", "scripts/ci/credential_separation_gate.py",
                      "scripts/ci/production-secret-names.mjs", "scripts/ci/production-worker-state.sh", "ops/publishers.json",
                      "docs/ops/zevanory-publisher-matrix.json", "docs/ops/zevanory-publisher-matrix.md", "scripts/deploy/prepare-central-candidate.py",
                      "wrangler.public-router.toml", "wrangler.sales.toml"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
R = "worker/cloudflare-worker.recovered.mjs"
C = "worker/cloudflare-worker.compat.mjs"
W = "certification-worker.mjs"
G = "scripts/ci/credential_separation_gate.py"
S = "scripts/ci/production-secret-names.mjs"
WF = ".github/workflows/production-test-secret-cleanup.yml"
MX = "docs/ops/zevanory-publisher-matrix.json"
SH = "scripts/ci/production-worker-state.sh"

M = {
    # Worker de produção / certificação: escolha de credencial
    "W1 production webhook verified with TEST secret": (R, 'webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET, certificationOnly: false, source: "mercadopago" });', 'webhookSecret: process.env.MERCADOPAGO_TEST_WEBHOOK_SECRET, certificationOnly: false, source: "mercadopago" });'),
    "W2 production webhook falls back to TEST token": (R, 'accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN, webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET, certificationOnly: false, source: "mercadopago" });', 'accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.MERCADOPAGO_TEST_ACCESS_TOKEN, webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET, certificationOnly: false, source: "mercadopago" });'),
    "W3 test webhook falls back to PRODUCTION token": (R, "accessToken: process.env.MERCADOPAGO_TEST_ACCESS_TOKEN, webhookSecret", "accessToken: process.env.MERCADOPAGO_TEST_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN, webhookSecret"),
    "W4 test webhook verified with PRODUCTION secret": (R, "webhookSecret: process.env.MERCADOPAGO_TEST_WEBHOOK_SECRET, certificationOnly: true", "webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET, certificationOnly: true"),
    "W5 test webhook not marked as test": (R, 'certificationOnly: true, source: "mercadopago-test"', 'certificationOnly: false, source: "mercadopago-test"'),
    "W6 checkout readiness accepts TEST credentials": (R, 'if (!present2(env.MERCADOPAGO_ACCESS_TOKEN) || !present2(env.MERCADOPAGO_WEBHOOK_SECRET)) local.push("mercadopago_credentials_missing");', 'if (!present2(env.MERCADOPAGO_ACCESS_TOKEN || env.MERCADOPAGO_TEST_ACCESS_TOKEN) || !present2(env.MERCADOPAGO_WEBHOOK_SECRET || env.MERCADOPAGO_TEST_WEBHOOK_SECRET)) local.push("mercadopago_credentials_missing");'),
    "W7 compat pilot isolation guard removed": (C, "      if (pilot) {", "      if (false) {"),
    "W8 certification worker accepts production token": (W, 'for(const key of ["MERCADOPAGO_ACCESS_TOKEN","MERCADOPAGO_WEBHOOK_SECRET",', 'for(const key of ["MERCADOPAGO_WEBHOOK_SECRET",'),
    "W9 certification worker accepts production webhook secret": (W, 'for(const key of ["MERCADOPAGO_ACCESS_TOKEN","MERCADOPAGO_WEBHOOK_SECRET",', 'for(const key of ["MERCADOPAGO_ACCESS_TOKEN",'),
    "W10 certification worker routes production provider": (W, 'url.search!=="?provider=mercadopago_test"', '!url.search.startsWith("?provider=mercadopago")'),
    # gate estático
    "G1 R1 disabled": (G, "if is_sandbox_name(n) and environment != SANDBOX_ENVIRONMENT and n not in legacy:", "if False and is_sandbox_name(n):"),
    "G2 legacy exception widened to CERTIFICATION_*": (G, "and n not in legacy:", 'and not n.startswith("CERTIFICATION_"):'),
    "G3 R2 disabled": (G, "if n in refs and is_production_name(n) and environment == SANDBOX_ENVIRONMENT:", "if False and n in refs:"),
    "G4 secrets['X'] syntax ignored": (G, "            refs.update(SECRET_INDEX.findall(s))\n", ""),
    "G5 env-bound names ignored": (G, '        bound = set(wf_bound) | env_bound_names(job.get("env"))', "        bound = set(wf_bound)"),
    "G6 workflow-level env ignored": (G, "    wf_refs, wf_bound = secret_refs(wf_env), env_bound_names(wf_env)", "    wf_refs, wf_bound = set(), set()"),
    "G7 default wrangler config treated as non-production": (G, '        return True, "(configuração padrão do wrangler)"', '        return False, "(configuração padrão do wrangler)"'),
    "G8 certification target not recognised": (G, '    return (not all("certification" in x.lower() for x in target)), " ".join(target)', '    return True, " ".join(target)'),
    "G9 unresolved dynamic name accepted": (G, "    if not loop:\n        return None", "    if not loop:\n        return [name]"),
    "G10 versions secret put not matched": (G, r"(?:versions\s+)?secret\s+(put|bulk)", r"secret\s+(put|bulk)"),
    "G11 secret bulk ignored": (G, "        else:  # bulk:", "        elif False:  # bulk:"),
    "G12 line continuation not joined": (G, '    joined = re.sub(r"\\\\\\n", " ", script)', "    joined = script"),
    "G13 expression environment accepted": (G, '        if environment and "${{" in environment and sensitive:', "        if False:"),
    "G14 unreadable workflow not fatal": (G, "    code = 2 if errors else (1 if violations else 0)", "    code = 1 if violations else 0"),
    "G15 production config debt widened": (G, "if PUT_FORBIDDEN_NAME.search(n) and n not in config_debt:", 'if PUT_FORBIDDEN_NAME.search(n) and not n.startswith("CERTIFICATION_PILOT_"):'),
    "G16 runtime config assignments ignored": (G, '    re.compile(r"\\bruntime\\s*\\[\\s*[\'\\"]([A-Za-z_][A-Za-z0-9_]*)[\'\\"]\\s*\\]\\s*="),\n', ""),
    "G17 deploy --var not checked": (G, '            if n and PUT_FORBIDDEN_NAME.search(n):\n                found.append((n, target, "wrangler deploy --var', '            if False:\n                found.append((n, target, "wrangler deploy --var'),
    "G18 retired job without if: false accepted": (G, """                out.append({**base, "job": str(jname), "detail": "job perdeu 'if: ${{ false }}'"})""", "                pass"),
    "G19 retired marker not required": (G, "        if len(RETIRED_MARKER.findall(text)) < len(jobs):", "        if False:"),
    "G20 unregistered retired marker accepted": (G, "if p.name not in registered and RETIRED_MARKER.search(", "if False and RETIRED_MARKER.search("),
    "G21 registered retired file may vanish": (G, """            out.append({**base, "job": "-", "detail": "aposentado registrado não existe (remova da lista no mesmo PR)"})""", "            pass"),
    "G22 cleanup may run on merge": (G, """    if events != {"workflow_dispatch"}:""", "    if False:"),
    "G23 cleanup confirmation optional": (G, """    if not (isinstance(ci, dict) and ci.get("required") is True):""", "    if False:"),
    "G24 cleanup any Worker": (G, """        if "--name" not in toks or toks[toks.index("--name") + 1:toks.index("--name") + 2] != ["zevanory"] or any(t.startswith(("--config", "-c")) for t in toks):""", "        if False:"),
    "G25 cleanup allowlist not pinned": (G, """    if not case or tuple(sorted(case.group(1).split("|"))) != tuple(sorted(CLEANUP_ALLOWLIST)):""", "    if False:"),
    "G26 resolved debt may stay listed": (G, """        if e.get("status") not in (None, "OPEN") and isinstance(e.get("status"), str):""", "        if False:"),
    "G27 missing debt registry accepted": (G, """        return None, [f"{DEBT_FILE.as_posix()} ausente"]""", """        return {"pending": [], "retired_workflows": []}, []"""),
    "G28 R1 exception hardcoded (not from registry)": (G, """    legacy = frozenset(e["name"] for e in pending if e.get("github_secret_exception") is True and isinstance(e.get("name"), str))""", """    legacy = frozenset({"CERTIFICATION_E2E_TOKEN"})"""),
    # readback / remoção dirigida
    "S1 confirmation not exact": (S, 'typeof confirmation !== "string" || confirmation !== CONFIRMATION_PHRASE', 'typeof confirmation !== "string" || !confirmation.includes("MERCADOPAGO_TEST_ACCESS_TOKEN")'),
    "S2 delete set ignores presence": (S, "  const toDelete = REMOVAL_ALLOWLIST.filter((n) => present.has(n));", "  const toDelete = [...REMOVAL_ALLOWLIST];"),
    "S3 kept list drops CERTIFICATION names": (S, "  const kept = [...present].filter((n) => !toDelete.includes(n)).sort();", "  const kept = [...present].filter((n) => !toDelete.includes(n) && !FORBIDDEN_IN_PRODUCTION.test(n)).sort();"),
    "S4 verify ignores lost names": (S, "  const lost = names(expected.filter((e) => !got.has(key(e))));", "  const lost = [];"),
    "S5 verify ignores names still present": (S, "  const stillPresent = names(entries.filter((e) => gone.has(e.name)));", "  const stillPresent = [];"),
    "S6 target proof bypassed": (S, "  return { ok: value === TARGET.environment,", "  return { ok: true,"),
    "S7 readback debt widened to any CERTIFICATION": (S, "    if (!strict && Object.hasOwn(registry.names, entry.name)) debt.push(entry);", '    if (!strict && entry.name.includes("CERTIFICATION")) debt.push(entry);'),
    "S8 strict mode ignored": (S, "    if (!strict && Object.hasOwn(registry.names, entry.name)) debt.push(entry);", "    if (Object.hasOwn(registry.names, entry.name)) debt.push(entry);"),
    "S9 runtime config keys ignored": (S, "        for (const key of Object.keys(raw)) if (NAME.test(key)) out.push(", "        for (const key of []) if (NAME.test(key)) out.push("),
    "S10 non-secret allowlisted name accepted": (S, '  if (notSecret.length) return { ok: false, error: "allowlisted_name_is_not_a_secret", toDelete: [], notSecret };\n', ""),
    "S11 plan file leaks settings": (S, "writeFileSync(out, JSON.stringify({ schema: INVENTORY_SCHEMA,", "writeFileSync(out, JSON.stringify({ settings, schema: INVENTORY_SCHEMA,"),
    "S13 strict ignores open debt": (S, "  const openDebt = strict ? registry.pending.map((e) => e.id) : [];", "  const openDebt = [];"),
    "S14 debt registry without reason/PR accepted": (S, """ || !String(e.reason || "").trim() || !String(e.planned_pr || "").trim()) throw new InputError("debt_registry_invalid");""", """) throw new InputError("debt_registry_invalid");"""),
    # Sol 187 C1 (pré-inventário)
    "C1a runtime config keys reported as bindings": (S, 'ZEVANORY_RUNTIME_CONFIG: "runtime_config" };', 'ZEVANORY_RUNTIME_CONFIG: "binding" };'),
    "C1b readback omits the effective version": (S, "previous=${snap.effective.previous ?? \"nenhuma\"}`);\n        log(`EFFECTIVE_VERSION_ID=${complete ? snap.effective.id : \"NOT_EMITTED\"}`);", "previous=${snap.effective.previous ?? \"nenhuma\"}`);"),
    # Sol 187 C2 / 189 A2 / 194 (digest lógico e autorização D0+V0)
    "D1 digest ignores code identity": (S, "commit_sha: commitSha ?? null, code,", "commit_sha: commitSha ?? null, code: null,"),
    "D2 mutable version id inside the logical digest": (S, "  const doc = inventoryDocument({ entries, commitSha: commit, code: detail ? detail.code : null, toDelete, kept });", "  const doc = { ...inventoryDocument({ entries, commitSha: commit, code: detail ? detail.code : null, toDelete, kept }), effective_version_id: effective ? effective.id : null };"),
    "D3 approved digest mismatch accepted": (S, '  if (digest !== expectedDigest) return { ok: false, error: "inventory_digest_mismatch" };\n', ""),
    "D4 approved version V0 optional": (S, '  if (typeof expectedVersion !== "string" || !expectedVersion) return { ok: false, error: "expected_version_missing" };\n  if (!effective || effective.id !== expectedVersion)', "  if (expectedVersion && (!effective || effective.id !== expectedVersion))"),
    # Sol 191 transições S0 -> S1 -> S2
    "D5 S1 check skipped": (S, "  if (live !== target.digest) errors.push(", '  if (live !== target.digest && target.state !== "S1") errors.push('),
    "D6 extra changes accepted (ADDED ignored)": (S, "  const added = names(entries.filter((e) => !exp.has(key(e)) && !gone.has(e.name)));", "  const added = [];"),
    # Sol 187 C3 / 189 A1 (serialização)
    "P1 unserialized financial publishers not watched": (S, '  const files = new Set(watched.files.map((f) => ".github/workflows/" + f));', '  const files = new Set(watched.writers.filter((f) => !watched.unserialized.includes(f)).map((f) => ".github/workflows/" + f));'),
    "P2 truncated run listing accepted": (S, "    if (l.total_count > l.workflow_runs.length) truncated = true;\n", ""),
    "P3 version change before delete ignored": (S, "  return { ok: active.length === 0 && !truncated && !versionChanged,", "  return { ok: active.length === 0 && !truncated,"),
    "P5 waiting runs not considered active": (S, 'export const ACTIVE_RUN_STATUSES = Object.freeze(["queued", "in_progress", "waiting", "requested", "pending"]);', 'export const ACTIVE_RUN_STATUSES = Object.freeze(["queued", "in_progress", "requested", "pending"]);'),
    "P6 workflow polls only two run statuses": (WF, "for s in queued in_progress waiting requested pending; do", "for s in queued in_progress; do"),
    # Sol 187 C4 (falha parcial, um nome por vez)
    "K1 version moved between deletes accepted": (S, '      if (snap.effective.id !== expectedVersion) errors.push("CONCURRENT_CHANGE:effective_version_moved");\n', ""),
    "K2 deployment chain not single-step accepted": (S, '      if (snap.effective.previous !== expectedVersion) errors.push("CONCURRENT_CHANGE:deployment_chain_not_single_step");\n', ""),
    "K3 failed delete does not stop the loop": (WF, 'secret delete "$name" --name zevanory || fail "delete_failed:$name"', 'secret delete "$name" --name zevanory || true'),
    "K4 partial report does not fail the job": (WF, '--reason "$1" || true\n            exit 1\n', '--reason "$1" || true\n'),
    "K6 partial report claims every name absent": (S, '  return { planned: plan.toDelete.map((n) => ({ name: n, state: after.has(n) ? "present" : "absent" })),', '  return { planned: plan.toDelete.map((n) => ({ name: n, state: "absent" })),'),
    # Sol 187 C5 / 189 A3 (verificação estrita e pós-prova)
    "V2 kept type change ignored": (S, "  const typeChanged = expected.filter((e) => got.has(key(e)) && got.get(key(e)).type !== e.type)", "  const typeChanged = expected.filter((e) => false)"),
    "V3 code identity not compared": (S, "export const sameCode = (a, b) => canonicalJson(a) === canonicalJson(b);", "export const sameCode = (a, b) => true;"),
    "V4 config diff accepts extra removals": (S, '  const unexpectedRemoved = removed.filter((n) => !allowed.has(n) || before[n].type !== "secret_text");', "  const unexpectedRemoved = removed.filter((n) => false);"),
    "V5 var value change invisible to config diff": (S, "config[b.name] = { type: cleanType(b.type), h: privateFingerprint(canonicalJson(b)) };", "config[b.name] = { type: cleanType(b.type), h: cleanType(b.type) };"),
    "V6 sales status without open=false accepted": (S, 'sales.open !== false) errors.push("sales_status_open_not_false");', 'sales.open === true) errors.push("sales_status_open_not_false");'),
    "V7 commit change during cleanup accepted": (S, '  else if (plan && plan.commit_sha && r.commit_sha !== plan.commit_sha) errors.push("release_commit_changed_during_cleanup");\n', ""),
    "V8 script settings change ignored": (S, '  if (snap.settingsHash !== plan.settings_hash) errors.push("script_settings_changed");\n  if (liveDigest', "  if (liveDigest"),
    # Sol 194 (validador e ordem determinística)
    "X1 duplicate secret list name accepted": (S, 'if (all.findIndex((x) => x.name === e.name) !== i) throw new InputError("secret_list_duplicate_name"); return e;', "return e;"),
    "X2 duplicate settings binding accepted": (S, '  if (new Set(bindings.map((b) => b.name)).size !== bindings.length) throw new InputError("settings_duplicate_binding_name");\n', ""),
    "X3 secret type mismatch across sources accepted": (S, '    if (bindings.get(s.name) !== s.type) throw new InputError("inventory_inconsistent_type");\n', ""),
    "X4 inconsistent type reported as duplicate": (S, 'throw new InputError(byKey.get(k).type === e.type ? "inventory_duplicate_name" : "inventory_inconsistent_type");', 'throw new InputError("inventory_duplicate_name");'),
    "X5 unknown origin accepted": (S, '    if (!ORIGINS.includes(e.origin)) throw new InputError("inventory_unknown_origin");\n', ""),
    "X6 pagination not exhausted accepted": (S, '  if (ri && typeof ri === "object" &&', '  if (false && ri && typeof ri === "object" &&'),
    "X7 incomplete secret list accepted": (S, '  for (const [name, type] of bindings) if (SECRET_TYPES.has(type) && !secrets.has(name)) throw new InputError("inventory_incomplete_secret_list");\n', ""),
    "X9 deployments order taken from the API": (S, "  return [...list].sort((a, b) => cmp(b.created_on, a.created_on) || cmp(String(b.id || \"\"), String(a.id || \"\"))).slice(0, 2).map((d) => {", "  return [...list].slice(0, 2).map((d) => {"),
    "X10 inventory order taken from the API": (S, "  return [...byKey.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.origin, b.origin) || cmp(a.type, b.type));", "  return [...byKey.values()];"),
    "X11 settings and version bindings may disagree": (S, '    if (a !== b) throw new InputError("inventory_sources_disagree");\n', ""),
    # Sol 189 A1 (matriz de publicadores)
    "M1 config publisher leaves deploy-zevanory": (".github/workflows/channel-credentials-sync.yml", "  group: deploy-zevanory\n", "  group: channel-credentials-sync\n"),
    "M2 matrix drops a writer": (MX, '    { "workflow": "voice-zero-spend-enable.yml", "ops": ["wrangler secret put"], "group": "deploy-zevanory", "serialized": true, "status": "active", "trigger": "workflow_dispatch" },\n', ""),
    "M3 new unserialized exception": (MX, '{ "workflow": "channel-credentials-sync.yml", "ops": ["wrangler secret put"], "group": "deploy-zevanory", "serialized": true,', '{ "workflow": "channel-credentials-sync.yml", "ops": ["wrangler secret put"], "group": "deploy-zevanory", "serialized": false,'),
    # gate: contrato do workflow de remoção
    "G29 cleanup authorized digest/version optional": (G, """        if not (isinstance(spec, dict) and spec.get("required") is True):""", "        if False:"),
    "G30 cleanup serialization preflight not required": (G, """    for marker in ("production-secret-names.mjs preflight", "step --phase pre",""", """    for marker in ("step --phase pre","""),
    # Diagnóstico da coleta (run 40142599036 saiu sem nenhuma linha): falha ruidosa e segura
    "R1 redaction disabled": (S, '.replace(SECRETISH, (m, b, a, k) => (b || a || k || "") + "[redigido]")', ".replace(SECRETISH, (m) => m)"),
    "R2 version-id silent on a gradual rollout": (S, "      return eff.single ? 0 : 1;", "      return 0;"),
    "R3 history keeps binding values": (S, "map((b) => [b.name, cleanType(b.type)]).sort((x, y) => cmp(x[0], y[0]))", "map((b) => [b.name, cleanType(b.type), b.text ?? null]).sort((x, y) => cmp(x[0], y[0]))"),
    "R4 cf-errors prints the response body": (S, "  const out = [`CF_RESPONSE success=${data?.success === true} errors=${errs.length}`];", "  const out = [`CF_RESPONSE success=${data?.success === true} errors=${errs.length} body=${JSON.stringify(data)}`];"),
    "R5 wrangler stderr printed raw": (SH, """    node scripts/ci/production-secret-names.mjs classify-wrangler --file "$o/wrangler.err" | sed 's/^/WORKER_STATE wrangler: /'""", "    sed 's/^/WORKER_STATE wrangler: /' \"$o/wrangler.err\""),
    "R6 version-id failure silent": (SH, """    echo "::error title=WORKER_STATE::version-id failed (exit=$rc) $(printf '%s' "$vid" | tr '\\n' ' ' | cut -c1-200)"\n""", ""),
    "R7 diagnosis skipped after a settings failure": (SH, '  zev_cf_get settings "$o/settings.json" || { zev_diagnose "$o"; return 1; }', '  zev_cf_get settings "$o/settings.json" || return 1'),
    "R8 evidence uploaded only on success": (".github/workflows/production-test-secret-readback.yml", "      - name: Upload readback evidence (names, codes and sanitized history only)\n        if: always()\n", "      - name: Upload readback evidence (names, codes and sanitized history only)\n"),
    # Sol 221: falha fechada, premissa só com identidade do código, artefato com allowlist
    "R9 partial inventory still emits D0/V0": (S, "      const complete = missing.length === 0;", "      const complete = true;"),
    "R10 plan accepts an incomplete inventory": (S, '      if (gaps.length) { log(`::error title=CLEANUP_REFUSED::inventário incompleto (${gaps.join(",")}); D0/V0 não emitidos`); return 1; }\n', ""),
    "R11 premise proven by the annotation alone": (S, '  if (!prev || !prev.etag || !v.etag) return { status: "NOT_PROVEN", why: "etag_ausente" };', '  if (!prev || !prev.etag || !v.etag) return { status: "PROVEN", why: "anotacao" };'),
    "R12 artifact uploads the whole evidence folder": (".github/workflows/production-test-secret-readback.yml", "            ${{ runner.temp }}/zevanory-evidence/collect.txt\n", "            ${{ runner.temp }}/zevanory-evidence/\n"),
    # Sol 222/223: D0 público sem chave; valores só por dentro (HMAC por run), rotulados
    "R13 config fingerprint is a plain SHA-256": (S, '(s) => createHmac("sha256", configKey()).update(s, "utf8").digest("hex");', "(s) => sha256(s);"),
    "R14 value-derived field inside D0": (S, "    delete: [...toDelete].sort(cmp), keep: [...kept].sort(cmp) };", "    delete: [...toDelete].sort(cmp), keep: [...kept].sort(cmp), hmac: privateFingerprint(canonicalJson(entries)) };"),
    "R15 summary without the D0/private labels": (".github/workflows/production-test-secret-readback.yml", "grep -E '^(SECTION_D0|SECTION_PRIVATE|PRODUCTION_TEST_SECRET_READBACK", "grep -E '^(PRODUCTION_TEST_SECRET_READBACK"),
    # Sol 229: release explícito, logs sem texto livre, completude do histórico
    "R16 unknown Cloudflare message printed": (S, '  return KNOWN_CF_MESSAGES.includes(s) ? s : "<redacted:unknown>";', '  return s || "<redacted:unknown>";'),
    "R17 release failure not explicit": (SH, '    zev_note "release_status=FAILED (http=$ZEV_LAST_HTTP)"', '    zev_note "release indisponível"'),
    "R18 failed detail not treated as NOT_PROVEN": (S, '  if (!v.detail_fetched) return { status: "NOT_PROVEN", why: "detail_failed" };\n  if (prev && !prev.detail_fetched) return { status: "NOT_PROVEN", why: "previous_detail_failed" };\n', ""),
    "R19 global PROVEN despite unproven relevant versions": (S, "tally.PROVEN > 0 && tally.NOT_PROVEN === 0 && pagesExhausted", "tally.PROVEN > 0 && pagesExhausted"),
    "R20 missing details not counted as failed": (S, ", ...listedIds.filter((id) => !byId.has(id))])]", "])]"),
    # Sol 231: PROVEN global exige paginação esgotada
    "R21 global PROVEN without exhausted pages": (S, "tally.NOT_PROVEN === 0 && pagesExhausted && continuity ?", "tally.NOT_PROVEN === 0 && continuity ?"),
    "S12 malformed secret list accepted": (S, '  if (!Array.isArray(data)) throw new InputError("secret_list_not_array");', "  if (!Array.isArray(data)) return [];"),
}

ALLOW_FILE = Path(os.environ.get("CREDENTIAL_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_credential_separation_allow.json"))


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
    return mc.run_command([NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", *TESTS],
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
