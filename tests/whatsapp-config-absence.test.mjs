// ZEVANORY | WhatsApp retired (PR #896, Sol FAIL on the structural removal): no WhatsApp contact alias may
// reach a Worker configuration. Scans
//   * EVERY tracked wrangler*.toml / wrangler*.json / wrangler*.jsonc (git ls-files, any directory), and
//   * the candidate config that scripts/deploy/prepare-central-candidate.py GENERATES (run for real in a
//     temp dir, from a base config seeded with the legacy aliases the 83620c6 base still carries),
// (the pinned real base 83620c6:wrangler.jsonc, which still has SUPPORT_CHANNEL with the legacy number and
// cannot be edited, is run through the same generator and scanned in central-candidate-dryrun.yml),
// and requires the absence of: SUPPORT_CHANNEL, ZEVANORY_WHATSAPP_*, wa.me, the retired number
// 99254-5413 / 992545413 / 92545413 and the legacy number 9234-0423 / 92340423.
// Allow-list: none. Only this test file (seed fixture below) and scripts/ci mutant definitions contain the
// literals; neither is a wrangler* config nor generated config, so nothing is exempted from the scan.
// Causal mutant: scripts/ci/mutants_whatsapp_retirement.mjs M39 (assignment back, strip removed).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR = join(ROOT, "scripts/deploy/prepare-central-candidate.py");
const PYTHON = process.platform === "win32" ? "python" : "python3";
const BANNED = [
  ["SUPPORT_CHANNEL", /SUPPORT_CHANNEL/i],
  ["ZEVANORY_WHATSAPP_*", /ZEVANORY_WHATSAPP_/i],
  ["wa.me", /wa\.me/i],
  ["99254-5413 / 992545413 / 92545413", /9?9254-?5413/],
  ["9234-0423 / 92340423", /9234-?0423/],
];
const hits = (text) => BANNED.filter(([, re]) => re.test(text)).map(([name]) => name);
const HEALTH_ANCHOR = "const commercialSafetyLocked = publicSafetyLocked || pilotSafetyLocked || preSaleCutoverSafe || commercialLivePattern;";

function generateCandidate(baseVars) {
  const dir = mkdtempSync(join(tmpdir(), "zev-wa-absence-"));
  try {
    mkdirSync(join(dir, "worker")); mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "wrangler.central-fix.jsonc"), JSON.stringify({ name: "zevanory", vars: baseVars, triggers: { crons: ["0 * * * *"] } }, null, 2));
    writeFileSync(join(dir, "worker/binding-aliases.mjs"), "      return Reflect.get(target, prop, receiver);\n      return Reflect.has(target, prop);\n");
    writeFileSync(join(dir, "worker/cloudflare-worker.recovered.mjs"), HEALTH_ANCHOR + "\n");
    writeFileSync(join(dir, "public/solucoes.html"), "<main>solucoes</main>\n");
    writeFileSync(join(dir, "public/sitemap.xml"), "<urlset></urlset>\n");
    requireTool(PYTHON);
    execFileSync(PYTHON, [GENERATOR], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000,
      env: { ...process.env, PUBLIC_OWNER_ACCOUNT_ID: "0".repeat(32), TARGET_RUNTIME_SHA: "a".repeat(40), ZEVANORY_LAUNCH_AUTHORIZATION: "" },
    });
    return readTextNormalized(join(dir, "wrangler.central-fix.jsonc"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("wrangler configs: no tracked wrangler*.toml/json/jsonc carries a WhatsApp alias or retired number", () => {
  const globs = ["toml", "json", "jsonc"].flatMap((ext) => [`:(glob)wrangler*.${ext}`, `:(glob)**/wrangler*.${ext}`]);
  const files = execFileSync("git", ["ls-files", "-z", "--", ...globs], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);
  assert.ok(files.includes("wrangler.sales.toml") && files.includes("wrangler.public-router.toml"), "scan found the known tomls: " + files.join(","));
  for (const file of files) assert.deepEqual(hits(readTextNormalized(join(ROOT, file))), [], file);
});

test("generated candidate config: prepare-central-candidate.py emits no WhatsApp alias or retired number", () => {
  // Base seeded like 83620c6 wrangler.jsonc (legacy SUPPORT_CHANNEL) plus every alias shape ever used.
  const base = {
    SUPPORT_CHANNEL: "WhatsApp +55 88 9234-0423",
    ZEVANORY_WHATSAPP_DISPLAY: "+55 88 99254-5413",
    ZEVANORY_WHATSAPP_E164: "5588992545413",
    ZEVANORY_WHATSAPP_COUNTRY: "BR",
    ZEVANORY_RUNTIME_CONFIG: { ZEVANORY_WHATSAPP_DISPLAY: "+55 88 99254-5413", SUPPORT_CHANNEL: "WhatsApp +55 88 92340423" },
  };
  assert.equal(hits(JSON.stringify(base)).length, BANNED.length - 1, "seed exercises the aliases (all but wa.me)");
  const out = generateCandidate(base);
  const cfg = JSON.parse(out);
  assert.equal(cfg.vars.ZEVANORY_RELEASE_SHA, "a".repeat(40), "generator really ran");
  assert.deepEqual(hits(out), [], "generated candidate config must not carry a WhatsApp alias");
});

test("generator source: never assigns SUPPORT_CHANNEL or ZEVANORY_WHATSAPP_* into the config", () => {
  const src = readTextNormalized(GENERATOR);
  assert.doesNotMatch(src, /\["(SUPPORT_CHANNEL|ZEVANORY_WHATSAPP_[A-Z0-9_]*)"\]\s*=/);
  assert.doesNotMatch(src, /setdefault\(\s*"(SUPPORT_CHANNEL|ZEVANORY_WHATSAPP_[A-Z0-9_]*)"/);
});
