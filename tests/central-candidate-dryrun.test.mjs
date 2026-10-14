import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wf = readFileSync(new URL("../.github/workflows/central-candidate-dryrun.yml", import.meta.url), "utf8");
const canonical = readFileSync(new URL("../.github/workflows/central-production-deploy.yml", import.meta.url), "utf8");
const triggerPaths = [...wf.slice(wf.indexOf("paths:"), wf.indexOf("workflow_dispatch:")).matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
const covered = (file) => triggerPaths.some((p) => (p.endsWith("/**") ? file.startsWith(p.slice(0, -3) + "/") : p === file));

test("every input of the central build triggers the pre-merge dry-run", () => {
  for (const f of ["worker/cloudflare-worker.compat.mjs", "worker/live-recovered/control-plane-vnext.js", "worker/vendor/x.mjs",
    "scripts/deploy/prepare-central-candidate.py", "scripts/deploy/copy-brand-export.py", "scripts/deploy/write-build-info.py",
    "scripts/deploy/materialize-control-plane.mjs", "admin.css", "assets/brand/export/logo.png", "assets/brand/logo-original.svg",
    "sales-public/brand/export/a.png", ".github/workflows/central-production-deploy.yml"]) assert.ok(covered(f), "not covered: " + f);
});
test("it reconstructs exactly what the canonical publisher reconstructs", () => {
  for (const step of ["git archive 83620c680958d726fc4b0fd16e2574cdcc362a6d public", "node scripts/deploy/materialize-control-plane.mjs",
    "python3 scripts/deploy/write-build-info.py", "git show 83620c680958d726fc4b0fd16e2574cdcc362a6d:wrangler.jsonc > wrangler.central-fix.jsonc",
    "python3 scripts/deploy/prepare-central-candidate.py", "python3 scripts/deploy/copy-brand-export.py"]) {
    assert.ok(canonical.includes(step), "canonical changed: " + step); assert.ok(wf.includes(step), "dry-run missing: " + step);
  }
  const ver = (t) => /npx --yes wrangler@([\d.]+) deploy --dry-run --strict/.exec(t)?.[1];
  assert.equal(ver(wf), ver(canonical), "same wrangler version as the publisher");
});
test("least privilege: read-only token, no secrets, no authentication, no real deploy or writes", () => {
  assert.match(wf, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(wf, /secrets\.|CLOUDFLARE_API_TOKEN|wrangler(@[\d.]+)? login|storage\/kv|kv key put|curl /);
  for (const line of wf.split("\n").filter((l) => /wrangler(@[\d.]+)? (deploy|rollback|versions)/.test(l) && !l.trim().startsWith("#"))) assert.match(line, /--dry-run/);
});
test("cron problems and an empty build fail the job", () => {
  for (const s of ["candidate crons differ from CENTRAL_CRONS", "duplicate cron", "cron must have 5 fields", "len(crons) <= 5", 'test -n "$bundle"', 'test "$bytes" -gt 100000', "set -euo pipefail"]) assert.ok(wf.includes(s), s);
});
