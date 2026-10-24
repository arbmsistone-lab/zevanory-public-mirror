#!/usr/bin/env node
// Mutants for the fail-closed WhatsApp retirement (Meta permanently disabled WABA 4019600665012911 on
// 2026-10-10; retirement is a code constant) and the manual-only Instagram/Facebook inbound. Each mutant
// edits source IN PLACE (or adds a file), runs tests/whatsapp-retirement.test.mjs +
// tests/meta-social-manual-only.test.mjs (TAP) and restores the original bytes (SHA-256 checked after
// every mutant; added files removed). Portable: anchors are matched on EOL-normalized text (a Windows
// checkout with CRLF matches the same LF anchors) and the original bytes are written back.
//   KILLED       = at least one EXPECTED test fails with an assertion error (ERR_ASSERTION).
//   SURVIVED     = both suites pass with the baseline counts.
//   INCONCLUSIVE = anything else (load error, non-assertion failure only, unexpected test only).
// Exit 0 only if the baseline is green and every mutant is KILLED. Offline, no secrets.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { normalizeEol } from "../../tests/helpers/text.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SUITES = ["tests/whatsapp-retirement.test.mjs", "tests/meta-social-manual-only.test.mjs", "tests/whatsapp-config-absence.test.mjs"];
const BASE_COUNT = 25;
const T = {
  sw: "kill-switch: retirement is a code constant", paths: "retired: no fetch", surf: "status surfaces:", proj: "projection:", quorum: "provider independence:",
  hook: "Meta webhook: WhatsApp deliveries", nonwa: "Meta webhook: Instagram/Facebook", bhook: "bundle layer", gone: "onboarding routes", broker: "broker tombstone:", prims: "sender primitives",
  adapter: "outbound adapter", reply: "instant reply:", h18: "webhook handler:", forger: "static: no forged", wf: "static: retired workflows", onb: "static: retired onboarding",
  sManual: "keyword comments, Page feed", sNon: "non-social payloads", sStatic: "static: no social automation",
  cfgToml: "wrangler configs:", cfgGen: "generated candidate config:", pubGen: "generated public assets:",
  failClosed: "fail-closed: any leftover", genSrc: "generator source:"
};
const RET = "worker/whatsapp-retirement.mjs", COMPAT = "worker/cloudflare-worker.compat.mjs", REC = "worker/cloudflare-worker.recovered.mjs";
const LIVE = "worker/live-runtime-status.mjs", CONT = "worker/continuity-router.mjs", ONB = "worker/whatsapp-onboarding.mjs";
const BROKER = "worker/whatsapp-credential-broker.mjs", INB = "worker/inbound-autonomy.mjs", WF = ".github/workflows/voice-render-proof.yml";
const FORGER = "scripts/ci/_mutant_forger.mjs";
const GEN = "scripts/deploy/prepare-central-candidate.py", TOML = "wrangler.sales.toml";
const GEN_STRIP = 'for _bag in (c["vars"], runtime):\n    for _key in [k for k in _bag if _retired_whatsapp_alias(k)]:\n        _bag.pop(_key)\n';
const GEN_SALES = 'c["vars"]["WHATSAPP_SALES_ENABLED"]="false"  # WhatsApp retired (PR #896): channel closed for good, never "true"\n';
const SCAN = "scripts/deploy/public_whatsapp_scan.py";
// The generator shape lives under tests/ (outside the static scan) and is copied in only for M28.
const FORGER_SRC = normalizeEol(readFileSync(resolve(ROOT, "tests/fixtures/forged-webhook-generator.txt"), "utf8"));

// [id, [[file, from, to] ...], expected tests]   (from === null: create file `file` with `to`)
const MUTANTS = [
  ["M01_env_reenables_channel", [[RET, "export function whatsappChannelRetired(_env) {\n  return WHATSAPP_CHANNEL_RETIRED;", 'export function whatsappChannelRetired(_env) {\n  return String(_env?.WHATSAPP_CHANNEL_RETIRED ?? "true").trim().toLowerCase() !== "false";']], [T.sw, T.paths]],
  ["M02_constant_flipped", [[RET, "export const WHATSAPP_CHANNEL_RETIRED = true;", "export const WHATSAPP_CHANNEL_RETIRED = false;"]], [T.sw]],
  ["M03_env_reenables_instant_reply", [[RET, "export function whatsappInstantReplyEnabled(_env) {\n  return false;", 'export function whatsappInstantReplyEnabled(_env) {\n  return String(_env?.WHATSAPP_INSTANT_REPLY ?? "") === "true";']], [T.sw]],
  ["M04_process_env_reenables_channel", [[RET, "export function whatsappChannelRetired(_env) {\n  return WHATSAPP_CHANNEL_RETIRED;", 'export function whatsappChannelRetired(_env) {\n  return globalThis.process?.env?.WHATSAPP_CHANNEL_RETIRED !== "false";']], [T.sw, T.paths]],
  ["M05_compat_reads_broker_status", [[COMPAT, "  if (whatsappChannelRetired(env)) return null;\n  if (!binding?.fetch) return null;", "  if (!binding?.fetch) return null;"], [COMPAT, "whatsappRetired ? Promise.resolve(null) : loadWhatsappBrokerState(", "loadWhatsappBrokerState("]], [T.paths]],
  ["M06_compat_keeps_stale_globals", [[COMPAT, "      globalThis.__ZEVANORY_WHATSAPP_RUNTIME__ = {};\n      globalThis.__ZEVANORY_WHATSAPP_BROKER__ = null;\n      globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__ = null;\n", ""]], [T.paths]],
  ["M07_edge_classification_removed", [[COMPAT, 'if (classifyMetaWebhookBody(raw) === "whatsapp") return whatsappWebhookAckResponse();', "if (false) return whatsappWebhookAckResponse();"]], [T.hook]],
  ["M08_edge_silent_ack_any_product", [[COMPAT, 'if (classifyMetaWebhookBody(raw) === "whatsapp") return whatsappWebhookAckResponse();', 'if (classifyMetaWebhookBody(raw) !== "never") return whatsappWebhookAckResponse();']], [T.nonwa]],
  ["M09_edge_large_body_silent_ack", [[COMPAT, "      if (!(declared > META_WEBHOOK_CLASSIFY_MAX_BYTES)) {", "      if (declared > META_WEBHOOK_CLASSIFY_MAX_BYTES) return whatsappWebhookAckResponse();\n      {"]], [T.nonwa]],
  ["M10_classifier_instagram_as_whatsapp", [[RET, 'if (object === "instagram") return "instagram";', 'if (object === "instagram") return "whatsapp";']], [T.nonwa]],
  ["M11_classifier_no_size_bound", [[RET, 'if (!text || text.length > META_WEBHOOK_CLASSIFY_MAX_BYTES) return "unclassified";', 'if (!text) return "unclassified";']], [T.nonwa]],
  ["M12_classifier_ignores_social_fields", [[RET, 'if (!field || SOCIAL_FIELDS.has(field)) return "unclassified";', 'if (!field) return "unclassified";']], [T.nonwa]],
  ["M13_bundle_webhook_processes_whatsapp", [[REC, "  if (whatsappChannelRetired(process.env) && isWhatsappWebhookBody(raw)) return json14(res, 200, { accepted: true, processed: false, stored: false, reason: WHATSAPP_RETIRED_REASON });\n", ""]], [T.bhook]],
  ["M14_broker_call_guard_removed", [[REC, '  if (whatsappChannelRetired(process.env)) return { ok: false, status: 410, body: { error: "whatsapp_channel_retired", reason: WHATSAPP_RETIRED_REASON } };\n  const broker', "  const broker"]], [T.bhook, T.prims]],
  ["M15_identity_calls_graph", [[REC, "  if (whatsappChannelRetired(env)) return result(false, false, WHATSAPP_RETIRED_REASON, { retired: true, mode: WHATSAPP_RETIRED_MODE });\n", ""]], [T.paths, T.surf]],
  ["M16_migration_probe_uses_wa_token", [[REC, 'fallback = whatsappChannelRetired(process.env) ? "" : String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();', 'fallback = String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();']], [T.paths, T.surf]],
  ["M17_reply_retired_guard_removed", [[REC, '  if (whatsappChannelRetired(process.env)) return { sent: false, reason: "whatsapp_channel_retired" };\n  if (!whatsappInstantReplyEnabled', "  if (!whatsappInstantReplyEnabled"]], [T.reply]],
  ["M18_webhook_instant_reply_env_default", [[REC, 'if (whatsappInstantReplyEnabled(process.env) && (item.type === "text"', 'if (process.env.WHATSAPP_INSTANT_REPLY !== "false" && (item.type === "text"']], [T.onb]],
  ["M19_webhook_processes_inbound", [[REC, "const inbound = whatsappChannelRetired(process.env) ? [] : extractWhatsappInboundMessages(payload);", "const inbound = extractWhatsappInboundMessages(payload);"]], [T.h18]],
  ["M20_sender_guard_removed", [[REC, '  if (whatsappChannelRetired(process.env)) return { ok: false, status: 410, provider_message_id: null, error: "whatsapp_channel_retired" };\n', ""]], [T.prims]],
  ["M21_voice_upload_guard_removed", [[REC, '  if (whatsappChannelRetired(env) || whatsappChannelRetired(process.env)) throw new Error("whatsapp_channel_retired");\n  const staged', "  const staged"]], [T.prims]],
  ["M22_media_download_guard_removed", [[REC, '  if (whatsappChannelRetired(env) || whatsappChannelRetired(process.env)) throw new Error("whatsapp_channel_retired");\n  const rtMedia', "  const rtMedia"]], [T.prims]],
  ["M23_outbound_adapter_guard_removed", [[REC, '      if (whatsappChannelRetired(env) || whatsappChannelRetired(process.env)) throw new Error("whatsapp_channel_retired");\n      ensureOutboundAllowed', "      ensureOutboundAllowed"]], [T.adapter]],
  ["M24_release_mode_not_permanent", [[REC, "whatsappMode: whatsappChannelRetired(env) ? WHATSAPP_RETIRED_MODE : whatsappTransport", "whatsappMode: whatsappTransport"]], [T.surf]],
  ["M25_channel_status_counts_whatsapp", [[REC, "  if (whatsappChannelRetired(env) && active.whatsapp) active.whatsapp = ", "  if (false) active.whatsapp = "]], [T.surf]],
  ["M26_distribution_counts_whatsapp", [[REC, 'const distributionRetired = whatsappChannelRetired(env) ? ["whatsapp"] : [];', "const distributionRetired = [];"]], [T.surf]],
  ["M27_projection_ignores_retirement", [[LIVE, "whatsapp: whatsappRetired ? WHATSAPP_RETIRED_MODE : (whatsappTransportOperational", "whatsapp: (whatsappTransportOperational"]], [T.proj]],
  ["M28_quorum_counts_retired", [[CONT, "  for(const name of retired) byName.delete(name);\n  const countable=channels.filter((item)=>!retired.has(item.name));", "  const countable=channels;"]], [T.quorum]],
  ["M29_onboarding_alive", [[ONB, "return whatsappGoneResponse(url.pathname);", "return null;"]], [T.gone]],
  ["M30_broker_alive", [[BROKER, "status: 410,", "status: 200,"]], [T.broker]],
  ["M31_instant_status_env_default", [[COMPAT, "enabled: whatsappInstantReplyEnabled(normalized),", 'enabled: (env.WHATSAPP_INSTANT_REPLY ?? "true") !== "false",']], [T.surf, T.onb]],
  ["M32_forged_generator_reintroduced", [[FORGER, null, FORGER_SRC]], [T.forger]],
  ["M33_proof_job_parked_if_false", [[WF, "    if: github.event_name == 'workflow_dispatch'", "    if: ${{ false && github.event_name == 'workflow_dispatch' }}"]], [T.wf]],
  ["M34_webhook_accepts_runtime_verify_token", [[REC, 'const runtimeVerify = whatsappChannelRetired(process.env) ? "" : String(', "const runtimeVerify = String("]], [T.bhook]],
  ["M35_social_reply_path_back", [[INB, ' return {handled:true,received:events.length,replied:0,mode:"manual_only"};', ' await fetch("https://graph.facebook.com/v26.0/"+encodeURIComponent(events[0].event_id)+"/private_replies",{method:"POST",body:"{}"});\n return {handled:true,received:events.length,replied:1,mode:"auto"};']], [T.sManual, T.sStatic]],
  ["M36_social_switch_back", [[INB, "export async function handleMetaSocialInbound(payload){", 'export function metaSocialAutoreplyEnabled(env={}){return String(env?.META_SOCIAL_AUTOREPLY??"")==="true";}\nexport async function handleMetaSocialInbound(payload){']], [T.sStatic]],
  ["M37_social_claims_non_social", [[INB, " if(!events.length)return {handled:false,received:0,replied:0};", " if(!events.length)return {handled:true,received:0,replied:0};"]], [T.sNon]],
  ["M38_bundle_loads_page_token_for_social", [[REC, "const social = await handleMetaSocialInbound(payload).catch(", "const social = await handleMetaSocialInbound(payload, { META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN }).catch("]], [T.sStatic]],
  // Sol FAIL on #896: the generator assigned SUPPORT_CHANNEL and only pop()ed it later. Assignment back, strip removed.
  ["M39_generator_assigns_support_channel", [[GEN, GEN_SALES, GEN_SALES + 'c["vars"]["SUPPORT_CHANNEL"]="WhatsApp +55 88 99254-5413"\n'], [GEN, GEN_STRIP, ""]], [T.cfgGen]],
  ["M40_generator_keeps_legacy_base_alias", [[GEN, GEN_STRIP, ""]], [T.cfgGen]],
  ["M41_generator_emits_whatsapp_display", [[GEN, GEN_STRIP, GEN_STRIP + 'runtime["ZEVANORY_WHATSAPP_DISPLAY"]="+55 88 99254-5413"\n']], [T.cfgGen]],
  ["M42_toml_support_channel_back", [[TOML, "\n[vars]\n", '\n[vars]\nSUPPORT_CHANNEL = "WhatsApp +55 88 99254-5413"\n']], [T.cfgToml]],
  // Follow-up on #896: retired channel re-enabled; public assets keep / regain the banned account.
  ["M43_whatsapp_sales_reenabled", [[GEN, GEN_SALES, 'c["vars"]["WHATSAPP_SALES_ENABLED"]="true"\n']], [T.cfgGen]],
  ["M44_contact_js_not_neutralized", [[GEN, '    contact_js.write_bytes(WHATSAPP_FREE_CONTACT_JS.encode("utf-8"))\n', "    pass\n"]], [T.cfgGen, T.pubGen]],
  ["M45_public_scan_disabled", [[GEN, "if _wa_hits:\n", "if False:\n"]], [T.failClosed]],
  ["M46_number_pattern_weakened", [[SCAN, '("number 9234-0423", _number_pattern("92340423")),', '("number 9234-0423", re.compile(r"9234-0423")),']], [T.failClosed]],
  ["M47_jsonld_telephone_kept", [[GEN, '    new_home = re.sub(r\',"telephone":"[^"]*"\', "", new_home)\n', ""]], [T.cfgGen, T.pubGen]],
  ["M48_public_number_rewrite_back", [[GEN, "home = Path(\"public/index.html\")\n", 'replacements = {"558892340423": "5588992545413"}\nhome = Path("public/index.html")\n']], [T.genSrc]],
];

const sha = (s) => createHash("sha256").update(s).digest("hex");
function run() {
  let out = "";
  try {
    out = execFileSync("node", ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", ...SUITES], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { out = String(e.stdout || "") + String(e.stderr || ""); }
  const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)$`, "m")) || [])[1] ?? -1);
  const failures = [];
  const re = /^not ok \d+ - (.+)$/gm;
  let m;
  while ((m = re.exec(out))) {
    const rest = out.slice(m.index, m.index + 400000);
    const next = rest.slice(1).search(/^(ok|not ok) \d+ - /m);
    const block = next > 0 ? rest.slice(0, next + 1) : rest;
    failures.push({ name: m[1], assertion: /ERR_ASSERTION|AssertionError/.test(block) });
  }
  return { tests: num("tests"), pass: num("pass"), fail: num("fail"), failures };
}

const base = run();
if (base.tests !== BASE_COUNT || base.pass !== BASE_COUNT || base.fail !== 0) {
  console.log(`BASELINE FAIL tests=${base.tests} pass=${base.pass} fail=${base.fail} ${JSON.stringify(base.failures)}`);
  process.exit(1);
}
console.log(`BASELINE PASS tests=${base.tests}`);
let bad = 0;
for (const [id, edits, expected] of MUTANTS) {
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
  const killedBy = r.failures.filter((f) => f.assertion && expected.some((e) => f.name.startsWith(e)));
  const status = killedBy.length ? "KILLED" : (r.fail === 0 && r.pass === BASE_COUNT ? "SURVIVED" : "INCONCLUSIVE");
  if (status !== "KILLED") bad++;
  console.log(`MUTANT ${id} ${status} by=${JSON.stringify(killedBy.map((f) => f.name.slice(0, 40)))} fail=${r.fail}${status === "INCONCLUSIVE" ? " failures=" + JSON.stringify(r.failures.map((f) => [f.name.slice(0, 40), f.assertion])) : ""}`);
}
console.log(bad ? `MUTANTS FAIL not_killed=${bad}` : `MUTANTS PASS killed=${MUTANTS.length}/${MUTANTS.length}`);
process.exit(bad ? 1 : 0);
