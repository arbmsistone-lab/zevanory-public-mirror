// ZEVANORY | WhatsApp retired (PR #896, Sol FAIL on the structural removal): no WhatsApp contact alias may
// reach a Worker configuration, the retired channel stays closed, and no public page exposes the banned
// account. Scans / proves:
//   * EVERY tracked wrangler*.toml / wrangler*.json / wrangler*.jsonc (git ls-files, any directory);
//   * the candidate config that scripts/deploy/prepare-central-candidate.py GENERATES (run for real in a
//     temp dir, from a base config seeded with the legacy aliases the 83620c6 base still carries), including
//     WHATSAPP_SALES_ENABLED === "false";
//   * the generated PUBLIC assets: the frozen snapshot's wa.me injector (whatsapp-contact.js) and JSON-LD
//     telephone (index.html) are neutralized, and any leftover wa.me / api.whatsapp.com / number in any
//     format makes the generator exit non-zero (fail closed).
// The pinned real base 83620c6 (wrangler.jsonc + public/) is run through the same generator and scanned
// again in central-candidate-dryrun.yml. Banned: SUPPORT_CHANNEL, ZEVANORY_WHATSAPP_*, wa.me,
// api.whatsapp.com, 99254-5413 / 992545413 / 92545413, 9234-0423 / 92340423, WHATSAPP_SALES_ENABLED=true.
// Allow-list: none. Only this test file (seed fixtures below) and scripts/ci mutant definitions contain the
// literals; neither is a wrangler* config nor generated output, so nothing is exempted from the scan.
//   * every .github/workflows/*.yml: no assignment of SUPPORT_CHANNEL / ZEVANORY_WHATSAPP_* and neither number in any
//     format (scripts/deploy/public_whatsapp_scan.py --workflows; mercadopago-exact-sha-recovery.yml used to assign).
//   * the three WhatsApp Cloud API settings the 83620c6 base still ships inside ZEVANORY_RUNTIME_CONFIG
//     (WHATSAPP_PHONE_NUMBER_ID, META_WHATSAPP_IDENTITY_VERIFIED, WHATSAPP_BRAND_IDENTITY_VERIFIED) are absent from
//     every tracked wrangler* config and from the generated candidate (top-level vars AND the runtime config);
//   * no over-stripping: META_VERIFY_TOKEN (shared Instagram/Facebook webhook verify token), META_APP_SECRET01,
//     META_GRAPH_VERSION and every other META_* / FACEBOOK_* / INSTAGRAM_* key of the seed survive unchanged.
// Causal mutants: scripts/ci/mutants_whatsapp_retirement.mjs M39-M51.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
  ["api.whatsapp.com", /api\.whatsapp\.com/i],
  ["99254-5413 / 992545413 / 92545413", /9?9254[-\s.]?5413/],
  ["9234-0423 / 92340423", /9234[-\s.]?0423/],
  ["WHATSAPP_SALES_ENABLED=true", /WHATSAPP_SALES_ENABLED"?\s*[:=]\s*"?true/i],
];
const hits = (text) => BANNED.filter(([, re]) => re.test(text)).map(([name]) => name);
// Retired WhatsApp Cloud API settings (83620c6 wrangler.jsonc lines 54/67/69, inside ZEVANORY_RUNTIME_CONFIG).
const RETIRED_META = ["WHATSAPP_PHONE_NUMBER_ID", "META_WHATSAPP_IDENTITY_VERIFIED", "WHATSAPP_BRAND_IDENTITY_VERIFIED"];
const retiredMetaHits = (text) => RETIRED_META.filter((k) => new RegExp(`\\b${k}\\b`).test(text));
// Keys that must NOT be stripped (Instagram/Facebook inbound still uses them).
const KEEP_PREFIX = /^(META_|FACEBOOK_|INSTAGRAM_)/;
const HEALTH_ANCHOR = "const commercialSafetyLocked = publicSafetyLocked || pilotSafetyLocked || preSaleCutoverSafe || commercialLivePattern;";
// Same shapes as the frozen 83620c6 public/ snapshot.
const LEGACY_CONTACT_JS = "(()=>{\n  const NUMBER='558892340423',DISPLAY='+55 88 9234-0423';\n  const href=`https://wa.me/${NUMBER}?text=x`;\n})();\n";
const LEGACY_HOME = '<script type="application/ld+json">{"@type":"Organization","email":"contato@zevanory.api.br","telephone":"+55 88 9234-0423","contactPoint":{"@type":"ContactPoint","telephone":"+55 88 9234-0423","contactType":"sales and customer support"}}</script><script src="/whatsapp-contact.js" defer></script>\n';

function runGenerator(baseVars, extraPublic = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zev-wa-absence-"));
  try {
    mkdirSync(join(dir, "worker")); mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "wrangler.central-fix.jsonc"), JSON.stringify({ name: "zevanory", vars: baseVars, triggers: { crons: ["0 * * * *"] } }, null, 2));
    writeFileSync(join(dir, "worker/binding-aliases.mjs"), "      return Reflect.get(target, prop, receiver);\n      return Reflect.has(target, prop);\n");
    writeFileSync(join(dir, "worker/cloudflare-worker.recovered.mjs"), HEALTH_ANCHOR + "\n");
    const publicFiles = { "solucoes.html": "<main>solucoes</main>\n", "sitemap.xml": "<urlset></urlset>\n", "whatsapp-contact.js": LEGACY_CONTACT_JS, "index.html": LEGACY_HOME, ...extraPublic };
    for (const [name, text] of Object.entries(publicFiles)) writeFileSync(join(dir, "public", name), text);
    requireTool(PYTHON);
    const r = spawnSync(PYTHON, [GENERATOR], {
      cwd: dir, encoding: "utf8", timeout: 60000, windowsHide: true,
      env: { ...process.env, PUBLIC_OWNER_ACCOUNT_ID: "0".repeat(32), TARGET_RUNTIME_SHA: "a".repeat(40), ZEVANORY_LAUNCH_AUTHORIZATION: "" },
    });
    const read = (rel) => (existsSync(join(dir, rel)) ? readTextNormalized(join(dir, rel)) : null);
    return { status: r.status, output: String(r.stdout || "") + String(r.stderr || ""), config: read("wrangler.central-fix.jsonc"),
      publicText: Object.keys(publicFiles).map((n) => read("public/" + n) ?? "").join("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const LEGACY_BASE = Object.freeze({
  SUPPORT_CHANNEL: "WhatsApp +55 88 9234-0423",
  WHATSAPP_SALES_ENABLED: "true",
  ZEVANORY_WHATSAPP_DISPLAY: "+55 88 99254-5413",
  ZEVANORY_WHATSAPP_E164: "5588992545413",
  ZEVANORY_WHATSAPP_COUNTRY: "BR",
  // Retired WhatsApp Cloud API settings, in both bags (the real base carries them in the runtime config).
  WHATSAPP_PHONE_NUMBER_ID: "000000000000000",
  META_WHATSAPP_IDENTITY_VERIFIED: "true",
  WHATSAPP_BRAND_IDENTITY_VERIFIED: "true",
  // Must survive (fixture placeholders, not credentials).
  META_VERIFY_TOKEN: "fixture-shared-meta-verify-token",
  META_APP_SECRET01: "fixture-meta-app-secret01",
  FACEBOOK_PAGE_ID: "fixture-facebook-page",
  INSTAGRAM_BUSINESS_ACCOUNT_ID: "fixture-instagram-account",
  ZEVANORY_RUNTIME_CONFIG: {
    ZEVANORY_WHATSAPP_DISPLAY: "+55 88 99254-5413", SUPPORT_CHANNEL: "WhatsApp +55 88 92340423",
    WHATSAPP_BRAND_IDENTITY_VERIFIED: "true", WHATSAPP_PHONE_NUMBER_ID: "000000000000000", META_WHATSAPP_IDENTITY_VERIFIED: "true",
    META_GRAPH_VERSION: "v26.0", META_VERIFY_TOKEN: "fixture-shared-meta-verify-token",
    INSTAGRAM_BRAND_IDENTITY_VERIFIED: "true", FACEBOOK_BRAND_IDENTITY_VERIFIED: "true",
    INSTAGRAM_OPERATOR_ASSISTED_PUBLISHING: "true", INSTAGRAM_PROFILE_URL: "https://www.instagram.com/zevanory_/",
    FACEBOOK_OPERATOR_ASSISTED_PUBLISHING: "true", FACEBOOK_PROFILE_URL: "https://www.facebook.com/zevanory",
  },
});

test("wrangler configs: no tracked wrangler*.toml/json/jsonc carries a WhatsApp alias or retired number", () => {
  const globs = ["toml", "json", "jsonc"].flatMap((ext) => [`:(glob)wrangler*.${ext}`, `:(glob)**/wrangler*.${ext}`]);
  const files = execFileSync("git", ["ls-files", "-z", "--", ...globs], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);
  assert.ok(files.includes("wrangler.sales.toml") && files.includes("wrangler.public-router.toml"), "scan found the known tomls: " + files.join(","));
  for (const file of files) assert.deepEqual(hits(readTextNormalized(join(ROOT, file))), [], "[WR-TOML] " + file);
  for (const file of files) assert.deepEqual(retiredMetaHits(readTextNormalized(join(ROOT, file))), [], "[WR-TOML-META] " + file);
});

test("generated candidate config: prepare-central-candidate.py emits no WhatsApp alias, channel closed", () => {
  // Base seeded like 83620c6 wrangler.jsonc (legacy SUPPORT_CHANNEL) plus every alias shape ever used.
  assert.equal(hits(JSON.stringify(LEGACY_BASE)).length, BANNED.length - 2, "seed exercises the aliases (all but wa.me/api.whatsapp.com)");
  const r = runGenerator(LEGACY_BASE);
  assert.equal(r.status, 0, "generator must succeed on the neutralized snapshot: " + r.output.slice(-800));
  const cfg = JSON.parse(r.config);
  assert.equal(cfg.vars.ZEVANORY_RELEASE_SHA, "a".repeat(40), "generator really ran");
  assert.equal(cfg.vars.WHATSAPP_SALES_ENABLED, "false", "[WR-CFG-SALES] retired WhatsApp channel must stay closed");
  assert.deepEqual(hits(r.config), [], "[WR-CFG-ALIAS] generated candidate config must not carry a WhatsApp alias");
  // The seed really carries the three retired settings in both bags, so their absence below is the generator's work.
  for (const k of RETIRED_META) assert.ok(k in LEGACY_BASE && k in LEGACY_BASE.ZEVANORY_RUNTIME_CONFIG, "seed carries " + k);
  const rt = cfg.vars.ZEVANORY_RUNTIME_CONFIG || {};
  const leaked = RETIRED_META.filter((k) => k in cfg.vars || k in rt).concat(retiredMetaHits(r.config).map((k) => "text:" + k));
  assert.deepEqual(leaked, [], "[WR-CFG-META] retired WhatsApp settings must be dropped from vars and ZEVANORY_RUNTIME_CONFIG");
});

test("no over-stripping: META_VERIFY_TOKEN and every other META_/FACEBOOK_/INSTAGRAM_ key survive the generator", () => {
  const seedRt = LEGACY_BASE.ZEVANORY_RUNTIME_CONFIG;
  assert.ok(LEGACY_BASE.META_VERIFY_TOKEN && seedRt.META_VERIFY_TOKEN && LEGACY_BASE.META_APP_SECRET01 && seedRt.META_GRAPH_VERSION, "seed carries the keys to keep");
  const r = runGenerator(LEGACY_BASE);
  assert.equal(r.status, 0, "generator must succeed: " + r.output.slice(-800));
  const cfg = JSON.parse(r.config);
  const rt = cfg.vars.ZEVANORY_RUNTIME_CONFIG || {};
  const expected = [["vars", LEGACY_BASE, cfg.vars], ["runtime", seedRt, rt]].flatMap(([bag, seed, out]) =>
    Object.keys(seed).filter((k) => KEEP_PREFIX.test(k) && !RETIRED_META.includes(k)).map((k) => [bag, k, seed[k], out[k]]));
  assert.ok(expected.length >= 12 && expected.some(([b, k]) => b === "vars" && k === "META_VERIFY_TOKEN") && expected.some(([b, k]) => b === "runtime" && k === "META_VERIFY_TOKEN"), "keep set covers META_VERIFY_TOKEN in both bags");
  const lost = expected.filter(([, , want, got]) => got !== want).map(([bag, k]) => bag + ":" + k);
  assert.deepEqual(lost, [], "[WR-CFG-KEEP] generator over-stripped keys that are not WhatsApp settings");
});

test("generated public assets: wa.me injector and JSON-LD telephone of the frozen snapshot are neutralized", () => {
  const r = runGenerator(LEGACY_BASE);
  assert.equal(r.status, 0, "[WR-PUB-NEUTRAL] " + r.output.slice(-800));
  assert.match(r.output, /^PUBLIC_WHATSAPP_FREE=PASS$/m);
  assert.deepEqual(hits(r.publicText), [], "public assets must not expose the banned WhatsApp account");
  assert.match(r.publicText, /"@type":"ContactPoint","email":"suporte@zevanory\.api\.br"/);
  // The contact script is retired on the apex: not published, no page references it (worker tombstone).
  assert.match(r.output, /^PUBLIC_RETIRED_CONTACT_SCRIPT=ABSENT$/m);
  assert.doesNotMatch(r.publicText, /whatsapp-contact/, "[WR-PUB-RETIRED] no generated asset names the retired script");
});

test("fail-closed: any leftover wa.me, api.whatsapp.com or number (any format) in public assets aborts the generator", () => {
  for (const leftover of ['<a href="https://wa.me/5511">x</a>', '<a href="https://api.whatsapp.com/send?phone=1">x</a>', "Atendimento (88) 9234 0423", "+55 88 99254.5413", "tel:5588992545413"]) {
    const r = runGenerator(LEGACY_BASE, { "contato.html": leftover + "\n" });
    assert.notEqual(r.status, 0, "[WR-FAILCLOSED] generator must fail closed on: " + leftover);
    assert.match(r.output, /PUBLIC_WHATSAPP_CONTACT_PRESENT .*contato\.html/, leftover);
  }
});

test("generator source: never assigns SUPPORT_CHANNEL/ZEVANORY_WHATSAPP_* nor re-enables WhatsApp sales", () => {
  const src = readTextNormalized(GENERATOR);
  assert.doesNotMatch(src, /\["(SUPPORT_CHANNEL|ZEVANORY_WHATSAPP_[A-Z0-9_]*)"\]\s*=/, "[WR-SRC-ALIAS] generator assigns a WhatsApp alias");
  assert.doesNotMatch(src, /setdefault\(\s*"(SUPPORT_CHANNEL|ZEVANORY_WHATSAPP_[A-Z0-9_]*)"/);
  assert.doesNotMatch(src, /WHATSAPP_SALES_ENABLED"\]\s*=\s*"true"/, "[WR-SRC-SALES] generator re-enables WhatsApp sales");
  assert.doesNotMatch(src, /"558892340423"\s*:\s*"5588992545413"/, "[WR-SRC-REWRITE] public number rewrite is gone");
});

test("workflows: no .github/workflows/*.yml assigns SUPPORT_CHANNEL/ZEVANORY_WHATSAPP_* or carries either number", () => {
  requireTool(PYTHON);
  const scan = (dir) => spawnSync(PYTHON, ["-B", join(ROOT, "scripts/deploy/public_whatsapp_scan.py"), "--workflows", dir], { encoding: "utf8", timeout: 60000, windowsHide: true });
  const repo = scan(join(ROOT, ".github/workflows"));
  assert.equal(repo.status, 0, "[WR-WF-ASSIGN] workflows must be free of retired WhatsApp aliases/numbers: " + String(repo.stdout) + String(repo.stderr));
  assert.match(String(repo.stdout), /^WORKFLOWS_WHATSAPP_FREE=PASS\r?$/m);
  // The scanner itself is not vacuous: each reintroduction shape is caught.
  const dir = mkdtempSync(join(tmpdir(), "zev-wa-wf-"));
  try {
    for (const [name, text] of [["sub.yml", '      v["ZEVANORY_WHATSAPP_DISPLAY"]="x"\n'], ["env.yml", "    env:\n      SUPPORT_CHANNEL: x\n"],
      ["num.yml", "      run: echo +55 (88) 9234 0423\n"], ["e164.yml", '      run: echo "5588992545413"\n']]) {
      for (const f of ["sub.yml", "env.yml", "num.yml", "e164.yml"]) rmSync(join(dir, f), { force: true });
      writeFileSync(join(dir, name), "on: push\njobs:\n  a:\n    steps:\n" + text);
      const r = scan(dir);
      assert.equal(r.status, 1, "scanner must flag " + name + ": " + r.stdout);
    }
    for (const f of ["sub.yml", "env.yml", "num.yml", "e164.yml"]) rmSync(join(dir, f), { force: true });
    writeFileSync(join(dir, "guard.yml"), "      run: grep -nE 'SUPPORT_CHANNEL|ZEVANORY_WHATSAPP_' x; v.pop(\"SUPPORT_CHANNEL\")\n");
    assert.equal(scan(dir).status, 0, "guards that only name the aliases are allowed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
