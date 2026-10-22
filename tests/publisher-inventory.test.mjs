// Plan 3.1, T1: exactly one serialized publisher per production Worker.
// Fails when a workflow gains a publish command without being registered in ops/publishers.json,
// when a registered publisher leaves its service's single concurrency group, when a retired or
// validation-only workflow can publish again, or when the panel repository can publish.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const wfDir = new URL(".github/workflows/", root);
const registry = JSON.parse(readFileSync(new URL("ops/publishers.json", root), "utf8"));
const read = (name) => readFileSync(new URL(name, wfDir), "utf8").replace(/\r\n/g, "\n");
const workflows = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

// A command that changes a Worker in production: code deploy/rollback/version deploy,
// secret writes (each creates and deploys a new version), or mutating Workers API calls.
const PUBLISH = [
  /npx(?: --yes)? wrangler(?:@[\d.]+)? (?:deploy|rollback|versions deploy)\b(?![^\n]*--dry-run)/,
  /npx(?: --yes)? wrangler(?:@[\d.]+)? secret (?:put|delete|bulk)\b/,
  /-X (?:POST|PUT|PATCH|DELETE)\b[^\n]*workers\/scripts|workers\/scripts[^\n]*-X (?:POST|PUT|PATCH|DELETE)\b/,
  /node [^\n]*cloudflare-authoritative-repair\.mjs/,
  // Config writer wrapping `wrangler versions secret bulk|delete` + `versions deploy` (T3).
  /worker_secret_rotate\.py[^\n]*--apply/,
];
export const publishes = (text) => PUBLISH.some((re) => re.test(text));

// Top-level `concurrency:` block (not job-level), as written in these workflows.
export function topLevelGroup(text) {
  const m = text.match(/^concurrency:\s*\n\s+group:\s*(.+)$/m) || text.match(/^concurrency:\s*([^\n{]+)$/m);
  return m ? m[1].trim().replace(/^(["'])(.*)\1$/, "$2") : null;
}
const cancelInProgress = (text) => /^concurrency:[\s\S]*?cancel-in-progress:\s*true/m.test(text.split(/^jobs:/m)[0]);

const services = registry.services;
const owner = new Map();
for (const [svc, s] of Object.entries(services)) {
  for (const wf of [s.canonical, ...(s.config_publishers || []), ...(s.pending_owner_authorization || [])]) {
    assert.ok(!owner.has(wf), `${wf} registered for two services`);
    owner.set(wf, { svc, group: s.group, pending: (s.pending_owner_authorization || []).includes(wf) });
  }
}
for (const wf of Object.values(registry.isolated || {})) owner.set(wf, { svc: "isolated", group: null });
for (const wf of Object.keys(registry.unserialized_known || {})) if (!owner.has(wf)) owner.set(wf, { svc: "unserialized", group: null, pending: true });

test("every workflow that can change a production Worker is registered", () => {
  const unregistered = workflows.filter((f) => publishes(read(f)) && !owner.has(f));
  assert.deepEqual(unregistered, [], "register in ops/publishers.json or remove the publish command");
});

test("registered publishers exist and still publish", () => {
  for (const wf of owner.keys()) {
    assert.ok(existsSync(new URL(wf, wfDir)), `${wf} missing`);
    assert.ok(publishes(read(wf)), `${wf} is registered but no longer publishes: move it out of the registry`);
  }
});

test("each service has one canonical publisher and every publisher of it shares the service group", () => {
  for (const [svc, s] of Object.entries(services)) {
    const members = [s.canonical, ...(s.config_publishers || [])];
    for (const wf of members) {
      const text = read(wf);
      const group = topLevelGroup(text) || "";
      const hasPr = /^\s+pull_request(?:_target)?:/m.test(text.split(/^permissions:|^concurrency:|^jobs:/m)[0]) || /^on:\s*\[?[^\n]*pull_request/m.test(text);
      if (s.t1_unchanged) {
        assert.equal(group, s.group, `${wf} must keep its group ${s.group}`);
        assert.ok(String(s.t1_unchanged).length > 40, "an unchanged service must state its residual risk");
      } else if (hasPr) {
        // PR validation runs must never share (and so never replace) the production queue.
        assert.ok(group.includes(`'${s.group}'`) && group.includes("github.event_name == 'pull_request'"), `${wf}: PR runs must be separated from group ${s.group} (got ${group})`);
      } else {
        assert.equal(group, s.group, `${wf} must run in concurrency group ${s.group} (service ${svc})`);
      }
      assert.equal(cancelInProgress(text), false, `${wf} must not cancel an in-progress promotion`);
      // Proven on this repository by t1-queue-max-probe.yml (3 contenders, 0 discarded, no overlap).
      if (!s.t1_unchanged) assert.match(text.split(/^jobs:/m)[0], /^concurrency:[\s\S]*?\n  queue: max\n/m, `${wf} must keep every queued promotion (queue: max); the guard skips the stale ones`);
    }
  }
});

test("financial publishers pending owner authorization are reported, never silently accepted", () => {
  const pending = [...owner.entries()].filter(([, v]) => v.pending).map(([k]) => k);
  // Listed explicitly so the T1 report shows them as NOT YET SERIALIZED (owner rule: no change to
  // payment workflows without written authorization).
  assert.deepEqual(pending.sort(), ["financial-e2e-stripe.yml", "mercadopago-exact-sha-recovery.yml", "mercadopago-production-token-rotate.yml", "whatsapp-broker-protocol-v2.yml"]);
  assert.deepEqual(Object.keys(registry.unserialized_known).sort(), pending.sort(), "every unserialized publisher carries a written reason");
});

test("retired and validation-only workflows cannot publish", () => {
  for (const wf of [...registry.retired, ...registry.validation_only]) {
    if (!existsSync(new URL(wf, wfDir))) continue;
    const text = read(wf);
    assert.equal(publishes(text), false, `${wf} must not contain a publish command`);
    assert.doesNotMatch(text, /secrets\.CLOUDFLARE/, `${wf} must not receive Cloudflare credentials`);
  }
});

// Code publication (not config): deploy/rollback/version deploy or the panel deploy script.
const CODE_PUBLISH = [PUBLISH[0], PUBLISH[3]];
const publishesCode = (text) => CODE_PUBLISH.some((re) => re.test(text));

test("requesters never publish and only dispatch their service's canonical publisher", () => {
  for (const [svc, s] of Object.entries(services)) {
    for (const wf of s.requesters || []) {
      const text = read(wf);
      assert.equal(publishes(text), false, `${wf} is a requester of ${svc}: it must not contain any publish command`);
      assert.doesNotMatch(text, /npm run build|setup-node/, `${wf} must not build an artifact`);
      assert.match(text, new RegExp(`gh workflow run ${s.canonical.replace(/\./g, "\\.")}\\b`), `${wf} must request ${s.canonical}`);
      assert.match(text, /-f skip_if_live=true/, `${wf} requests must be idempotent`);
      assert.doesNotMatch(text, /allow_backwards/, `${wf} must never request a rollback`);
      assert.doesNotMatch(text, /secrets\.CLOUDFLARE/, `${wf} must hold no Cloudflare credential`);
      assert.match(text.split(/^jobs:/m)[0], /^permissions:\s*\n\s+contents: read\n\s+actions: write/m, `${wf} gets only actions: write to dispatch`);
      assert.ok(!owner.has(wf), `${wf} must not also be registered as a publisher`);
      assert.ok(s.requester_notes?.[wf], `${wf} needs a written role`);
    }
  }
});

test("the panel has exactly one code publisher and it certifies by both sources", () => {
  const codePublishers = workflows.filter((f) => /zevanory-product-control-portable|cloudflare-authoritative-repair|cf-worker\/wrangler/.test(read(f)) && publishesCode(read(f)));
  assert.deepEqual(codePublishers, ["zpc-control-worker-deploy.yml"], "only the canonical workflow may publish panel code");
  const canonical = read("zpc-control-worker-deploy.yml");
  assert.match(canonical, /promotion_guard\.py --service zevanory-product-control-portable[\s\S]*--repo zpc/, "forward path uses the shared guard");
  assert.match(canonical, /promotion_guard\.py --verify-promoted --service zevanory-product-control-portable/, "post-promotion by Cloudflare tag + version.json");
  assert.match(canonical, /SOURCE_WITHOUT_VERSION_TAG/, "an uncertifiable forward promotion is refused before publishing");
  assert.match(canonical, /skip_if_live/, "reconciler requests are no-ops when already live");
  assert.match(canonical, /ACTOR" != "\$REPO_OWNER"/, "the documented rollback exception stays owner-dispatched");
  const t2 = read("t2-exact-control-worker-promotion.yml");
  assert.doesNotMatch(t2.split(/^permissions:|^concurrency:|^jobs:/m)[0], /^\s+push:/m, "pin pushes belong to the canonical publisher only");
  assert.match(t2, /ZPC_ROLLBACK_HOLD/, "a deliberate rollback must not be undone by the reconciler");
  assert.match(t2, /promotion_guard\.py --service zevanory-product-control-portable[\s\S]*--repo \/tmp\/zpc-source/, "requests only when the shared guard says forward_of_live");
  assert.ok(services["zevanory-product-control-portable"].exceptions?.rollback, "the rollback exception is written down");
});

test("central and sales promotions pass the pre-promotion guard", () => {
  const central = read("central-production-deploy.yml");
  assert.match(central, /scripts\/deploy\/promotion_guard\.py --service zevanory/);
  const sales = read("zevanory-sales-public-release.yml");
  assert.match(sales, /scripts\/deploy\/promotion_guard\.py --service zevanory-sales-public/);
  assert.match(sales, /--tag="\$GITHUB_SHA"/, "sales versions are tagged with their source SHA");
  // Post-promotion: the effective version must be the candidate (Cloudflare tag + readback).
  assert.match(central, /promotion_guard\.py --verify-promoted --unproven-exit 0 --service zevanory /);
  assert.match(sales, /promotion_guard\.py --verify-promoted --unproven-exit 0 --service zevanory-sales-public /);
  assert.doesNotMatch(read("zevanory-sales-public-release.yml"), /-X DELETE[^\n]*workers\/scripts\/\$SCRIPT_NAME"/, "the production sales script is never deleted");
});

test("an observability gap (NAO_COMPROVADO) never triggers automatic rollback; positive evidence (FAIL) always does", () => {
  const steps = (text) => text.split(/\n      - name: /).slice(1).map((b) => ({ name: b.split("\n")[0], body: b }));
  for (const [wf, rollbackName, verifyStep, stateRef] of [
    ["central-production-deploy.yml", "Automatic rollback after failed post-deploy smoke", "Post-promotion effective version (T1)", "steps.postpromo.outputs.state"],
    ["zevanory-sales-public-release.yml", "Roll back canonical deployment on failed readback", "Verify canonical production readback", "steps.readback.outputs.state"],
  ]) {
    const list = steps(read(wf));
    const iVerify = list.findIndex((s) => s.name === verifyStep);
    const iRollback = list.findIndex((s) => s.name === rollbackName);
    const iGate = list.findIndex((s) => s.name.startsWith("Certification gate (T1"));
    assert.ok(iVerify >= 0 && iRollback > iVerify && iGate > iRollback, `${wf}: verify -> rollback -> certification gate`);
    // FAIL exits 1 (step fails); NAO_COMPROVADO exits 0 (--unproven-exit 0) so the rollback condition stays false.
    assert.match(list[iVerify].body, /--verify-promoted --unproven-exit 0/);
    assert.match(list[iRollback].body, /if: failure\(\)|steps\.readback\.outcome != 'success'/, `${wf}: rollback keyed to step failure (FAIL)`);
    assert.match(list[iGate].body, new RegExp(`if: always\\(\\) && [^\\n]*${stateRef.replace(/\./g, "\\.")}`), `${wf}: gate reads the post-promotion state`);
    assert.match(list[iGate].body, /exit 1/, `${wf}: an uncertified release fails the run`);
    assert.doesNotMatch(list[iGate].body, /wrangler|-X POST|rollback --name/, `${wf}: the gate never changes production`);
  }
  assert.match(read("zevanory-sales-public-release.yml"), /name: Certify public release\n        if: [^\n]*steps\.readback\.outputs\.state == 'PASS'/, "sales certifies only on PASS");
  const recheck = read("t1-publisher-guard.yml").split(/\n  post-promotion-recheck:/)[1] || "";
  assert.match(recheck, /--verify-promoted/, "independent re-check exists");
  assert.equal(publishes(recheck), false, "the re-check never publishes");
});

test("sales pages built from sales-public are released only by the canonical publisher", () => {
  const release = read("zevanory-sales-public-release.yml");
  for (const p of ["sales-public/**", "wrangler.sales.toml", "sales-worker.mjs"]) {
    assert.ok(release.includes(`- "${p}"`), `release must trigger on ${p}`);
  }
});

test("automatic replays never republish after a post-publish failure nor reuse a stale guard", () => {
  // Names of every registered production publisher (canonical + config + pending).
  const publisherNames = new Map();
  for (const wf of owner.keys()) {
    if (!existsSync(new URL(wf, wfDir))) continue;
    const m = read(wf).match(/^name:\s*["']?(.+?)["']?\s*$/m);
    if (m) publisherNames.set(m[1], wf);
  }
  for (const wf of workflows) {
    const text = read(wf);
    if (!/rerun-failed-jobs|\/rerun\b/.test(text)) continue;
    const watched = [...text.matchAll(/^\s+-\s*["']([^"']+)["']\s*$/gm)].map((m) => m[1]).filter((n) => publisherNames.has(n));
    for (const name of watched) {
      // Each watched publisher must have its own branch that refuses replays after publishing/rollback
      // and replays with a FULL rerun (fresh guard), never rerun-failed-jobs.
      const branch = text.split(`if [ "$NAME" = "${name}" ]; then`)[1];
      assert.ok(branch, `${wf}: ${name} (${publisherNames.get(name)}) needs a dedicated replay branch`);
      const body = branch.split(/\n\s+fi\n\s+sleep 90\n\s+curl[^\n]*rerun-failed-jobs/)[0];
      assert.match(body, /AUTO_RERUN_REFUSED/, `${wf}: ${name} must refuse replay after publishing or rollback`);
      assert.match(body, /python3 scripts\/deploy\/auto_rerun_decision\.py/, `${wf}: ${name} replay needs the fail-closed decision (positive proof + revalidation)`);
      assert.match(body, /if \[ "\$rc" = "10" \]/, `${wf}: ${name} replays only on the explicit pre-publish verdict`);
      assert.match(body, /\$api\/rerun"/, `${wf}: ${name} replay must rerun ALL jobs (fresh guard)`);
      assert.doesNotMatch(body, /rerun-failed-jobs/, `${wf}: ${name} must never reuse the attempt-1 guard`);
    }
  }
});
