# ZEVANORY dual pipeline

GitHub Actions remains the canonical merge gate for `gh-pages`. Reserve paths do not weaken branch protection.

## Cloudflare Workers Builds

Connect only `arbmsistone-lab/zevanory-public-mirror` to the existing ZEVANORY Worker. Production branch: `gh-pages`. Build command: `bash scripts/ci/cloudflare-build.sh`.

Keep automatic production builds disabled in normal operation. During a declared GitHub Actions outage, enable the reserve build only after confirming no canonical deployment is running. Use the exact candidate reconstruction and Wrangler deployment semantics from `.github/workflows/central-production-deploy.yml`.

After deployment, verify the canonical release endpoint reports the expected commit SHA. On mismatch, stop promotion and roll back to the previously known-good Worker version with Wrangler. Never overwrite Worker secrets from CI. Disable the reserve production trigger before returning to the canonical GitHub deployment path.

## CircleCI

The normal workflow runs tests. The financial sandbox proof is disabled by default and requires `run_sandbox_proof=true`, branch `gh-pages`, and manual approval.

Store only as protected/restricted CircleCI variables or Context values: `MERCADOPAGO_TEST_PUBLIC_KEY`, `MERCADOPAGO_TEST_ACCESS_TOKEN`, `SANDBOX_IDENTITY_MANIFEST`, `SANDBOX_INBOX_READ_TOKEN`, and `CERTIFICATION_E2E_TOKEN`.

If CircleCI reserve deployment is later enabled, create a dedicated least-privilege Cloudflare token. Never reuse or extract GitHub Actions secrets.

## Safety

Never change `gh-pages` protection for an outage. Never run the financial proof automatically on push. Never expose credentials in logs, files, artifacts, or chat. Never run two production deploy pipelines concurrently. GitHub remains the source repository.
