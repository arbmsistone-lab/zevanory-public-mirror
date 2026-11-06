// T1 strict exclusivity (outside tests/*.test.mjs on purpose: needs PyYAML; run by t1-exclusivity-strict.yml): write-path inventory (scripts/deploy/worker_write_paths.py) and strict verdict
// (scripts/deploy/t1_exclusivity_verdict.py). Fixture repositories are written to a temp dir and every Cloudflare
// response is mocked: no network, no credentials, no production effect. Each assertion carries a marker
// [T1-Wnn] / [T1-Vnn] used by scripts/ci/mutants_t1_exclusivity.py (shared mutant classifier).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INV = process.env.T1_WRITE_PATHS_SCRIPT || join(ROOT, "scripts/deploy/worker_write_paths.py");
const VER = process.env.T1_VERDICT_SCRIPT || join(ROOT, "scripts/deploy/t1_exclusivity_verdict.py");
const PY = process.env.PYTHON || "python3";
const ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

const tmps = [];
test.after(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(files, registry = {}) {
  const d = mkdtempSync(join(tmpdir(), "t1x-"));
  tmps.push(d);
  const reg = { services: { "prod-w": { group: "deploy-prod-w", canonical: "canon.yml", config_publishers: ["cfg.yml"] } },
    retired: ["old.yml"], validation_only: [], unserialized_known: {}, workers_builds: {}, manual_operations: {},
    pre_guard_isolated_steps: {}, ...registry };
  for (const [p, body] of Object.entries({ "ops/publishers.json": JSON.stringify(reg), ...files })) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  return d;
}
function inventory(root) {
  const r = spawnSync(PY, [INV, "--root", root, "--json"], { env: ENV, encoding: "utf8" });
  assert.ok((r.status === 0 || r.status === 1) && !r.stderr.includes("Traceback"), `inventory crashed rc=${r.status}: ${r.stderr.slice(-400)}`);
  return JSON.parse(r.stdout);
}
const codes = (res, path) => res.findings.filter((f) => !path || f.path === path).map((f) => f.code).sort();

const CRED = "    env:\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n";
const wf = (group, steps, extra = "") => `name: x\non:\n  push:\n    branches: [gh-pages]\nconcurrency:\n  group: ${group}\n  cancel-in-progress: false\n  queue: max\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n${CRED}${extra}    steps:\n${steps}`;
const GUARD = "      - name: Guard\n        id: guard\n        run: python3 scripts/deploy/promotion_guard.py --service prod-w --candidate \"$GITHUB_SHA\"\n";
const DEPLOY = (cond = "        if: steps.guard.outputs.decision == 'promote'\n", name = "prod-w") =>
  `      - name: Deploy\n${cond}        run: npx --yes wrangler@4.1.0 deploy --name ${name} --tag="$GITHUB_SHA"\n`;
const GUARDED = wf("deploy-prod-w", GUARD + DEPLOY());

// ------------------------------------------------------------------ inventory
test("T1-W01 direct wrangler deploy in an unregistered workflow is reported", () => {
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED, ".github/workflows/rogue.yml": wf("rogue", DEPLOY("")) }));
  assert.deepEqual(codes(res, "rogue.yml"), ["UNREGISTERED"], "[T1-W01] unregistered direct deploy must be a finding");
});

test("T1-W02 deploy through a repository script invoked by run: is followed", () => {
  const res = inventory(repo({
    ".github/workflows/canon.yml": GUARDED,
    ".github/workflows/viascript.yml": wf("viascript", "      - name: Ship\n        run: bash scripts/ship.sh\n"),
    "scripts/ship.sh": "#!/bin/sh\nset -e\nnpx wrangler deploy --config wrangler.toml\n",
  }));
  const row = res.rows.find((r) => r.path === "viascript.yml");
  assert.ok(row && row.ops.some((o) => o.includes("via scripts/ship.sh")), "[T1-W02] the script invocation must be followed");
  assert.deepEqual(codes(res, "viascript.yml"), ["UNREGISTERED"], "[T1-W02b] a deploy behind a script is still a write path");
});

test("T1-W03 Cloudflare API writes to settings and KV are detected with their kind", () => {
  const steps = "      - name: Settings\n        run: |\n          curl -fsS -X PATCH -H \"Authorization: Bearer $T\" \\\n            \"https://api.cloudflare.com/client/v4/accounts/$A/workers/scripts/prod-w/settings\"\n" +
    "      - name: KV\n        run: |\n          curl -sS -X PUT --data-binary @f \"https://api.cloudflare.com/client/v4/accounts/$A/storage/kv/namespaces/$NS/values/k\"\n";
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED, ".github/workflows/api.yml": wf("api", steps) }));
  const row = res.rows.find((r) => r.path === "api.yml");
  assert.deepEqual(row?.kinds, ["config", "kv"], "[T1-W03] API settings write is config and KV write is kv");
  assert.deepEqual(codes(res, "api.yml"), ["UNREGISTERED"], "[T1-W03b] unregistered API writer is a finding");
});

test("T1-W04 a Workers Builds marker is an unregistered code path until registered", () => {
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED, "scripts/ci/build.sh": "#!/bin/sh\necho \"$WORKERS_CI_COMMIT_SHA\"\n" }));
  assert.deepEqual(codes(res, "workers-builds:scripts/ci/build.sh"), ["UNREGISTERED"], "[T1-W04] Workers Builds must be registered");
});

test("T1-W05 a guarded, serialized canonical publisher passes", () => {
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED }));
  assert.deepEqual(res.findings, [], "[T1-W05] guarded canonical publisher yields no finding");
  assert.equal(res.rows.length, 1, "[T1-W05b] the canonical publisher is still inventoried");
});

test("T1-W06 removing the guard fails the gate (negative)", () => {
  const res = inventory(repo({ ".github/workflows/canon.yml": wf("deploy-prod-w", DEPLOY("")) }));
  assert.deepEqual(codes(res, "canon.yml"), ["UNGUARDED_CODE_PATH"], "[T1-W06] canonical deploy without guard is a finding");
});

test("T1-W07 a guard placed after the write does not count (negative)", () => {
  const res = inventory(repo({ ".github/workflows/canon.yml": wf("deploy-prod-w", DEPLOY("") + GUARD) }));
  assert.deepEqual(codes(res, "canon.yml"), ["UNGUARDED_CODE_PATH"], "[T1-W07] guard after the deploy is not a guard");
});

test("T1-W08 a guard whose decision does not gate the write does not count (negative)", () => {
  const res = inventory(repo({ ".github/workflows/canon.yml": wf("deploy-prod-w", GUARD + DEPLOY("")) }));
  assert.deepEqual(codes(res, "canon.yml"), ["UNGUARDED_CODE_PATH"], "[T1-W08] ungated write after a guard is a finding");
});

test("T1-W09 swapping the production target fails the gate (negative)", () => {
  const res = inventory(repo({ ".github/workflows/canon.yml": wf("deploy-prod-w", GUARD + DEPLOY(undefined, "other-w")) }));
  assert.deepEqual(codes(res, "canon.yml"), ["TARGET_MISMATCH"], "[T1-W09] canonical deploying another Worker is a finding");
});

test("T1-W10 a retired workflow that still writes is reported", () => {
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED, ".github/workflows/old.yml": wf("old", DEPLOY("")) }));
  assert.deepEqual(codes(res, "old.yml"), ["RETIRED_STILL_WRITES"], "[T1-W10] retired workflow must not write");
});

test("T1-W11 a job that cannot read a Cloudflare credential cannot change a Worker", () => {
  const nocred = wf("t", DEPLOY("")).replace(CRED, "    env:\n      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n");
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED, ".github/workflows/t.yml": nocred }));
  assert.deepEqual(codes(res, "t.yml"), [], "[T1-W11] no credential, no finding");
  assert.ok(res.rows.find((r) => r.path === "t.yml")?.no_credential_ops?.length === 1, "[T1-W11b] still listed as no_credential_ops");
});

test("T1-W12 dry-run deploys and flag-gated scripts invoked without the flag are not writes", () => {
  const steps = "      - name: Dry\n        run: npx --yes wrangler@4.1.0 deploy --dry-run --outdir x\n" +
    "      - name: Plan\n        run: python3 scripts/rot.py --worker prod-w\n";
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED, ".github/workflows/dry.yml": wf("dry", steps),
    "scripts/rot.py": "import sys\nAPPLY = '--apply' in sys.argv\ncmd = ['npx', 'wrangler', 'secret', 'put', 'K']\n" }));
  assert.deepEqual(codes(res, "dry.yml"), [], "[T1-W12] dry-run and plan-only invocations are not write paths");
});

test("T1-W13 a registered Workers Builds reserve needs the guard in its build script", () => {
  const reg = { workers_builds: { "prod-w": { build_script: "scripts/ci/build.sh", deploy_command: "npx wrangler deploy" } } };
  const guarded = inventory(repo({ ".github/workflows/canon.yml": GUARDED,
    "scripts/ci/build.sh": "#!/bin/sh\nSHA=$WORKERS_CI_COMMIT_SHA\npython3 scripts/deploy/promotion_guard.py --service prod-w --candidate $SHA\n" }, reg));
  assert.deepEqual(guarded.findings, [], "[T1-W13] registered and guarded reserve passes");
  const bare = inventory(repo({ ".github/workflows/canon.yml": GUARDED, "scripts/ci/build.sh": "#!/bin/sh\nSHA=$WORKERS_CI_COMMIT_SHA\n" }, reg));
  assert.deepEqual(codes(bare), ["UNGUARDED_CODE_PATH"], "[T1-W13b] reserve without guard is a finding");
});

test("T1-W14 a standalone script with Cloudflare writes is a recovery path that must be registered", () => {
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED,
    "scripts/fix.mjs": "await fetch(`https://api.cloudflare.com/client/v4/accounts/${a}/workers/scripts/prod-w`, { method: \"PUT\", body });\n" }));
  assert.deepEqual(codes(res, "scripts/fix.mjs"), ["UNREGISTERED_SCRIPT"], "[T1-W14] standalone writer must be registered");
});

test("T1-W15 a guard job in needs gating the deploy job counts", () => {
  const text = "name: x\non:\n  push:\nconcurrency:\n  group: deploy-prod-w\njobs:\n  guard:\n    runs-on: ubuntu-latest\n    steps:\n" + GUARD +
    "  deploy:\n    needs: guard\n    if: needs.guard.outputs.decision == 'promote'\n    runs-on: ubuntu-latest\n" + CRED + "    steps:\n" + DEPLOY("");
  const res = inventory(repo({ ".github/workflows/canon.yml": text }));
  assert.deepEqual(res.findings, [], "[T1-W15] guard in a needed job that gates the deploy job is accepted");
});

test("T1-W16 publishers pending the owner's authorization are reported, never accepted", () => {
  const reg = { services: { "prod-w": { group: "deploy-prod-w", canonical: "canon.yml", pending_owner_authorization: ["fin.yml"] } } };
  const fin = wf("fin-own", "      - name: Secret\n        run: npx wrangler secret put K --name prod-w\n");
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED, ".github/workflows/fin.yml": fin }, reg));
  assert.deepEqual(codes(res, "fin.yml"), ["PENDING_OWNER_AUTHORIZATION"], "[T1-W16] pending financial publisher is a finding");
});

test("T1-W17 a config publisher outside the service group is reported", () => {
  const cfg = wf("elsewhere", "      - name: Secret\n        run: npx wrangler secret put K --name prod-w\n");
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED, ".github/workflows/cfg.yml": cfg }));
  assert.deepEqual(codes(res, "cfg.yml"), ["NOT_SERIALIZED"], "[T1-W17] config publisher must share the service group");
});

test("T1-W19 a workflow whose YAML does not parse is reported and still scanned", () => {
  const bad = "name: x\non: push\njobs:\n  d:\n    env:\n      T: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:\n      - run: curl -X POST -H \"a: b\" https://api.cloudflare.com/client/v4/accounts/1/workers/scripts/prod-w/deployments\n";
  const res = inventory(repo({ ".github/workflows/canon.yml": GUARDED, ".github/workflows/bad.yml": bad }));
  assert.deepEqual(codes(res, "bad.yml"), ["UNPARSEABLE_WORKFLOW", "UNREGISTERED"], "[T1-W19] unparseable workflow never hides a write");
});

test("T1-W18 this repository: the required paths are inventoried and the router is guarded", () => {
  const res = inventory(ROOT);
  const paths = res.rows.map((r) => r.path);
  for (const p of ["mercadopago-exact-sha-recovery.yml", "mercadopago-production-token-rotate.yml", "financial-e2e-stripe.yml",
    "public-router-deploy.yml", "workers-builds:scripts/ci/cloudflare-build.sh"]) {
    assert.ok(paths.includes(p), `[T1-W18] ${p} must be covered by the inventory`);
  }
  const router = res.rows.find((r) => r.path === "public-router-deploy.yml");
  assert.deepEqual([router.unguarded, router.targets], [[], ["zevanory-public-router"]], "[T1-W18b] router deploy is guarded and targets the router");
  assert.ok(!paths.includes("whatsapp-zero-spend-broker.yml") && !paths.includes("whatsapp-broker-protocol-v2.yml"), "[T1-W18c] retired WhatsApp brokers no longer write");
});

// ------------------------------------------------------------------ strict verdict (mocked Cloudflare)
const ACC = "acc0";
const SHA = "a".repeat(40);
const WORKERS = { zevanory: "CF_TOKEN_ZEVANORY", "zevanory-sales-public": "CF_TOKEN_SALES", "zevanory-public-router": "CF_TOKEN_ROUTER", "zevanory-product-control-portable": "CF_TOKEN_PANEL" };
const ok = (result, extra = {}) => [200, { success: true, result, ...extra }];
const policy = (res, group = "Workers Scripts Write") => [{ effect: "allow", permission_groups: [{ name: group }], resources: { [res]: "*" } }];
const scoped = (w) => policy(`com.cloudflare.edge.worker.script.${ACC}.${w}`);

function goodWorld() {
  const mock = { readback: {} }, env = {}, listed = [];
  for (const [w, name] of Object.entries(WORKERS)) {
    const tok = `tok-${w}`;
    env[`T_${name}`] = tok;
    const base = `/accounts/${ACC}/workers/scripts/${w}`;
    mock[tok] = {
      [`/accounts/${ACC}/tokens/verify`]: ok({ id: `id-${w}`, status: "active" }),
      [`/accounts/${ACC}/workers/scripts`]: ok([{ id: w }]),
      [`/accounts/${ACC}/tokens/id-${w}`]: ok({ policies: scoped(w) }),
      [`${base}/deployments`]: ok({ deployments: [{ versions: [{ percentage: 100, version_id: `v-${w}` }] }] }),
      [`${base}/settings`]: ok({}),
      [`${base}/versions/v-${w}`]: ok({ metadata: { annotations: { "workers/tag": SHA } } }),
    };
    listed.push({ id: `id-${w}`, name, status: "active", policies: scoped(w) });
    mock.readback[`https://rb.test/${w}`] = [200, { sha: SHA }];
  }
  listed.push({ id: "id-shared", name: "old shared", status: "disabled", policies: policy(`com.cloudflare.api.account.${ACC}`) });
  env.T_CF_TOKEN_AUDIT = "tok-audit";
  mock["tok-audit"] = { [`/accounts/${ACC}/tokens?per_page=50&page=1`]: ok(listed), ["/user/tokens?per_page=50&page=1"]: ok([]) };
  const registry = { services: Object.fromEntries(Object.keys(WORKERS).map((w) => [w, { readback: { url: `https://rb.test/${w}`, path: "sha" } }])),
    manual_operations: { "cloudflare-dashboard-and-global-key": { owner_written_authorization: "fixture" } } };
  const inv = { rows: [{ path: "canon.yml" }], findings: [] };
  return { mock, env, registry, inv, listed };
}
function verdict(world) {
  const d = mkdtempSync(join(tmpdir(), "t1v-"));
  tmps.push(d);
  for (const [f, v] of [["mock.json", world.mock], ["reg.json", world.registry], ["inv.json", world.inv]]) writeFileSync(join(d, f), JSON.stringify(v));
  const env = Object.fromEntries(Object.entries(ENV).filter(([k]) => !k.startsWith("T_") && k !== "GITHUB_OUTPUT"));
  const r = spawnSync(PY, [VER, "--inventory", join(d, "inv.json"), "--registry", join(d, "reg.json"), "--account", ACC, "--mock", join(d, "mock.json")],
    { env: { ...env, ...world.env }, encoding: "utf8" });
  const state = (r.stdout.match(/^T1_EXCLUSIVITY=(\w+)$/m) || [])[1];
  const reasons = [...r.stdout.matchAll(/^T1_EXCLUSIVITY_REASON (\S+)$/gm)].map((m) => m[1]);
  assert.ok(state, `verdict printed no state: ${r.stderr}`);
  return { state, reasons, rc: r.status, out: r.stdout };
}

test("T1-V01 all conditions proven -> PROVEN, exit 0", () => {
  const v = verdict(goodWorld());
  assert.deepEqual([v.state, v.rc, v.reasons], ["PROVEN", 0, []], "[T1-V01] complete evidence yields PROVEN");
});

test("T1-V02 a shared token still configured and active -> NOT_PROVEN", () => {
  const w = goodWorld();
  w.env.T_CLOUDFLARE_API_TOKEN = "tok-shared";
  w.mock["tok-shared"] = { [`/accounts/${ACC}/tokens/verify`]: ok({ id: "id-shared", status: "active" }), [`/accounts/${ACC}/workers/scripts`]: ok(new Array(39).fill({ id: "x" })) };
  const v = verdict(w);
  assert.ok(v.state === "NOT_PROVEN" && v.reasons.some((r) => r.startsWith("S:CLOUDFLARE_API_TOKEN_status=active")), "[T1-V02] active shared token blocks PROVEN");
});

test("T1-V03 an over-scoped per-Worker token (reach 39, account-wide write) -> NOT_PROVEN", () => {
  const w = goodWorld();
  const t = w.mock["tok-zevanory"];
  t[`/accounts/${ACC}/workers/scripts`] = ok(Array.from({ length: 39 }, (_, i) => ({ id: i ? `w${i}` : "zevanory" })));
  t[`/accounts/${ACC}/tokens/id-zevanory`] = ok({ policies: policy(`com.cloudflare.api.account.${ACC}`) });
  const v = verdict(w);
  assert.ok(v.reasons.some((r) => r.startsWith("W:zevanory:CF_TOKEN_ZEVANORY_reach=39")), "[T1-V03] reach above 1 is not exclusivity");
  assert.ok(v.reasons.includes("W:zevanory:CF_TOKEN_ZEVANORY_write_scope_not_limited"), "[T1-V03b] account-wide write is not a proven limit");
});

test("T1-V04 policies not readable -> edit permission unproven", () => {
  const w = goodWorld();
  w.mock["tok-zevanory-sales-public"][`/accounts/${ACC}/tokens/id-zevanory-sales-public`] = [403, { success: false }];
  const v = verdict(w);
  assert.ok(v.state === "NOT_PROVEN" && v.reasons.includes("W:zevanory-sales-public:CF_TOKEN_SALES_edit_permission_unproven"), "[T1-V04] unreadable policies never count as edit proven");
});

test("T1-V05 the audit finds another active write token -> NOT_PROVEN", () => {
  const w = goodWorld();
  w.listed.push({ id: "id-rogue000", name: "forgotten", status: "active", policies: policy(`com.cloudflare.api.account.${ACC}`, "Workers Editor") });
  const v = verdict(w);
  assert.ok(v.reasons.includes("A:zevanory-public-router:write_tokens_other_than_CF_TOKEN_ROUTER=[id-rogue]"), "[T1-V05] any other active writer breaks exclusivity");
});

test("T1-V06 'not configured' without an audit is not proof of revocation", () => {
  const w = goodWorld();
  delete w.env.T_CF_TOKEN_AUDIT;
  const v = verdict(w);
  assert.ok(v.reasons.includes("S:CLOUDFLARE_API_TOKEN_not_configured_revocation_unproven"), "[T1-V06] not configured alone is never PROVEN");
  assert.ok(v.reasons.includes("A:CF_TOKEN_AUDIT_not_configured"), "[T1-V06b] the audit token is required");
});

test("T1-V07 inventory findings -> NOT_PROVEN", () => {
  const w = goodWorld();
  w.inv.findings = [{ code: "UNREGISTERED", path: "rogue.yml" }];
  const v = verdict(w);
  assert.ok(v.state === "NOT_PROVEN" && v.reasons.includes("I:inventory_findings=1"), "[T1-V07] an incomplete inventory blocks PROVEN");
});

test("T1-V08 Cloudflare tag and readback disagree -> NOT_PROVEN", () => {
  const w = goodWorld();
  w.mock.readback["https://rb.test/zevanory"] = [200, { sha: "b".repeat(40) }];
  const v = verdict(w);
  assert.ok(v.reasons.some((r) => r.startsWith("L:zevanory:sha_mismatch")), "[T1-V08] the live SHA must match by both sources");
});

test("T1-V09 a Worker with a single SHA source -> NOT_PROVEN", () => {
  const w = goodWorld();
  delete w.registry.services["zevanory-public-router"].readback;
  const v = verdict(w);
  assert.ok(v.reasons.includes("L:zevanory-public-router:single_sha_source_no_readback"), "[T1-V09] one source is not an independent verification");
});

test("T1-V10 a configured shared token that Cloudflare reports invalid is proven revoked", () => {
  const w = goodWorld();
  w.env.T_CLOUDFLARE_PUBLIC_OWNER_API_TOKEN = "tok-dead";
  w.mock["tok-dead"] = { [`/accounts/${ACC}/tokens/verify`]: [401, { success: false }], ["/user/tokens/verify"]: [401, { success: false }] };
  const v = verdict(w);
  assert.deepEqual([v.state, v.reasons], ["PROVEN", []], "[T1-V10] positive revocation evidence is accepted");
});

test("T1-V11 an API error is unknown, never a pass", () => {
  const w = goodWorld();
  w.mock["tok-zevanory-product-control-portable"][`/accounts/${ACC}/tokens/verify`] = [500, null];
  const v = verdict(w);
  assert.ok(v.reasons.includes("W:zevanory-product-control-portable:CF_TOKEN_PANEL_status=unknown"), "[T1-V11] unknown token state blocks PROVEN");
});

test("T1-V12 dashboard and Global API Key access must be registered with the owner's authorization", () => {
  const w = goodWorld();
  w.registry.manual_operations = {};
  const v = verdict(w);
  assert.deepEqual(v.reasons, ["M:cloudflare-dashboard-and-global-key_not_registered_with_owner_written_authorization"], "[T1-V12] unenumerable access must be registered");
});

test("T1-V13 a per-Worker token that sees another Worker (swapped target) -> NOT_PROVEN", () => {
  const w = goodWorld();
  w.mock["tok-zevanory"][`/accounts/${ACC}/workers/scripts`] = ok([{ id: "zevanory-sales-public" }]);
  const v = verdict(w);
  assert.ok(v.reasons.includes("W:zevanory:CF_TOKEN_ZEVANORY_reach=1_visible=zevanory-sales-public"), "[T1-V13] the token must reach its own Worker");
});
