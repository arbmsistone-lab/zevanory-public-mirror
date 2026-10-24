#!/usr/bin/env node
// Mutants for the fail-closed WhatsApp retirement (Meta permanently disabled WABA 4019600665012911 on
// 2026-10-10) and the Meta social auto-reply kill-switch. Each mutant edits source IN PLACE (or adds a
// file), runs tests/whatsapp-retirement.test.mjs + tests/meta-social-autoreply.test.mjs (TAP) and
// restores everything (SHA-256 checked after every mutant; added files removed).
//   KILLED       = at least one EXPECTED test fails with an assertion error (ERR_ASSERTION).
//   SURVIVED     = both suites pass with the baseline counts.
//   INCONCLUSIVE = anything else (load error, non-assertion failure only, unexpected test only).
// Exit 0 only if the baseline is green and every mutant is KILLED. Offline, no secrets.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SUITES = ["tests/whatsapp-retirement.test.mjs", "tests/meta-social-autoreply.test.mjs"];
const BASE_COUNT = 22;
const T = {
  sw: "kill-switch: absent", paths: "retired: no fetch", surf: "status surfaces:", proj: "projection:", quorum: "provider independence:",
  hook: "Meta webhook:", bhook: "bundle layer", gone: "onboarding routes", broker: "broker tombstone:", prims: "sender primitives",
  adapter: "outbound adapter", reply: "instant reply:", h18: "webhook handler:", forger: "static: no forged", wf: "static: retired workflows", onb: "static: retired onboarding",
  sOff: "kill-switch is OFF", sOne: "on: a keyword comment", sKw: "on: no keyword", sRate: "on: rate limits", s4xx: "on: any 4xx", sPol: "on: a Graph policy"
};
const RET = "worker/whatsapp-retirement.mjs", COMPAT = "worker/cloudflare-worker.compat.mjs", REC = "worker/cloudflare-worker.recovered.mjs";
const LIVE = "worker/live-runtime-status.mjs", CONT = "worker/continuity-router.mjs", ONB = "worker/whatsapp-onboarding.mjs";
const BROKER = "worker/whatsapp-credential-broker.mjs", INB = "worker/inbound-autonomy.mjs", WF = ".github/workflows/voice-render-proof.yml";
const FORGER = "scripts/ci/_mutant_forger.mjs";
// The generator shape lives under tests/ (outside the static scan) and is copied in only for M28.
const FORGER_SRC = readFileSync(resolve(ROOT, "tests/fixtures/forged-webhook-generator.txt"), "utf8");

// [id, [[file, from, to] ...], expected tests]   (from === null: create file `file` with `to`)
const MUTANTS = [
  ["M01_absent_means_active", [[RET, "if (raw === undefined || raw === null) return true;", "if (raw === undefined || raw === null) return false;"]], [T.sw, T.paths]],
  ["M02_any_value_unretires", [[RET, 'return String(raw).trim().toLowerCase() !== "false";', 'return String(raw).trim().toLowerCase() === "true";']], [T.sw]],
  ["M03_instant_reply_default_on", [[RET, 'return String(env?.WHATSAPP_INSTANT_REPLY ?? "").trim().toLowerCase() === "true";', 'return String(env?.WHATSAPP_INSTANT_REPLY ?? "").trim().toLowerCase() !== "false";']], [T.sw, T.reply, T.h18]],
  ["M04_instant_reply_not_forced_off", [[RET, "  if (whatsappChannelRetired(env)) return false;\n  return String(env?.WHATSAPP_INSTANT_REPLY", "  return String(env?.WHATSAPP_INSTANT_REPLY"]], [T.sw]],
  ["M05_compat_reads_broker_status", [[COMPAT, "  if (whatsappChannelRetired(env)) return null;\n  if (!binding?.fetch) return null;", "  if (!binding?.fetch) return null;"], [COMPAT, "whatsappRetired ? Promise.resolve(null) : loadWhatsappBrokerState(", "loadWhatsappBrokerState("]], [T.paths]],
  ["M06_compat_keeps_stale_globals", [[COMPAT, "      globalThis.__ZEVANORY_WHATSAPP_RUNTIME__ = {};\n      globalThis.__ZEVANORY_WHATSAPP_BROKER__ = null;\n      globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__ = null;\n", ""]], [T.paths]],
  ["M07_compat_edge_ack_removed", [[COMPAT, "if (raw.length > 256 * 1024 || isWhatsappWebhookBody(raw)) return whatsappWebhookAckResponse();", "if (false) return whatsappWebhookAckResponse();"]], [T.hook]],
  ["M08_bundle_webhook_processes_whatsapp", [[REC, "  if (whatsappChannelRetired(process.env) && isWhatsappWebhookBody(raw)) return json14(res, 200, { accepted: true, processed: false, stored: false, reason: WHATSAPP_RETIRED_REASON });\n", ""]], [T.bhook]],
  ["M09_broker_call_guard_removed", [[REC, '  if (whatsappChannelRetired(process.env)) return { ok: false, status: 410, body: { error: "whatsapp_channel_retired", reason: WHATSAPP_RETIRED_REASON } };\n  const broker', "  const broker"]], [T.bhook, T.prims]],
  ["M10_identity_calls_graph", [[REC, "  if (whatsappChannelRetired(env)) return result(false, false, WHATSAPP_RETIRED_REASON, { retired: true, mode: WHATSAPP_RETIRED_MODE });\n", ""]], [T.paths, T.surf]],
  ["M11_migration_probe_uses_wa_token", [[REC, 'fallback = whatsappChannelRetired(process.env) ? "" : String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();', 'fallback = String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();']], [T.paths, T.surf]],
  ["M12_reply_retired_guard_removed", [[REC, '  if (whatsappChannelRetired(process.env)) return { sent: false, reason: "whatsapp_channel_retired" };\n  if (!whatsappInstantReplyEnabled', "  if (!whatsappInstantReplyEnabled"]], [T.reply]],
  ["M13_reply_instant_guard_removed", [[REC, '  if (!whatsappInstantReplyEnabled(process.env)) return { sent: false, reason: "whatsapp_instant_reply_disabled" };\n', ""]], [T.reply]],
  ["M14_webhook_instant_default_on", [[REC, 'if (whatsappInstantReplyEnabled(process.env) && (item.type === "text"', 'if (process.env.WHATSAPP_INSTANT_REPLY !== "false" && (item.type === "text"']], [T.h18, T.onb]],
  ["M15_webhook_processes_inbound_retired", [[REC, "const inbound = whatsappChannelRetired(process.env) ? [] : extractWhatsappInboundMessages(payload);", "const inbound = extractWhatsappInboundMessages(payload);"]], [T.h18]],
  ["M16_sender_guard_removed", [[REC, '  if (whatsappChannelRetired(process.env)) return { ok: false, status: 410, provider_message_id: null, error: "whatsapp_channel_retired" };\n', ""]], [T.prims]],
  ["M17_voice_upload_guard_removed", [[REC, '  if (whatsappChannelRetired(env) || whatsappChannelRetired(process.env)) throw new Error("whatsapp_channel_retired");\n  const staged', "  const staged"]], [T.prims]],
  ["M18_media_download_guard_removed", [[REC, '  if (whatsappChannelRetired(env) || whatsappChannelRetired(process.env)) throw new Error("whatsapp_channel_retired");\n  const rtMedia', "  const rtMedia"]], [T.prims]],
  ["M19_outbound_adapter_guard_removed", [[REC, '      if (whatsappChannelRetired(env) || whatsappChannelRetired(process.env)) throw new Error("whatsapp_channel_retired");\n      ensureOutboundAllowed', "      ensureOutboundAllowed"]], [T.adapter]],
  ["M20_release_mode_not_permanent", [[REC, "whatsappMode: whatsappChannelRetired(env) ? WHATSAPP_RETIRED_MODE : whatsappTransport", "whatsappMode: whatsappTransport"]], [T.surf]],
  ["M21_channel_status_counts_whatsapp", [[REC, "  if (whatsappChannelRetired(env) && active.whatsapp) active.whatsapp = ", "  if (false) active.whatsapp = "]], [T.surf]],
  ["M22_distribution_counts_whatsapp", [[REC, 'const distributionRetired = whatsappChannelRetired(env) ? ["whatsapp"] : [];', "const distributionRetired = [];"]], [T.surf]],
  ["M23_projection_ignores_retirement", [[LIVE, "whatsapp: whatsappRetired ? WHATSAPP_RETIRED_MODE : (whatsappTransportOperational", "whatsapp: (whatsappTransportOperational"]], [T.proj]],
  ["M24_quorum_counts_retired", [[CONT, "  for(const name of retired) byName.delete(name);\n  const countable=channels.filter((item)=>!retired.has(item.name));", "  const countable=channels;"]], [T.quorum]],
  ["M25_onboarding_alive", [[ONB, "return whatsappGoneResponse(url.pathname);", "return null;"]], [T.gone]],
  ["M26_broker_alive", [[BROKER, "status: 410,", "status: 200,"]], [T.broker]],
  ["M27_instant_status_default_on", [[COMPAT, "enabled: whatsappInstantReplyEnabled(normalized),", 'enabled: (env.WHATSAPP_INSTANT_REPLY ?? "true") !== "false",']], [T.surf, T.onb]],
  ["M28_forged_generator_reintroduced", [[FORGER, null, FORGER_SRC]], [T.forger]],
  ["M29_proof_job_parked_if_false", [[WF, "    if: github.event_name == 'workflow_dispatch'", "    if: ${{ false && github.event_name == 'workflow_dispatch' }}"]], [T.wf]],
  ["M30_webhook_accepts_runtime_verify_token", [[REC, 'const runtimeVerify = whatsappChannelRetired(process.env) ? "" : String(', "const runtimeVerify = String("]], [T.bhook]],
  ["M31_social_default_on", [[INB, 'return String(env?.META_SOCIAL_AUTOREPLY??"").trim().toLowerCase()==="true";', 'return String(env?.META_SOCIAL_AUTOREPLY??"").trim().toLowerCase()!=="false";']], [T.sOff]],
  ["M32_social_public_reply_back", [[INB, 'if(event.kind==="comment")privateId=await graph(', 'if(event.kind==="comment"){await graph(fetchImpl,`${encodeURIComponent(event.comment_id)}/comments`,token,{message:"Obrigado por comentar!"});}if(event.kind==="comment")privateId=await graph(']], [T.sOne]],
  ["M33_social_keyword_bypass", [[INB, "if(!reply.trigger){results.push", "if(false){results.push"], [INB, 'if(!trigger)return {private:null,trigger:false};', 'if(!trigger)return {private:"Obrigado pela mensagem!",trigger:true};']], [T.sKw]],
  ["M34_social_rate_limit_removed", [[INB, "if(keys.some(([,max],i)=>counts[i]>=max))", "if(false)"]], [T.sRate]],
  ["M35_social_breaker_never_trips", [[INB, "if(error?.trip){", "if(false){"]], [T.s4xx, T.sPol]],
  ["M36_social_breaker_ignored", [[INB, "if(await kv?.get?.(META_SOCIAL_BREAKER_KEY))return", "if(false)return"]], [T.s4xx]],
  ["M37_social_4xx_not_tripping", [[INB, "this.trip=(status>=400&&status<500)||POLICY_CODES.has(Number(code));", "this.trip=POLICY_CODES.has(Number(code));"]], [T.s4xx]],
  ["M38_social_policy_code_not_tripping", [[INB, "this.trip=(status>=400&&status<500)||POLICY_CODES.has(Number(code));", "this.trip=(status>=400&&status<500);"]], [T.sPol]],
  ["M39_social_dedup_removed", [[INB, "const dedup=`zpc:inbound:meta:${event.event_id}`;if(await kv?.get?.(dedup))continue;", "const dedup=`zpc:inbound:meta:${event.event_id}`;"]], [T.sOne, T.sPol]],
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
    const rest = out.slice(m.index, m.index + 6000);
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
      const orig = saved.has(path) ? readFileSync(path, "utf8") : readFileSync(path, "utf8");
      if (!saved.has(path)) saved.set(path, orig);
      if (orig.split(from).length !== 2) { anchorProblem = "anchor_not_unique:" + file; break; }
      writeFileSync(path, orig.replace(from, to));
    }
    var r = anchorProblem ? null : run();
  } finally {
    for (const [path, orig] of saved) { if (orig === null) { if (existsSync(path)) unlinkSync(path); } else writeFileSync(path, orig); }
  }
  for (const [path, orig] of saved) {
    if (orig === null ? existsSync(path) : sha(readFileSync(path, "utf8")) !== sha(orig)) { console.log(`RESTORE FAIL ${path}`); process.exit(2); }
  }
  if (anchorProblem) { console.log(`MUTANT ${id} INCONCLUSIVE reason=${anchorProblem}`); bad++; continue; }
  const killedBy = r.failures.filter((f) => f.assertion && expected.some((e) => f.name.startsWith(e)));
  const status = killedBy.length ? "KILLED" : (r.fail === 0 && r.pass === BASE_COUNT ? "SURVIVED" : "INCONCLUSIVE");
  if (status !== "KILLED") bad++;
  console.log(`MUTANT ${id} ${status} by=${JSON.stringify(killedBy.map((f) => f.name.slice(0, 40)))} fail=${r.fail}${status === "INCONCLUSIVE" ? " failures=" + JSON.stringify(r.failures.map((f) => [f.name.slice(0, 40), f.assertion])) : ""}`);
}
console.log(bad ? `MUTANTS FAIL not_killed=${bad}` : `MUTANTS PASS killed=${MUTANTS.length}/${MUTANTS.length}`);
process.exit(bad ? 1 : 0);
