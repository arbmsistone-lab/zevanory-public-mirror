# ZEVANORY dual pipeline

GitHub Actions remains the canonical merge gate for `gh-pages`. Reserve paths do not weaken branch protection.

## Cloudflare Workers Builds

Connect only `arbmsistone-lab/zevanory-public-mirror` to the existing ZEVANORY Worker. Production branch: `gh-pages`. Build command: `bash scripts/ci/cloudflare-build.sh`. Deploy command: `npx wrangler deploy --strict --keep-vars --config wrangler.central-fix.jsonc`. Preview builds: off. After a reserve deploy run `bash scripts/ci/cloudflare-post-deploy-verify.sh <sha>`; it prints the rollback command on mismatch.

The build script reproduces the candidate reconstruction of `central-production-deploy.yml` (static base from `83620c6`, `materialize-control-plane`, `write-build-info`, `prepare-central-candidate`), runs the WhatsApp/voice/sandbox gates, refuses candidates with sales enabled or a different account, and ends with the exact Wrangler dry-run.

Keep automatic production builds disabled in normal operation. During a declared GitHub Actions outage, enable the reserve build only after confirming no canonical deployment is running. Use the exact candidate reconstruction and Wrangler deployment semantics from `.github/workflows/central-production-deploy.yml`.

After deployment, verify the canonical release endpoint reports the expected commit SHA. On mismatch, stop promotion and roll back to the previously known-good Worker version with Wrangler. Never overwrite Worker secrets from CI. Disable the reserve production trigger before returning to the canonical GitHub deployment path.

## CircleCI

The normal workflow runs tests. The financial sandbox proof is disabled by default and requires `run_sandbox_proof=true`, branch `gh-pages`, and manual approval.

Store only as protected/restricted CircleCI variables or Context values: `MERCADOPAGO_TEST_PUBLIC_KEY`, `MERCADOPAGO_TEST_ACCESS_TOKEN`, `SANDBOX_IDENTITY_MANIFEST`, `SANDBOX_INBOX_READ_TOKEN`, and `CERTIFICATION_E2E_TOKEN`.

If CircleCI reserve deployment is later enabled, create a dedicated least-privilege Cloudflare token. Never reuse or extract GitHub Actions secrets.

## Safety

Never change `gh-pages` protection for an outage. Never run the financial proof automatically on push. Never expose credentials in logs, files, artifacts, or chat. Never run two production deploy pipelines concurrently. GitHub remains the source repository.

## Reserve trigger (Cloudflare Workers Builds)

Workers Builds is connected to this repository (production branch `gh-pages`) with build watch path **only** `ops/RESERVE_DEPLOY`. Normal merges never trigger it.

To publish through the reserve during a GitHub Actions outage: create or edit `ops/RESERVE_DEPLOY` (one line: UTC timestamp and reason) on `gh-pages`. Workers Builds then runs `scripts/ci/cloudflare-build.sh` (gates, exact candidate, guards, dry-run) and the deploy command. Immediately after, run `bash scripts/ci/cloudflare-post-deploy-verify.sh <sha>`; on mismatch run the rollback it prints.

Never add or edit `ops/RESERVE_DEPLOY` in the same change as a normal release: that would run the reserve deploy concurrently with the central pipeline.
