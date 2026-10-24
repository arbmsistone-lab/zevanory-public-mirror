#!/usr/bin/env node
// Mutants for the fail-closed WhatsApp retirement (Meta permanently disabled WABA 4019600665012911 on
// 2026-10-10; retirement is a code constant) and the manual-only Instagram/Facebook inbound. Each mutant
// edits source IN PLACE (or adds a file), runs tests/whatsapp-retirement.test.mjs +
// tests/meta-social-manual-only.test.mjs (TAP) and restores the original bytes (SHA-256 checked after
// every mutant; added files removed). Portable: anchors are matched on EOL-normalized text (a Windows
// checkout with CRLF matches the same LF anchors) and the original bytes are written back.
// Expected assertions (Sol audits 128/131): scripts/ci/mutants_whatsapp_retirement.expected.json, one spec per mutant with
// 1-3 PRIMARY assertions derived by reasoning about the mutation, each naming the labelled assertion ("[WR-...]") that
// encodes the mutated rule (assertion_pattern is mandatory for primaries), and optional SECONDARY ones, each with a
// written causal justification (table: docs/evidence/whatsapp-retirement-mutant-causality.md).
// Config and verdicts come from the SHARED classifier scripts/ci/mutant_classifier.py (PR #901): load_mutant_config
// validates the whole config before anything runs (the runner exits 4, "MUTANT CONFIG REFUSED", on any defect, a
// primary without assertion_pattern or a config/mutant mismatch); each run's TAP goes through its `classify` CLI:
//   KILLED       = complete TAP, count == baseline, rc 1, an ASSERTION failure inside the not-ok block of a PRIMARY
//                  test carrying its assertion label, every other failure primary or justified secondary.
//   SURVIVED     = rc 0 and a clean baseline-equal count.
//   INCONCLUSIVE = anything else (timeout, signal, crash, truncated TAP, count mismatch, skip/todo/cancelled,
//                  non-assertion failure, unexpected failure, label only outside the block, only secondary failures).
// Exit 0 only if the baseline is green and every mutant is KILLED. Offline, no secrets.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { normalizeEol } from "../../tests/helpers/text.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SUITES = ["tests/whatsapp-retirement.test.mjs", "tests/meta-social-manual-only.test.mjs", "tests/whatsapp-config-absence.test.mjs"];
const BASE_COUNT = 26;
const RET = "worker/whatsapp-retirement.mjs", COMPAT = "worker/cloudflare-worker.compat.mjs", REC = "worker/cloudflare-worker.recovered.mjs";
const LIVE = "worker/live-runtime-status.mjs", CONT = "worker/continuity-router.mjs", ONB = "worker/whatsapp-onboarding.mjs";
const BROKER = "worker/whatsapp-credential-broker.mjs", INB = "worker/inbound-autonomy.mjs", WF = ".github/workflows/voice-render-proof.yml";
const FORGER = "scripts/ci/_mutant_forger.mjs";
const GEN = "scripts/deploy/prepare-central-candidate.py", TOML = "wrangler.sales.toml";
const GEN_STRIP = 'for _bag in (c["vars"], runtime):\n    for _key in [k for k in _bag if _retired_whatsapp_alias(k)]:\n        _bag.pop(_key)\n';
const GEN_SALES = 'c["vars"]["WHATSAPP_SALES_ENABLED"]="false"  # WhatsApp retired (PR #896): channel closed for good, never "true"\n';
const SCAN = "scripts/deploy/public_whatsapp_scan.py", MPWF = ".github/workflows/mercadopago-exact-sha-recovery.yml";
// The generator shape lives under tests/ (outside the static scan) and is copied in only for M28.
const FORGER_SRC = normalizeEol(readFileSync(resolve(ROOT, "tests/fixtures/forged-webhook-generator.txt"), "utf8"));

// [id, [[file, from, to] ...]]   (from === null: create file `file` with `to`); expectations live in the JSON config.
const MUTANTS = [
  ["M01_env_reenables_channel", [[RET, "export function whatsappChannelRetired(_env) {\n  return WHATSAPP_CHANNEL_RETIRED;", 'export function whatsappChannelRetired(_env) {\n  return String(_env?.WHATSAPP_CHANNEL_RETIRED ?? "true").trim().toLowerCase() !== "false";']]],
  ["M02_constant_flipped", [[RET, "export const WHATSAPP_CHANNEL_RETIRED = true;", "export const WHATSAPP_CHANNEL_RETIRED = false;"]]],
  ["M03_env_reenables_instant_reply", [[RET, "export function whatsappInstantReplyEnabled(_env) {\n  return false;", 'export function whatsappInstantReplyEnabled(_env) {\n  return String(_env?.WHATSAPP_INSTANT_REPLY ?? "") === "true";']]],
  ["M04_process_env_reenables_channel", [[RET, "export function whatsappChannelRetired(_env) {\n  return WHATSAPP_CHANNEL_RETIRED;", 'export function whatsappChannelRetired(_env) {\n  return globalThis.process?.env?.WHATSAPP_CHANNEL_RETIRED !== "false";']]],
  ["M05_compat_reads_broker_status", [[COMPAT, "  if (whatsappChannelRetired(env)) return null;\n  if (!binding?.fetch) return null;", "  if (!binding?.fetch) return null;"], [COMPAT, "whatsappRetired ? Promise.resolve(null) : loadWhatsappBrokerState(", "loadWhatsappBrokerState("]]],
  ["M06_compat_keeps_stale_globals", [[COMPAT, "      globalThis.__ZEVANORY_WHATSAPP_RUNTIME__ = {};\n      globalThis.__ZEVANORY_WHATSAPP_BROKER__ = null;\n      globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__ = null;\n", ""]]],
  ["M07_edge_classification_removed", [[COMPAT, 'if (classifyMetaWebhookBody(raw) === "whatsapp") return whatsappWebhookAckResponse();', "if (false) return whatsappWebhookAckResponse();"]]],
  ["M08_edge_silent_ack_any_product", [[COMPAT, 'if (classifyMetaWebhookBody(raw) === "whatsapp") return whatsappWebhookAckResponse();', 'if (classifyMetaWebhookBody(raw) !== "never") return whatsappWebhookAckResponse();']]],
  ["M09_edge_large_body_silent_ack", [[COMPAT, "      if (!(declared > META_WEBHOOK_CLASSIFY_MAX_BYTES)) {", "      if (declared > META_WEBHOOK_CLASSIFY_MAX_BYTES) return whatsappWebhookAckResponse();\n      {"]]],
  ["M10_classifier_instagram_as_whatsapp", [[RET, 'if (object === "instagram") return "instagram";', 'if (object === "instagram") return "whatsapp";']]],
  ["M11_classifier_no_size_bound", [[RET, 'if (!text || text.length > META_WEBHOOK_CLASSIFY_MAX_BYTES) return "unclassified";', 'if (!text) return "unclassified";']]],
  ["M12_classifier_ignores_social_fields", [[RET, 'if (!field || SOCIAL_FIELDS.has(field)) return "unclassified";', 'if (!field) return "unclassified";']]],
  ["M13_bundle_webhook_processes_whatsapp", [[REC, "  if (whatsappChannelRetired(process.env) && isWhatsappWebhookBody(raw)) return json14(res, 200, { accepted: true, processed: false, stored: false, reason: WHATSAPP_RETIRED_REASON });\n", ""]]],
  ["M14_broker_call_guard_removed", [[REC, '  if (whatsappChannelRetired(process.env)) return { ok: false, status: 410, body: { error: "whatsapp_channel_retired", reason: WHATSAPP_RETIRED_REASON } };\n  const broker', "  const broker"]]],
  ["M15_identity_calls_graph", [[REC, "  if (whatsappChannelRetired(env)) return result(false, false, WHATSAPP_RETIRED_REASON, { retired: true, mode: WHATSAPP_RETIRED_MODE });\n", ""]]],
  ["M16_migration_probe_uses_wa_token", [[REC, 'fallback = whatsappChannelRetired(process.env) ? "" : String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();', 'fallback = String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();']]],
  ["M17_reply_retired_guard_removed", [[REC, '  if (whatsappChannelRetired(process.env)) return { sent: false, reason: "whatsapp_channel_retired" };\n  if (!whatsappInstantReplyEnabled', "  if (!whatsappInstantReplyEnabled"]]],
  ["M18_webhook_instant_reply_env_default", [[REC, 'if (whatsappInstantReplyEnabled(process.env) && (item.type === "text"', 'if (process.env.WHATSAPP_INSTANT_REPLY !== "false" && (item.type === "text"']]],
  ["M19_webhook_processes_inbound", [[REC, "const inbound = whatsappChannelRetired(process.env) ? [] : extractWhatsappInboundMessages(payload);", "const inbound = extractWhatsappInboundMessages(payload);"]]],
  ["M20_sender_guard_removed", [[REC, '  if (whatsappChannelRetired(process.env)) return { ok: false, status: 410, provider_message_id: null, error: "whatsapp_channel_retired" };\n', ""]]],
  ["M21_voice_upload_guard_removed", [[REC, '  if (whatsappChannelRetired(env) || whatsappChannelRetired(process.env)) throw new Error("whatsapp_channel_retired");\n  const staged', "  const staged"]]],
  ["M22_media_download_guard_removed", [[REC, '  if (whatsappChannelRetired(env) || whatsappChannelRetired(process.env)) throw new Error("whatsapp_channel_retired");\n  const rtMedia', "  const rtMedia"]]],
  ["M23_outbound_adapter_guard_removed", [[REC, '      if (whatsappChannelRetired(env) || whatsappChannelRetired(process.env)) throw new Error("whatsapp_channel_retired");\n      ensureOutboundAllowed', "      ensureOutboundAllowed"]]],
  ["M24_release_mode_not_permanent", [[REC, "whatsappMode: whatsappChannelRetired(env) ? WHATSAPP_RETIRED_MODE : whatsappTransport", "whatsappMode: whatsappTransport"]]],
  ["M25_channel_status_counts_whatsapp", [[REC, "  if (whatsappChannelRetired(env) && active.whatsapp) active.whatsapp = ", "  if (false) active.whatsapp = "]]],
  ["M26_distribution_counts_whatsapp", [[REC, 'const distributionRetired = whatsappChannelRetired(env) ? ["whatsapp"] : [];', "const distributionRetired = [];"]]],
  ["M27_projection_ignores_retirement", [[LIVE, "whatsapp: whatsappRetired ? WHATSAPP_RETIRED_MODE : (whatsappTransportOperational", "whatsapp: (whatsappTransportOperational"]]],
  ["M28_quorum_counts_retired", [[CONT, "  for(const name of retired) byName.delete(name);\n  const countable=channels.filter((item)=>!retired.has(item.name));", "  const countable=channels;"]]],
  ["M29_onboarding_alive", [[ONB, "return whatsappGoneResponse(url.pathname);", "return null;"]]],
  ["M30_broker_alive", [[BROKER, "status: 410,", "status: 200,"]]],
  ["M31_instant_status_env_default", [[COMPAT, "enabled: whatsappInstantReplyEnabled(normalized),", 'enabled: (env.WHATSAPP_INSTANT_REPLY ?? "true") !== "false",']]],
  ["M32_forged_generator_reintroduced", [[FORGER, null, FORGER_SRC]]],
  ["M33_proof_job_parked_if_false", [[WF, "    if: github.event_name == 'workflow_dispatch'", "    if: ${{ false && github.event_name == 'workflow_dispatch' }}"]]],
  ["M34_webhook_accepts_runtime_verify_token", [[REC, 'const runtimeVerify = whatsappChannelRetired(process.env) ? "" : String(', "const runtimeVerify = String("]]],
  ["M35_social_reply_path_back", [[INB, ' return {handled:true,received:events.length,replied:0,mode:"manual_only"};', ' await fetch("https://graph.facebook.com/v26.0/"+encodeURIComponent(events[0].event_id)+"/private_replies",{method:"POST",body:"{}"});\n return {handled:true,received:events.length,replied:1,mode:"auto"};']]],
  ["M36_social_switch_back", [[INB, "export async function handleMetaSocialInbound(payload){", 'export function metaSocialAutoreplyEnabled(env={}){return String(env?.META_SOCIAL_AUTOREPLY??"")==="true";}\nexport async function handleMetaSocialInbound(payload){']]],
  ["M37_social_claims_non_social", [[INB, " if(!events.length)return {handled:false,received:0,replied:0};", " if(!events.length)return {handled:true,received:0,replied:0};"]]],
  ["M38_bundle_loads_page_token_for_social", [[REC, "const social = await handleMetaSocialInbound(payload).catch(", "const social = await handleMetaSocialInbound(payload, { META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN }).catch("]]],
  // Sol FAIL on #896: the generator assigned SUPPORT_CHANNEL and only pop()ed it later. Assignment back, strip removed.
  ["M39_generator_assigns_support_channel", [[GEN, GEN_SALES, GEN_SALES + 'c["vars"]["SUPPORT_CHANNEL"]="WhatsApp +55 88 99254-5413"\n'], [GEN, GEN_STRIP, ""]]],
  ["M40_generator_keeps_legacy_base_alias", [[GEN, GEN_STRIP, ""]]],
  ["M41_generator_emits_whatsapp_display", [[GEN, GEN_STRIP, GEN_STRIP + 'runtime["ZEVANORY_WHATSAPP_DISPLAY"]="+55 88 99254-5413"\n']]],
  ["M42_toml_support_channel_back", [[TOML, "\n[vars]\n", '\n[vars]\nSUPPORT_CHANNEL = "WhatsApp +55 88 99254-5413"\n']]],
  // Follow-up on #896: retired channel re-enabled; public assets keep / regain the banned account.
  ["M43_whatsapp_sales_reenabled", [[GEN, GEN_SALES, 'c["vars"]["WHATSAPP_SALES_ENABLED"]="true"\n']]],
  ["M44_contact_js_not_neutralized", [[GEN, '    contact_js.write_bytes(WHATSAPP_FREE_CONTACT_JS.encode("utf-8"))\n', "    pass\n"]]],
  ["M45_public_scan_disabled", [[GEN, "if _wa_hits:\n", "if False:\n"]]],
  ["M46_number_pattern_weakened", [[SCAN, '("number 9234-0423", _number_pattern("92340423")),', '("number 9234-0423", re.compile(r"9234-0423")),']]],
  ["M47_jsonld_telephone_kept", [[GEN, '    new_home = re.sub(r\',"telephone":"[^"]*"\', "", new_home)\n', ""]]],
  ["M48_public_number_rewrite_back", [[GEN, "home = Path(\"public/index.html\")\n", 'replacements = {"558892340423": "5588992545413"}\nhome = Path("public/index.html")\n']]],
  // Follow-up on #896: a workflow brings a retired WhatsApp alias back (mercadopago-exact-sha-recovery.yml used to).
  ["M49_workflow_whatsapp_alias_back", [[MPWF, '          v["WHATSAPP_SALES_ENABLED"]="false"\n', '          v["WHATSAPP_SALES_ENABLED"]="false"\n          v["ZEVANORY_WHATSAPP_DISPLAY"]="+55 88 99254-5413"\n']]],
];

const sha = (s) => createHash("sha256").update(s).digest("hex");
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const CLASSIFIER = resolve(ROOT, "scripts/ci/mutant_classifier.py");
const CONFIG_PATH = resolve(ROOT, "scripts/ci/mutants_whatsapp_retirement.expected.json");
const WORK = mkdtempSync(join(tmpdir(), "zev-wa-mutants-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));
const py = (args) => spawnSync(PY, ["-B", ...args], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 120000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } });
function refuse(msg) { console.log("MUTANT CONFIG REFUSED " + msg); process.exit(4); }
let CONFIG;
{
  let raw;
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch (e) { refuse("unreadable config: " + e.message); }
  const v = py(["-c", "import json,sys; sys.path.insert(0, sys.argv[1]); import mutant_classifier as m\ntry:\n    m.load_mutant_config(json.load(open(sys.argv[2], encoding='utf-8'))['mutants'])\nexcept m.ConfigError as e:\n    print('CONFIG_ERROR ' + str(e)); sys.exit(4)\nprint('CONFIG_OK')", dirname(CLASSIFIER), CONFIG_PATH]);
  if (v.status !== 0 || !/^CONFIG_OK$/m.test(v.stdout)) refuse((v.stdout + v.stderr).trim().split("\n").pop() || "load_mutant_config failed (status " + v.status + ")");
  CONFIG = raw.mutants;
  const ids = MUTANTS.map(([id]) => id), keys = Object.keys(CONFIG);
  const missing = ids.filter((id) => !keys.includes(id)), extra = keys.filter((id) => !ids.includes(id));
  if (missing.length || extra.length) refuse(`config/mutant mismatch missing=${missing.join(",")} extra=${extra.join(",")}`);
  const noLabel = keys.filter((id) => CONFIG[id].primary.some((e) => typeof e.assertion_pattern !== "string" || !e.assertion_pattern.trim()));
  if (noLabel.length) refuse("primary without assertion_pattern: " + noLabel.join(","));
}
function run() {
  const r = spawnSync("node", ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", ...SUITES], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const out = String(r.stdout || "");
  const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)$`, "m")) || [])[1] ?? -1);
  return { rc: r.status, signal: r.signal || null, timedOut: r.error?.code === "ETIMEDOUT", out, err: String(r.stderr || ""), tests: num("tests"), pass: num("pass"), fail: num("fail") };
}
// Shared classifier CLI (scripts/ci/mutant_classifier.py classify): one JSON line per run.
function classify(r, id, spec, { baseline = false } = {}) {
  const tap = join(WORK, "run.tap"), err = join(WORK, "run.err"), exp = join(WORK, "expected.json");
  writeFileSync(tap, r.out); writeFileSync(err, r.err); writeFileSync(exp, JSON.stringify(spec || {}));
  const args = [CLASSIFIER, "classify", "--baseline-total", String(BASE_COUNT), "--tap", tap, "--stderr", err, "--expected", "@" + exp];
  if (r.rc !== null && r.rc !== undefined) args.push("--rc", String(r.rc));
  if (r.signal) args.push("--signal", r.signal);
  if (r.timedOut) args.push("--timed-out");
  if (baseline) args.push("--baseline"); else args.push("--mutant-id", id);
  const c = py(args);
  try { return JSON.parse(c.stdout.trim().split("\n").pop()); }
  catch { return { verdict: "INCONCLUSIVE", reason: "classifier_cli_failed:" + (c.stderr || c.stdout).slice(-200), killing_tests: [] }; }
}

const base = run();
const baseCheck = classify(base, "BASELINE", null, { baseline: true });
if (base.tests !== BASE_COUNT || base.pass !== BASE_COUNT || base.fail !== 0 || baseCheck.ok !== true) {
  console.log(`BASELINE FAIL tests=${base.tests} pass=${base.pass} fail=${base.fail} rc=${base.rc} classifier=${JSON.stringify(baseCheck).slice(0, 300)}`);
  process.exit(1);
}
console.log(`BASELINE PASS tests=${base.tests}`);
let bad = 0;
for (const [id, edits] of MUTANTS) {
  const saved = new Map();
  let anchorProblem = null;
  try {
    for (const [file, from, to] of edits) {
      const path = resolve(ROOT, file);
      if (from === null) {
        if (existsSync(path)) { anchorProblem = "file_exists"; break; }
        saved.set(path, null); writeFileSync(path, to); continue;
      }
      const raw = readFileSync(path);
      if (!saved.has(path)) saved.set(path, raw);
      const current = normalizeEol(raw.toString("utf8"));
      if (current.split(from).length !== 2) { anchorProblem = "anchor_not_unique:" + file; break; }
      writeFileSync(path, current.replace(from, to));
    }
    var r = anchorProblem ? null : run();
  } finally {
    for (const [path, orig] of saved) { if (orig === null) { if (existsSync(path)) unlinkSync(path); } else writeFileSync(path, orig); }
  }
  for (const [path, orig] of saved) {
    if (orig === null ? existsSync(path) : sha(readFileSync(path)) !== sha(orig)) { console.log(`RESTORE FAIL ${path}`); process.exit(2); }
  }
  if (anchorProblem) { console.log(`MUTANT ${id} INCONCLUSIVE reason=${anchorProblem}`); bad++; continue; }
  const v = classify(r, id, CONFIG[id]);
  if (v.verdict !== "KILLED") bad++;
  console.log(`MUTANT ${id} ${v.verdict} by=${JSON.stringify((v.killing_tests || []).map((n) => String(n).slice(0, 40)))} ids=${JSON.stringify(v.assertion_ids || [])} reason=${String(v.reason).slice(0, 200)}`);
}
console.log(bad ? `MUTANTS FAIL not_killed=${bad}` : `MUTANTS PASS killed=${MUTANTS.length}/${MUTANTS.length}`);
process.exit(bad ? 1 : 0);
