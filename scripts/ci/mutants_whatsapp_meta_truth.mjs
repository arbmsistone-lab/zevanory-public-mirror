#!/usr/bin/env node
// Mutants for the fail-closed WhatsApp Meta-truth gate. Each mutant edits a source file IN PLACE, runs
// tests/whatsapp-meta-truth.test.mjs + tests/live-runtime-status.test.mjs (TAP) and restores the file
// (SHA-256 checked after every mutant and at the end).
//   KILLED       = at least one EXPECTED test fails with an assertion error (ERR_ASSERTION).
//   SURVIVED     = both suites pass with the baseline counts.
//   INCONCLUSIVE = anything else (load error, non-assertion failure only, unexpected test only).
// Exit code 0 only if the baseline is green and every mutant is KILLED. Offline, no secrets.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SUITES = ["tests/whatsapp-meta-truth.test.mjs", "tests/live-runtime-status.test.mjs"];
const BASE_COUNT = 16;
const T = {
  declined: "DECLINED display name",
  expired: "EXPIRED code verification",
  sol: "Sol's live Meta truth",
  stale: "stale snapshot",
  cold: "cold isolate with no snapshot",
  healthy: "all healthy and fresh",
  each: "token, number, display name",
  whitelist: "snapshot is a closed whitelist",
  writer: "writer persists",
  refresh: "opportunistic refresh",
  wiring: "wiring:",
  live: "fresh green preflight",
};
const TRUTH = "worker/whatsapp-meta-truth.mjs", LIVE = "worker/live-runtime-status.mjs";
const REC = "worker/cloudflare-worker.recovered.mjs", COMPAT = "worker/cloudflare-worker.compat.mjs";
const MUTANTS = [
  ["M1_declined_accepted", TRUTH, 'ACCEPTED_NAME_STATUS = Object.freeze(["APPROVED", "AVAILABLE_WITHOUT_REVIEW"])', 'ACCEPTED_NAME_STATUS = Object.freeze(["APPROVED", "AVAILABLE_WITHOUT_REVIEW", "DECLINED"])', [T.declined, T.sol]],
  ["M2_expired_accepted", TRUTH, 'ACCEPTED_CODE_VERIFICATION = Object.freeze(["VERIFIED"])', 'ACCEPTED_CODE_VERIFICATION = Object.freeze(["VERIFIED", "EXPIRED", "NOT_VERIFIED"])', [T.expired]],
  ["M3_ttl_doubled", TRUTH, "if (now - at > maxAgeMs) return", "if (now - at > maxAgeMs * 2) return", [T.stale]],
  ["M4_ttl_boundary", TRUTH, "if (now - at > maxAgeMs) return", "if (now - at >= maxAgeMs) return", [T.stale]],
  ["M5_missing_is_ready", TRUTH, 'if (snap === null) return verdict(false, "meta_snapshot_missing");', 'if (snap === null) return verdict(true, "meta_snapshot_missing");', [T.cold]],
  ["M6_future_accepted", TRUTH, "if (at - now > MAX_FUTURE_SKEW_MS)", "if (false)", [T.stale]],
  ["M7_token_ignored", TRUTH, 'if (snap.token_valid !== true) return verdict(false, "meta_token_invalid", facts);', "", [T.each]],
  ["M8_perm_ignored", TRUTH, "&& perms.whatsapp_business_messaging === true && perms.whatsapp_business_management === true", "", [T.each]],
  ["M9_quality_red", TRUTH, 'ACCEPTED_QUALITY = Object.freeze(["GREEN", "YELLOW"])', 'ACCEPTED_QUALITY = Object.freeze(["GREEN", "YELLOW", "RED", "UNKNOWN"])', [T.each]],
  ["M10_healthy_never", TRUTH, 'return verdict(true, "meta_truth_fresh_healthy", facts);', 'return verdict(false, "meta_truth_fresh_healthy", facts);', [T.healthy, T.live]],
  ["M11_no_ttl_write", TRUTH, "{ expirationTtl: KV_EXPIRATION_S }", "{}", [T.writer]],
  ["M12_secret_leak", TRUTH, "    broker_reason: reasonCode(s.reason) || null,", "    broker_reason: reasonCode(s.reason) || null,\n    access_token: s.access_token,", [T.whitelist]],
  ["M13_globals_back", LIVE, "return whatsappTransportVerdict(env, { now }).ready === true;", "return whatsappTransportVerdict(env, { now }).ready === true || _runtime?.identity_verified === true;", [T.declined, T.cold, T.live]],
  ["M14_truthy_enables", LIVE, 'whatsapp: whatsappTransportOperational === true ? "enabled" : "disabled",', 'whatsapp: whatsappTransportOperational ? "enabled" : "disabled",', [T.sol]],
  ["M15_warm_isolate_bypass", REC, "    operational_ready: truth.ready,\n    operational_mode: truth.ready ? \"provider_api_meta_verified\"", "    operational_ready: truth.ready || state2.configured,\n    operational_mode: truth.ready ? \"provider_api_meta_verified\"", [T.declined, T.expired, T.stale, T.cold]],
  ["M16_route_bypass", REC, '    if (name === "whatsapp") return [name, whatsappMetaGatedEntry(state2, profile2, fallback, env)];\n', "", [T.wiring]],
  ["M17_hydrate_inherits", REC, '  target[WHATSAPP_META_STATUS_ENV_KEY] = String(env?.[WHATSAPP_META_STATUS_ENV_KEY] ?? "");\n', "", [T.wiring]],
  ["M18_release_not_injected", COMPAT, 'if (whatsappPath || url.pathname === "/api/release" || url.pathname === "/api/config") {', "if (whatsappPath) {", [T.wiring]],
];

const sha = (s) => createHash("sha256").update(s).digest("hex");
function run() {
  let out = "";
  try {
    out = execFileSync("node", ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", ...SUITES], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  } catch (e) { out = String(e.stdout || "") + String(e.stderr || ""); }
  const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)$`, "m")) || [])[1] ?? -1);
  const failures = [];
  const re = /^not ok \d+ - (.+)$/gm;
  let m;
  while ((m = re.exec(out))) {
    const rest = out.slice(m.index, m.index + 4000);
    const next = rest.slice(1).search(/^(ok|not ok) \d+ - /m);
    const block = next > 0 ? rest.slice(0, next + 1) : rest;
    failures.push({ name: m[1], assertion: /ERR_ASSERTION|AssertionError/.test(block) });
  }
  return { tests: num("tests"), pass: num("pass"), fail: num("fail"), failures };
}

const base = run();
if (base.tests !== BASE_COUNT || base.pass !== BASE_COUNT || base.fail !== 0) {
  console.log(`BASELINE FAIL tests=${base.tests} pass=${base.pass} fail=${base.fail}`);
  process.exit(1);
}
console.log(`BASELINE PASS tests=${base.tests}`);
let bad = 0;
for (const [id, file, from, to, expected] of MUTANTS) {
  const path = resolve(ROOT, file);
  const orig = readFileSync(path, "utf8");
  const origSha = sha(orig);
  if (orig.split(from).length !== 2) { console.log(`MUTANT ${id} INCONCLUSIVE reason=anchor_not_unique`); bad++; continue; }
  let r;
  try {
    writeFileSync(path, orig.replace(from, to));
    r = run();
  } finally {
    writeFileSync(path, orig);
  }
  if (sha(readFileSync(path, "utf8")) !== origSha) { console.log(`RESTORE FAIL ${file}`); process.exit(2); }
  const killedBy = r.failures.filter((f) => f.assertion && expected.some((e) => f.name.startsWith(e)));
  const status = killedBy.length ? "KILLED" : (r.fail === 0 && r.pass === BASE_COUNT ? "SURVIVED" : "INCONCLUSIVE");
  if (status !== "KILLED") bad++;
  console.log(`MUTANT ${id} ${status} by=${JSON.stringify(killedBy.map((f) => f.name.slice(0, 40)))} fail=${r.fail}`);
}
console.log(bad ? `MUTANTS FAIL not_killed=${bad}` : `MUTANTS PASS killed=${MUTANTS.length}/${MUTANTS.length}`);
process.exit(bad ? 1 : 0);
