# PR #946, round 7 re-audit (M-1): evidence

`r7-clean-bundle-evidence.sh` runs the real `scripts/deploy/clean_bundle.py` of commit `15a8c73d14be890536eaf6a6a55eb7812623c668`, with `npm ci` of the anchored lockfile `scripts/deploy/wrangler-pin/package-lock.json` and the real wrangler 4.143.0. Its output is `r7-clean-bundle-evidence.out`, run on Linux, Node 22, Python 3.13. Scratch paths are shown as `$S`.

| Step | What it shows |
|---|---|
| 1–4 | Sales and central are each built twice, in different directories. The second build, `--verify`, is byte-for-byte `MATCH`. |
| 5 | The round-6 flow (full checkout, `node` materialize, same wrangler) gives identical bytes: the sales bundle, the central bundle and the central `public/`. The clean build changes provenance, not output. |
| 6 | A test-time mutation of `worker/sales-public-worker.mjs` in the build workspace yields a bundle that carries it. The deploy-side rebuild refuses that artifact: `MISMATCH`, exit 1. |
| 7 | A commit with `node_modules/.bin/wrangler` (stub) and `.npmrc` gets `CLEAN_BUNDLE=REFUSED`. The stub never runs. |

The unit tests are `tests/clean-bundle.test.mjs` (stub bundler) and G15/G11 in `tests/legal-publish-gate.test.mjs` (protected check).
