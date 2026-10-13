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
const read = (name) => readFileSync(new URL(name, wfDir), "utf8");
const workflows = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

// A command that changes a Worker in production: code deploy/rollback/version deploy,
// secret writes (each creates and deploys a new version), or mutating Workers API calls.
const PUBLISH = [
  /npx(?: --yes)? wrangler(?:@[\d.]+)? (?:deploy|rollback|versions deploy)\b(?![^\n]*--dry-run)/,
  /npx(?: --yes)? wrangler(?:@[\d.]+)? secret (?:put|delete|bulk)\b/,
  /-X (?:POST|PUT|PATCH|DELETE)\b[^\n]*workers\/scripts|workers\/scripts[^\n]*-X (?:POST|PUT|PATCH|DELETE)\b/,
  /node [^\n]*cloudflare-authoritative-repair\.mjs/,
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

test("the scheduled panel reconciler is guarded and never answers pin pushes", () => {
  const t2 = read("t2-exact-control-worker-promotion.yml");
  assert.doesNotMatch(t2.split(/^permissions:|^concurrency:|^jobs:/m)[0], /^\s+push:/m, "pin pushes belong to the canonical publisher only");
  assert.match(t2, /ZPC_ROLLBACK_HOLD/, "a deliberate rollback must not be undone by the reconciler");
  assert.match(t2, /merge-base --is-ancestor "\$LIVE_SHA" "\$SOURCE_SHA"/, "reconciler only moves forward from live");
});

test("central and sales promotions pass the pre-promotion guard", () => {
  const central = read("central-production-deploy.yml");
  assert.match(central, /scripts\/deploy\/promotion_guard\.py --service zevanory/);
  const sales = read("zevanory-sales-public-release.yml");
  assert.match(sales, /scripts\/deploy\/promotion_guard\.py --service zevanory-sales-public/);
  assert.match(sales, /--tag="\$GITHUB_SHA"/, "sales versions are tagged with their source SHA");
});

test("sales pages built from sales-public are released only by the canonical publisher", () => {
  const release = read("zevanory-sales-public-release.yml");
  for (const p of ["sales-public/**", "wrangler.sales.toml", "sales-worker.mjs"]) {
    assert.ok(release.includes(`- "${p}"`), `release must trigger on ${p}`);
  }
});
