# Secret scan baseline (public mirror)

Reviewed 2026-10-27 (T5, secret-scan hardening). This file records why each
fingerprint added to `.gitleaksignore` in T5 is not a secret. It contains file,
line, rule, commit and type only. **No secret values are recorded here.**

## Method

- Scanner: gitleaks **v8.30.1** (the version pinned in
  `.github/workflows/secret-history-scan.yml`), run as
  `gitleaks git --log-opts=--all --redact=100` on a fresh full clone of
  `arbmsistone-lab/zevanory-public-mirror` at gh-pages `b7671272` (all 991
  remote branches, 4377 commits scanned), with the 47 fingerprints reviewed on
  2026-10-02 already applied.
- Result before T5: 43 findings (41 `generic-api-key`, 2 `curl-auth-user`) in
  22 commits. Result with the T5 entries: **0 findings, exit 0**.
- Each finding was classified by matching the flagged line against a structural
  pattern (for example `re_test_<digits>`, `evt_*`, a 40-hex SHA inside an action
  pin), printing only the pattern match, never the value.
- Entries are exact `commit:file:rule:line` fingerprints. There is no rule-wide,
  path-wide or regex suppression, so a new secret in any file, including the
  files listed below, still fails the scan.
- External confirmation: the same 43 locations were independently classified as
  false positives or fixtures in the audit v12b (secret history section), and
  `tests/helpers/order-lookup-probe.mjs` was confirmed synthetic by the external
  auditor (Sol, ORDEM 293).

## Classes

| Class | Type | Why it is not a secret |
|---|---|---|
| C1 | Env-var reference | `curl -u "$STRIPE_SECRET_KEY:"` names a GitHub Actions secret. The file holds no value. |
| C2 | IndexNow key (public by design) | The IndexNow protocol requires serving this key at `https://<host>/<key>.txt`, and the workflow sends it as `keyLocation`. It grants no access. No rotation needed. The same key also appears in `indexnow-resubmit.yml`, `worker/sales-public-worker.mjs` and `worker/multichannel-autonomy.mjs`; those were already covered by the 2026-10-02 entries. |
| C3 | Resend API key fixture | Literal of the form `re_test_<digits>`, used as a placeholder `RESEND_API_KEY` in unit and integration tests. |
| C4 | Webhook/HMAC test secret | Hyphenated words followed by the sequence `0123456789abcdef`. Used to prove that signatures are accepted or rejected. |
| C5 | TikTok client secret fixture | Literal of the form `secret-<digits>`. |
| C6 | Mercado Pago canary | `MP-PROD-CANARY-<sequential digits>`. The test asserts that this canary never reaches the logs. |
| C7 | Test event id | An `evt_*` PSP event identifier, used as a ledger claim key in a Postgres integration test. |
| C8 | GitHub Action commit SHA pin | A 40-hex commit SHA of a pinned action (`tests/workflow-node24-pins.test.mjs:17`, PR #948 head commit `84cab02c`). |

## Fingerprints (gitleaks)

| Class | File | Line | Rule | Commit | Type | Fingerprint |
|---|---|---|---|---|---|---|
| C1 | `.github/workflows/financial-e2e-stripe.yml` | 86 | `curl-auth-user` | `2ab3f9bb` | env-var reference | `2ab3f9bb2ac9044625b74b0120d9432508200b05:.github/workflows/financial-e2e-stripe.yml:curl-auth-user:86` |
| C1 | `.github/workflows/financial-e2e-stripe.yml` | 86 | `curl-auth-user` | `4b73b1ee` | env-var reference | `4b73b1ee4669b1c95a9b18f1b724cb4d82549d11:.github/workflows/financial-e2e-stripe.yml:curl-auth-user:86` |
| C2 | `.github/workflows/indexnow-submit.yml` | 21 | `generic-api-key` | `2d1881df` | IndexNow key (public by design) | `2d1881dfe51a1004fe4888191ff4cbc51b9ee138:.github/workflows/indexnow-submit.yml:generic-api-key:21` |
| C2 | `.github/workflows/indexnow-submit.yml` | 21 | `generic-api-key` | `fbeec343` | IndexNow key (public by design) | `fbeec343292e9c17a6084e672bc41defb7b8a28d:.github/workflows/indexnow-submit.yml:generic-api-key:21` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 39 | `generic-api-key` | `36f1dfa8` | Resend API key fixture | `36f1dfa8a941b24f1d52d8188f0fe33ca0a649dd:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:39` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 39 | `generic-api-key` | `4d364561` | Resend API key fixture | `4d364561a5206640daad235d2512a5dbcc0b8405:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:39` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 39 | `generic-api-key` | `c6089cd7` | Resend API key fixture | `c6089cd77e0753d23cd5f83f268e877fe24f1f61:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:39` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 53 | `generic-api-key` | `36f1dfa8` | Resend API key fixture | `36f1dfa8a941b24f1d52d8188f0fe33ca0a649dd:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:53` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 53 | `generic-api-key` | `4d364561` | Resend API key fixture | `4d364561a5206640daad235d2512a5dbcc0b8405:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:53` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 53 | `generic-api-key` | `c6089cd7` | Resend API key fixture | `c6089cd77e0753d23cd5f83f268e877fe24f1f61:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:53` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 111 | `generic-api-key` | `4d364561` | Resend API key fixture | `4d364561a5206640daad235d2512a5dbcc0b8405:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:111` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 111 | `generic-api-key` | `c6089cd7` | Resend API key fixture | `c6089cd77e0753d23cd5f83f268e877fe24f1f61:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:111` |
| C3 | `tests/lead-magnet.test.mjs` | 72 | `generic-api-key` | `4d364561` | Resend API key fixture | `4d364561a5206640daad235d2512a5dbcc0b8405:tests/lead-magnet.test.mjs:generic-api-key:72` |
| C3 | `tests/lead-magnet.test.mjs` | 72 | `generic-api-key` | `c6089cd7` | Resend API key fixture | `c6089cd77e0753d23cd5f83f268e877fe24f1f61:tests/lead-magnet.test.mjs:generic-api-key:72` |
| C3 | `tests/lead-magnet.test.mjs` | 223 | `generic-api-key` | `4d364561` | Resend API key fixture | `4d364561a5206640daad235d2512a5dbcc0b8405:tests/lead-magnet.test.mjs:generic-api-key:223` |
| C3 | `tests/lead-magnet.test.mjs` | 223 | `generic-api-key` | `c6089cd7` | Resend API key fixture | `c6089cd77e0753d23cd5f83f268e877fe24f1f61:tests/lead-magnet.test.mjs:generic-api-key:223` |
| C3 | `tests/p09-nurture-sequence.test.mjs` | 143 | `generic-api-key` | `79261985` | Resend API key fixture | `79261985feed396f1c6bd30c4fd57c5e2f2df439:tests/p09-nurture-sequence.test.mjs:generic-api-key:143` |
| C3 | `tests/p09-nurture-sequence.test.mjs` | 143 | `generic-api-key` | `e9c4cc07` | Resend API key fixture | `e9c4cc0717637d402f3919b4ca6c61e4610dff4d:tests/p09-nurture-sequence.test.mjs:generic-api-key:143` |
| C4 | `tests/helpers/support-drain-scheduled-probe.mjs` | 9 | `generic-api-key` | `d6ff5f5f` | webhook/HMAC test secret | `d6ff5f5f68b10df8d1e720071527f64cc8058525:tests/helpers/support-drain-scheduled-probe.mjs:generic-api-key:9` |
| C4 | `tests/helpers/support-drain-scheduled-probe.mjs` | 12 | `generic-api-key` | `36f4e2d6` | webhook/HMAC test secret | `36f4e2d6b1d7bb3b272ad8e57ef1276a3e08506b:tests/helpers/support-drain-scheduled-probe.mjs:generic-api-key:12` |
| C4 | `tests/integration/support-outbox-postgres.test.mjs` | 77 | `generic-api-key` | `7ab8de28` | webhook/HMAC test secret | `7ab8de28bc90ca40c1d2c83255ecb6dcf44fb52a:tests/integration/support-outbox-postgres.test.mjs:generic-api-key:77` |
| C4 | `tests/integration/support-outbox-postgres.test.mjs` | 77 | `generic-api-key` | `becd10f5` | webhook/HMAC test secret | `becd10f5019cab167f35f5eebe1a98f246f441a7:tests/integration/support-outbox-postgres.test.mjs:generic-api-key:77` |
| C4 | `tests/support-email-forward.test.mjs` | 643 | `generic-api-key` | `d6ff5f5f` | webhook/HMAC test secret | `d6ff5f5f68b10df8d1e720071527f64cc8058525:tests/support-email-forward.test.mjs:generic-api-key:643` |
| C4 | `tests/support-email-forward.test.mjs` | 651 | `generic-api-key` | `88372c53` | webhook/HMAC test secret | `88372c53e4646f4b5ca1936b0828c191fd32de22:tests/support-email-forward.test.mjs:generic-api-key:651` |
| C4 | `tests/support-email-forward.test.mjs` | 671 | `generic-api-key` | `36f4e2d6` | webhook/HMAC test secret | `36f4e2d6b1d7bb3b272ad8e57ef1276a3e08506b:tests/support-email-forward.test.mjs:generic-api-key:671` |
| C4 | `tests/support-email-forward.test.mjs` | 671 | `generic-api-key` | `979c1296` | webhook/HMAC test secret | `979c129657cd7e465baefa6fab78545affa3a1b5:tests/support-email-forward.test.mjs:generic-api-key:671` |
| C5 | `tests/owner-oauth-tiktok.test.mjs` | 15 | `generic-api-key` | `0936186d` | TikTok client secret fixture | `0936186df774fcf736a5a1381daff32e523886e3:tests/owner-oauth-tiktok.test.mjs:generic-api-key:15` |
| C5 | `tests/owner-oauth-tiktok.test.mjs` | 15 | `generic-api-key` | `dc96670b` | TikTok client secret fixture | `dc96670b84cd591b9f6129e9f3ac62662aa59e80:tests/owner-oauth-tiktok.test.mjs:generic-api-key:15` |
| C5 | `tests/short-crosspost.test.mjs` | 11 | `generic-api-key` | `0936186d` | TikTok client secret fixture | `0936186df774fcf736a5a1381daff32e523886e3:tests/short-crosspost.test.mjs:generic-api-key:11` |
| C5 | `tests/short-crosspost.test.mjs` | 11 | `generic-api-key` | `dc96670b` | TikTok client secret fixture | `dc96670b84cd591b9f6129e9f3ac62662aa59e80:tests/short-crosspost.test.mjs:generic-api-key:11` |
| C6 | `tests/test_mp_rotation_workflow.py` | 405 | `generic-api-key` | `f47b1f42` | Mercado Pago canary | `f47b1f42bf900869a85749dbec572001198e3f74:tests/test_mp_rotation_workflow.py:generic-api-key:405` |
| C6 | `tests/test_mp_rotation_workflow.py` | 405 | `generic-api-key` | `f59b28ef` | Mercado Pago canary | `f59b28ef58a700fdd973ddccae77bda26789248a:tests/test_mp_rotation_workflow.py:generic-api-key:405` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 47 | `generic-api-key` | `191fa91f` | test event id | `191fa91fc019cb7f23490099e552be6905c2bddd:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:47` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 47 | `generic-api-key` | `2fa5ea9c` | test event id | `2fa5ea9c7d9ae621e939f99a50b490d35679a621:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:47` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 54 | `generic-api-key` | `191fa91f` | test event id | `191fa91fc019cb7f23490099e552be6905c2bddd:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:54` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 54 | `generic-api-key` | `2fa5ea9c` | test event id | `2fa5ea9c7d9ae621e939f99a50b490d35679a621:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:54` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 90 | `generic-api-key` | `191fa91f` | test event id | `191fa91fc019cb7f23490099e552be6905c2bddd:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:90` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 90 | `generic-api-key` | `2fa5ea9c` | test event id | `2fa5ea9c7d9ae621e939f99a50b490d35679a621:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:90` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 92 | `generic-api-key` | `191fa91f` | test event id | `191fa91fc019cb7f23490099e552be6905c2bddd:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:92` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 92 | `generic-api-key` | `2fa5ea9c` | test event id | `2fa5ea9c7d9ae621e939f99a50b490d35679a621:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:92` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 95 | `generic-api-key` | `191fa91f` | test event id | `191fa91fc019cb7f23490099e552be6905c2bddd:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:95` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 95 | `generic-api-key` | `2fa5ea9c` | test event id | `2fa5ea9c7d9ae621e939f99a50b490d35679a621:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:95` |
| C8 | `tests/workflow-node24-pins.test.mjs` | 17 | `generic-api-key` | `84cab02c` | GitHub Action commit SHA pin | `84cab02ced8f8c67e6814801aee1d6bf10b59bbd:tests/workflow-node24-pins.test.mjs:generic-api-key:17` |

Totals: 43 fingerprints (C1 2, C2 2, C3 14, C4 8, C5 4, C6 2, C7 10, C8 1).
Findings left un-ignored: **0**. Every gitleaks finding was classified with
confidence.

### Note on PR #948

C8 covers commit `84cab02c`, the current head of PR #948. That fingerprint keeps
working only if #948 lands with its original commits (a merge commit or rebase
that keeps `84cab02c`). **A squash merge creates a new commit SHA, and therefore
a new fingerprint.** The line would then fail the scan again and needs one more
exact entry, generated the same way. Alternatively, #948 can add a
`gitleaks:allow` comment on that line. #948 also edits
`secret-history-scan.yml` (it changes `runs-on` and pins the checkout and
upload-artifact actions). Those hunks do not overlap the lines changed here, but
whichever PR lands second should be rebased and checked.

## TruffleHog

CI runs TruffleHog with `--only-verified`, unchanged: only credentials that the
provider confirms as live fail the job. No credentials were added to CI.
Locally, verification was **not** run, because it would contact third-party
APIs. Instead, TruffleHog **v3.99.2** (the pinned version) ran with
`--no-verification` on the same fresh clone:

- 64 unverified candidates;
- 0 verified;
- all classified as non-secrets, as shown in the table below.

| Detector | Location | Count | Classification |
|---|---|---|---|
| Postgres | `tests/**` fixtures (`data-backup`, `internal-financial-audit`, `test_database_identity_worker.py`, `test_database_url_inventory.py`, `test_p20_restore_drill.py`, `production-order-lookup`, integration tests, `tests/helpers/*-probe.mjs`) | 49 | Fixture URIs. Hosts are `db.invalid`, `*.local`, `db.example.internal`, `h`, `host.tld`, or Neon-shaped names such as `ep-fake-*` and `ep-synthetic-0001`. Passwords are 1 to 15 characters: placeholders (`fake`/`pass`/`secret`/`synthetic`/`sim`) or equal to the user name. |
| Postgres | `tests/helpers/order-lookup-probe.mjs:87` (included in the row above) | (2) | Synthetic Neon URI: user and password `synthetic`, host `ep-synthetic-0001`. Confirmed false positive by the external auditor (Sol, ORDEM 293). |
| Postgres | `worker/cloudflare-worker.recovered.mjs:6986`, and the recovery-kit `.tgz` inside `evidence/final-closure/1162a5844a16/integral-evidence.zip` | 4 | Documentation example `user:<placeholder>@host.tld`. |
| CloudflareApiToken / CloudflareGlobalApiKey | `.github/workflows/zpc-cloudflare-exact-release.yml:13`, commit message `6a81b3b7` | 7 | `ZPC_SHA: <40-hex commit SHA>`, and the same SHA in the commit message. |
| Box | `docs/certification-isolated-worker.md:6` | 2 | Cloudflare KV namespace id (32 hex). This is a resource identifier, not a secret. |
| Miro | `scripts/fixtures/voice-fixed.pcm.gz.b64:3` | 2 | Base64 of gzipped PCM audio (the decoded file is about 505 KB). A random substring matched. |

**No TruffleHog exclusions were added.**

- Because CI is verified-only, none of these candidates can fail the job.
- Excluding paths or detectors would only reduce coverage. For example, a real
  Postgres URI later added under `tests/` would no longer be checked.
- If an exclusion ever becomes necessary, use `--exclude-paths` with an exact,
  anchored path regex and document it here in the same format.

## Maintenance

- **New findings remain fatal.** Never add a fingerprint without a row in this
  file. `tests/test_secret_history_scan_workflow.py` enforces this for the T5
  section, and also enforces the exact fingerprint format.
- **Version bumps.** When the pinned version of either scanner changes, re-run
  the scanner locally on a fresh full clone with `--redact` before merging. Rule
  changes can add or rename findings.
- **Do not print values.** Classify findings by structural pattern only.
