# Secret scan baseline (public mirror)

Reviewed 2026-10-27 (T5, secret-scan hardening; revised after the independent audit of PR #950).
This file records why every fingerprint in `.gitleaksignore` is not a secret. It
contains file, line, rule, commit and type only. **No secret values are recorded here.**
`tests/test_secret_history_scan_workflow.py` fails if any ignore entry lacks a row here,
or if a row here is not in `.gitleaksignore`.

## Method

- Scanner: gitleaks **v8.30.1**, the version pinned in
  `.github/workflows/secret-history-scan.yml`, with the controlled config
  (`[extend] useDefault = true`, which is the built-in default ruleset) and
  `--ignore-gitleaks-allow`.
- Command: `gitleaks git --log-opts=--all --redact=100` on a fresh full clone of
  `arbmsistone-lab/zevanory-public-mirror` at gh-pages `b7671272`, covering
  992 remote branches.
- Without any ignore file:
  - after the PR #950 commits: 86 findings, **84** unique fingerprints;
  - the default config and the controlled config give the identical set.
- With this `.gitleaksignore`, running the workflow's own steps on the full clone
  (2026-10-27, TruffleHog stubbed):
  - 991 remote heads, 0 missing;
  - commits: 4445 scanned, **exactly** the 4445 expected;
  - merges: 37 scanned (remerge-diff) out of 434 merges, exactly the 37 expected;
  - **0 findings, exit 0**.
- Each finding was classified by matching the flagged line against a structural
  pattern, printing only a character-class template or a boolean, never the
  value. Examples of patterns: `re_test_<digits>`, `evt_*`, a 40-hex SHA inside
  an action pin.
- Entries are exact `commit:file:rule:line` fingerprints.
  - There is no rule-wide, path-wide or regex suppression.
  - The scan refuses a repository `.gitleaks.toml`/`.gitleaks*` config and the
    `GITLEAKS_CONFIG*` environment variables.
  - It ignores inline `gitleaks:allow` comments (`--ignore-gitleaks-allow`).
  - So a new secret in any file still fails the scan, including the files listed
    below.
- **2026-10-02 / 2026-10-08 entries.** All entries kept from these reviews were
  re-classified here with the same method.
  - The 8 entries for commit `20247ab2` no longer match any finding with v8.30.1,
    and were removed.
  - If a future scanner version reports them again, they fail the scan and must be
    re-reviewed.
- **External confirmation.**
  - The independent audit of PR #950 re-derived the 43 T5 fingerprints and
    confirmed their classification by template.
  - `tests/helpers/order-lookup-probe.mjs` was confirmed synthetic by the external
    auditor (Sol, ORDEM 293).

## Fail-closed guarantees of the scan job

- **History coverage.**
  - The clone must not be shallow.
  - Every branch head reported by `git ls-remote --heads origin` must be present
    locally. Heads created after checkout are fetched once and re-checked.
  - Otherwise the job fails with `HISTORY_INCOMPLETE`.
  - This applies to pull_request, to the push on gh-pages after merge, and to the
    daily schedule.
- **gitleaks ran on the whole history.** The job fails unless all of these hold:
  - the JSON report exists and is a list;
  - the exit code is 0 or 1 and is consistent with the findings;
  - the log contains no `ERR`/`FTL`/`fatal:` line;
  - the log contains exactly one `N commits scanned` line, and N **equals** an
    independently computed count.
- **What the count is.** The count is taken from
  `git log --all --no-merges --raw --numstat`, which is a different git invocation
  from gitleaks' own `git log -p`. It counts the non-merge commits that have at
  least one file which is:
  - not binary;
  - not deleted;
  - changed by at least one line (rename detection on).

  gitleaks reads a text patch for exactly these commits.
- **What the count excludes.** Merges, empty commits, deletion-only commits (for
  example the revert `c312c4b6`), binary-only commits, and pure renames or mode
  changes. This was verified on the real history (4431 = 4431, later 4445 = 4445)
  and on a synthetic repository covering each case.
- **What equality catches.** Since this is equality, there is **no slack and no
  ceiling problem**:
  - a git failure;
  - a silently dropped commit (harness: 6 scanned, 7 expected → fail);
  - a forged count (99999 → fail);
  - an invalid `--log-opts`;
  - a wrong source directory.
- **Pathspec narrowing.** A narrowed `--log-opts`/pathspec is caught first by the
  pinned workflow bytes, because the command line must match exactly. The count
  would catch it too, unless the excluded paths happened to hold no countable
  commit.
- **Merge commits (remerge-diff).** A secret introduced by a merge itself, for
  example during conflict resolution, has no ordinary patch. Neither
  `gitleaks git` nor `trufflehog git` sees it.
  - A second gitleaks pass runs with `--log-opts="--all --merges --remerge-diff"`,
    with the same report, error and exact-count checks; the count comes from
    `git log --all --merges --remerge-diff --raw --numstat`.
  - On the real history: 434 merges, of which 37 have their own content. Result:
    0 findings.
  - In the harness, an evil merge carrying a planted key fails the job.
- **TruffleHog ran and is consistent.** The job fails unless all of these hold:
  - TruffleHog exits 0;
  - its log has exactly one `finished scanning` line, with 0 < chunks ≤ bytes;
  - `verified_secrets` in that line equals the number of verified results in the
    JSON;
  - with `--only-verified`, the JSON contains no unverified result.

  On failure, the tail of its stderr is printed. TruffleHog verification is
  **never** run locally in this sandbox: its proxy swaps the Authorization header
  sent to api.github.com, so local verification of GitHub tokens gives false
  positives. Local runs always stub TruffleHog.
- **Evidence.**
  - `secret-scan/{history,gitleaks-commits,gitleaks-merges,trufflehog}-summary.json` are uploaded.
  - `::notice` annotations record the counts.
  - A failing scan emits a `SECRET_SCAN_FAILED` annotation with the rules and
    files, never values.

## Contract protection

- **Byte-for-byte pins.** `tests/test_secret_history_scan_workflow.py` pins the
  SHA-256 of all three secret-scan workflows. The only normalisation is the
  self-referential test-hash and test-count lines. Any edit fails, including:
  - a run block, an added line, or a `continue-on-error`;
  - an `env:` (for example `PATH` or `BASH_ENV`);
  - a write to `GITHUB_PATH`/`GITHUB_ENV`;
  - a trigger or a comment.

  Structural checks repeat the intent with readable messages:
  - exact step list;
  - `env:` only on the contract step (`PYTHONDONTWRITEBYTECODE`);
  - no `GITHUB_PATH`/`GITHUB_ENV`/`BASH_ENV`/`GITHUB_OUTPUT`;
  - exact scanner command lines;
  - scanners invoked by absolute path.
- **Where the test runs.**

  | Where | Role |
  |---|---|
  | scan job, step "Secret scan contract (offline)" | PR's own checkout. Verifies the test file's SHA-256 with `sha256sum -c` before running it. |
  | `secret-scan-contract.yml` | PR's own checkout, same hash check. |
  | `secret-scan-contract-protected.yml` | **Authoritative.** Base branch's test, PR files as data; the PR's copy of the test must be byte-identical to the base copy. |

  The first two are tamper-evident only: a PR can change the test and its hash
  together (mutation O19). The protected run catches that. **Changing the scan, its
  workflows or the test therefore requires the owner,** who must bypass the
  required protected check after review.
- **How the protected run works (GitHub Security Lab, "Preventing pwn
  requests").**
  - `pull_request_target` takes its workflow definition from the base branch.
  - Only the base SHA is checked out with `actions/checkout`, and only base code
    runs (`cd base`, `python3 -P`, pyyaml installed into `$RUNNER_TEMP`).
  - The PR head is **not** checked out with `actions/checkout`, which refuses fork
    heads under `pull_request_target`. Instead, the head commit is fetched **by
    SHA** (`git fetch --depth=1 <repo> <head.sha>`) into a separate bare
    repository, and written to `./pr` with `read-tree`/`checkout-index`. This
    involves no hooks, no filters, no `export-ignore` and no submodules.
  - The files in `./pr` are only parsed (`yaml.BaseLoader`) or read as text;
    symlinks are refused, and the tree walk does not follow links.
  - Permissions are `contents: read`; no secrets; no token persisted. The only
    `${{ }}` values passed are `base.sha`, `head.sha` (checked against
    `^[0-9a-f]{40}$`) and `github.repository`, and they go through `env:`/`with:`,
    never interpolated into `run:`.
  - This works for fork PRs: GitHub exposes fork heads as `refs/pull/N/head` in
    the base repository, and serves fetches by SHA.
    - Proven on GitHub itself: an `actions/checkout` PR head SHA that is on no
      branch was fetched by SHA into an empty bare repository.
    - Proven in a local fork simulation that runs the workflow's own run blocks,
      with the head only reachable via `refs/pull/1/head`: an unchanged PR passes;
      a mutated workflow, a gutted and re-hashed test, a symlinked workflow, a
      `.gitleaks.toml` or a `*gitleaks*.toml` fails.
- **None of these workflows has a path or branch filter, or a job-level `if:`.**
  A required check therefore always reports a real result, never "skipped" and
  never "pending".
- **Bootstrap.** `pull_request_target` reads its workflow from the base branch, so
  the protected check starts running on the first PR after this one merges.

## Classes

| Class | Type | Why it is not a secret |
|---|---|---|
| C1 | Env-var reference | The basic-auth user given to `curl` is the variable reference `$STRIPE_SECRET_KEY` (a GitHub Actions secret name); the file holds no value. Also the earlier wording of this very row in commit `3092b79f`. |
| C2 | IndexNow key (public by design) | The IndexNow protocol requires serving the key at https://<host>/<key>.txt (sent as keyLocation, or fetched from /<key>.txt by the audit script). It grants no access. |
| C3 | Resend API key fixture | Literal of the form re_test_<digits> or re_test_<word>_<digits>, used as a placeholder RESEND_API_KEY in tests. |
| C4 | Webhook/HMAC test secret | Hyphenated words followed by the sequence 0123456789abcdef, used in tests to prove signature acceptance/rejection. |
| C5 | TikTok client secret fixture | Literal of the form secret-<digits>. |
| C6 | Mercado Pago canary | MP-PROD-CANARY-<sequential digits>; the test asserts the canary never reaches the logs. |
| C7 | Test event id | evt_* PSP event identifier used as a ledger claim key in a Postgres integration test. |
| C8 | GitHub Action commit SHA pin | 40-hex commit SHA of a pinned action (PR #948 head commit 84cab02c; see the PR #948 note). |
| C9 | Idempotency key | Value of an idempotency-key request header (<word>-<word>-<4 digits>, or 0123456789abcdef); a request de-duplication id, not a credential. |
| C10 | Local CI mock credential | Basic-auth user/password ("...test-only" words) for a mock admin server that the same pull_request job starts on 127.0.0.1; it protects nothing outside the runner. |
| C11 | Vercel domain-verification TXT (public DNS) | The vc-domain-verify=<domain>,<hex> value is published in public DNS by design to prove domain ownership. |
| C12 | Check identifier in evidence JSON | "key":"<area>_<NN>x" entries naming gates in a release-evidence JSON; identifiers, not credentials. |
| C13 | SHA-256 digest | export const <NAME>_SHA256 = "<64 hex>": a content digest, not a credential. |
| C14 | Synthetic test fixture | Literal built from the word "synthetic" plus descriptive words, or a 0123456789abcdef repetition, used only by test scripts. |

## Fingerprints (gitleaks)

| Class | File | Line | Rule | Commit | Type | Fingerprint |
|---|---|---|---|---|---|---|
| C1 | `.github/workflows/financial-e2e-stripe.yml` | 55 | `curl-auth-user` | `9e917e36` | Env-var reference | `9e917e36620b72c1803a953738b6d869ae98ac08:.github/workflows/financial-e2e-stripe.yml:curl-auth-user:55` |
| C1 | `.github/workflows/financial-e2e-stripe.yml` | 55 | `curl-auth-user` | `c3845cf8` | Env-var reference | `c3845cf898acf60e84a06e51cf08db7cfd09bbe3:.github/workflows/financial-e2e-stripe.yml:curl-auth-user:55` |
| C1 | `.github/workflows/financial-e2e-stripe.yml` | 86 | `curl-auth-user` | `2ab3f9bb` | Env-var reference | `2ab3f9bb2ac9044625b74b0120d9432508200b05:.github/workflows/financial-e2e-stripe.yml:curl-auth-user:86` |
| C1 | `.github/workflows/financial-e2e-stripe.yml` | 86 | `curl-auth-user` | `4b73b1ee` | Env-var reference | `4b73b1ee4669b1c95a9b18f1b724cb4d82549d11:.github/workflows/financial-e2e-stripe.yml:curl-auth-user:86` |
| C1 | `.github/workflows/financial-e2e-stripe.yml` | 130 | `curl-auth-user` | `9e917e36` | Env-var reference | `9e917e36620b72c1803a953738b6d869ae98ac08:.github/workflows/financial-e2e-stripe.yml:curl-auth-user:130` |
| C1 | `.github/workflows/financial-e2e-stripe.yml` | 130 | `curl-auth-user` | `c3845cf8` | Env-var reference | `c3845cf898acf60e84a06e51cf08db7cfd09bbe3:.github/workflows/financial-e2e-stripe.yml:curl-auth-user:130` |
| C1 | `.github/workflows/payment-sandbox-adversarial.yml` | 75 | `curl-auth-user` | `0b532d13` | Env-var reference | `0b532d13edde9ba5782b0b7eb96f550c8cf84660:.github/workflows/payment-sandbox-adversarial.yml:curl-auth-user:75` |
| C1 | `.github/workflows/payment-sandbox-adversarial.yml` | 110 | `curl-auth-user` | `0b532d13` | Env-var reference | `0b532d13edde9ba5782b0b7eb96f550c8cf84660:.github/workflows/payment-sandbox-adversarial.yml:curl-auth-user:110` |
| C1 | `docs/security/secret-scan-baseline.md` | 109 | `curl-auth-user` | `3092b79f` | Env-var reference | `3092b79f99f61e77666a797330d9b5ce4aadfeee:docs/security/secret-scan-baseline.md:curl-auth-user:109` |
| C2 | `.github/workflows/indexnow-resubmit.yml` | 17 | `generic-api-key` | `ed60fc5c` | IndexNow key (public by design) | `ed60fc5cce6be620dceffce0c14983b415055b17:.github/workflows/indexnow-resubmit.yml:generic-api-key:17` |
| C2 | `.github/workflows/indexnow-resubmit.yml` | 17 | `generic-api-key` | `f6a7557d` | IndexNow key (public by design) | `f6a7557df5fccd3c9ebd35a0c61a6656719fc5fa:.github/workflows/indexnow-resubmit.yml:generic-api-key:17` |
| C2 | `.github/workflows/indexnow-resubmit.yml` | 32 | `generic-api-key` | `ed60fc5c` | IndexNow key (public by design) | `ed60fc5cce6be620dceffce0c14983b415055b17:.github/workflows/indexnow-resubmit.yml:generic-api-key:32` |
| C2 | `.github/workflows/indexnow-resubmit.yml` | 32 | `generic-api-key` | `f6a7557d` | IndexNow key (public by design) | `f6a7557df5fccd3c9ebd35a0c61a6656719fc5fa:.github/workflows/indexnow-resubmit.yml:generic-api-key:32` |
| C2 | `.github/workflows/indexnow-submit.yml` | 21 | `generic-api-key` | `2d1881df` | IndexNow key (public by design) | `2d1881dfe51a1004fe4888191ff4cbc51b9ee138:.github/workflows/indexnow-submit.yml:generic-api-key:21` |
| C2 | `.github/workflows/indexnow-submit.yml` | 21 | `generic-api-key` | `fbeec343` | IndexNow key (public by design) | `fbeec343292e9c17a6084e672bc41defb7b8a28d:.github/workflows/indexnow-submit.yml:generic-api-key:21` |
| C2 | `scripts/audit-seo-50x.mjs` | 44 | `generic-api-key` | `9b4175ec` | IndexNow key (public by design) | `9b4175ecf4c1bc4f53b1a58c444aa5a214d0dc9e:scripts/audit-seo-50x.mjs:generic-api-key:44` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 39 | `generic-api-key` | `36f1dfa8` | Resend API key fixture | `36f1dfa8a941b24f1d52d8188f0fe33ca0a649dd:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:39` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 39 | `generic-api-key` | `4d364561` | Resend API key fixture | `4d364561a5206640daad235d2512a5dbcc0b8405:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:39` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 39 | `generic-api-key` | `c6089cd7` | Resend API key fixture | `c6089cd77e0753d23cd5f83f268e877fe24f1f61:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:39` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 53 | `generic-api-key` | `36f1dfa8` | Resend API key fixture | `36f1dfa8a941b24f1d52d8188f0fe33ca0a649dd:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:53` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 53 | `generic-api-key` | `4d364561` | Resend API key fixture | `4d364561a5206640daad235d2512a5dbcc0b8405:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:53` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 53 | `generic-api-key` | `c6089cd7` | Resend API key fixture | `c6089cd77e0753d23cd5f83f268e877fe24f1f61:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:53` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 111 | `generic-api-key` | `4d364561` | Resend API key fixture | `4d364561a5206640daad235d2512a5dbcc0b8405:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:111` |
| C3 | `tests/integration/lead-magnet-postgres.test.mjs` | 111 | `generic-api-key` | `c6089cd7` | Resend API key fixture | `c6089cd77e0753d23cd5f83f268e877fe24f1f61:tests/integration/lead-magnet-postgres.test.mjs:generic-api-key:111` |
| C3 | `tests/lead-magnet.test.mjs` | 31 | `generic-api-key` | `cdeb9847` | Resend API key fixture | `cdeb9847df8f8af36093dc4a2dde3f4bc61d374d:tests/lead-magnet.test.mjs:generic-api-key:31` |
| C3 | `tests/lead-magnet.test.mjs` | 31 | `generic-api-key` | `f2523167` | Resend API key fixture | `f2523167c479ca601f1bc2b7d6ecd07b8e621431:tests/lead-magnet.test.mjs:generic-api-key:31` |
| C3 | `tests/lead-magnet.test.mjs` | 72 | `generic-api-key` | `4d364561` | Resend API key fixture | `4d364561a5206640daad235d2512a5dbcc0b8405:tests/lead-magnet.test.mjs:generic-api-key:72` |
| C3 | `tests/lead-magnet.test.mjs` | 72 | `generic-api-key` | `c6089cd7` | Resend API key fixture | `c6089cd77e0753d23cd5f83f268e877fe24f1f61:tests/lead-magnet.test.mjs:generic-api-key:72` |
| C3 | `tests/lead-magnet.test.mjs` | 223 | `generic-api-key` | `4d364561` | Resend API key fixture | `4d364561a5206640daad235d2512a5dbcc0b8405:tests/lead-magnet.test.mjs:generic-api-key:223` |
| C3 | `tests/lead-magnet.test.mjs` | 223 | `generic-api-key` | `c6089cd7` | Resend API key fixture | `c6089cd77e0753d23cd5f83f268e877fe24f1f61:tests/lead-magnet.test.mjs:generic-api-key:223` |
| C3 | `tests/p09-nurture-sequence.test.mjs` | 143 | `generic-api-key` | `79261985` | Resend API key fixture | `79261985feed396f1c6bd30c4fd57c5e2f2df439:tests/p09-nurture-sequence.test.mjs:generic-api-key:143` |
| C3 | `tests/p09-nurture-sequence.test.mjs` | 143 | `generic-api-key` | `e9c4cc07` | Resend API key fixture | `e9c4cc0717637d402f3919b4ca6c61e4610dff4d:tests/p09-nurture-sequence.test.mjs:generic-api-key:143` |
| C3 | `tests/post-sale.test.mjs` | 25 | `generic-api-key` | `37b6e4b3` | Resend API key fixture | `37b6e4b3badec47b037a3086f4141b2903142cbc:tests/post-sale.test.mjs:generic-api-key:25` |
| C3 | `tests/post-sale.test.mjs` | 25 | `generic-api-key` | `6cd301b2` | Resend API key fixture | `6cd301b238f46a15db3efc24134937c223394c46:tests/post-sale.test.mjs:generic-api-key:25` |
| C3 | `tests/reviews.test.mjs` | 21 | `generic-api-key` | `cdeb9847` | Resend API key fixture | `cdeb9847df8f8af36093dc4a2dde3f4bc61d374d:tests/reviews.test.mjs:generic-api-key:21` |
| C3 | `tests/reviews.test.mjs` | 21 | `generic-api-key` | `d7a878ec` | Resend API key fixture | `d7a878ec8d4532e5e3d6e3372668aae049a3bb67:tests/reviews.test.mjs:generic-api-key:21` |
| C4 | `tests/helpers/support-drain-scheduled-probe.mjs` | 9 | `generic-api-key` | `d6ff5f5f` | Webhook/HMAC test secret | `d6ff5f5f68b10df8d1e720071527f64cc8058525:tests/helpers/support-drain-scheduled-probe.mjs:generic-api-key:9` |
| C4 | `tests/helpers/support-drain-scheduled-probe.mjs` | 12 | `generic-api-key` | `36f4e2d6` | Webhook/HMAC test secret | `36f4e2d6b1d7bb3b272ad8e57ef1276a3e08506b:tests/helpers/support-drain-scheduled-probe.mjs:generic-api-key:12` |
| C4 | `tests/integration/support-outbox-postgres.test.mjs` | 77 | `generic-api-key` | `7ab8de28` | Webhook/HMAC test secret | `7ab8de28bc90ca40c1d2c83255ecb6dcf44fb52a:tests/integration/support-outbox-postgres.test.mjs:generic-api-key:77` |
| C4 | `tests/integration/support-outbox-postgres.test.mjs` | 77 | `generic-api-key` | `becd10f5` | Webhook/HMAC test secret | `becd10f5019cab167f35f5eebe1a98f246f441a7:tests/integration/support-outbox-postgres.test.mjs:generic-api-key:77` |
| C4 | `tests/support-email-forward.test.mjs` | 643 | `generic-api-key` | `d6ff5f5f` | Webhook/HMAC test secret | `d6ff5f5f68b10df8d1e720071527f64cc8058525:tests/support-email-forward.test.mjs:generic-api-key:643` |
| C4 | `tests/support-email-forward.test.mjs` | 651 | `generic-api-key` | `88372c53` | Webhook/HMAC test secret | `88372c53e4646f4b5ca1936b0828c191fd32de22:tests/support-email-forward.test.mjs:generic-api-key:651` |
| C4 | `tests/support-email-forward.test.mjs` | 671 | `generic-api-key` | `36f4e2d6` | Webhook/HMAC test secret | `36f4e2d6b1d7bb3b272ad8e57ef1276a3e08506b:tests/support-email-forward.test.mjs:generic-api-key:671` |
| C4 | `tests/support-email-forward.test.mjs` | 671 | `generic-api-key` | `979c1296` | Webhook/HMAC test secret | `979c129657cd7e465baefa6fab78545affa3a1b5:tests/support-email-forward.test.mjs:generic-api-key:671` |
| C5 | `tests/owner-oauth-tiktok.test.mjs` | 15 | `generic-api-key` | `0936186d` | TikTok client secret fixture | `0936186df774fcf736a5a1381daff32e523886e3:tests/owner-oauth-tiktok.test.mjs:generic-api-key:15` |
| C5 | `tests/owner-oauth-tiktok.test.mjs` | 15 | `generic-api-key` | `dc96670b` | TikTok client secret fixture | `dc96670b84cd591b9f6129e9f3ac62662aa59e80:tests/owner-oauth-tiktok.test.mjs:generic-api-key:15` |
| C5 | `tests/short-crosspost.test.mjs` | 11 | `generic-api-key` | `0936186d` | TikTok client secret fixture | `0936186df774fcf736a5a1381daff32e523886e3:tests/short-crosspost.test.mjs:generic-api-key:11` |
| C5 | `tests/short-crosspost.test.mjs` | 11 | `generic-api-key` | `dc96670b` | TikTok client secret fixture | `dc96670b84cd591b9f6129e9f3ac62662aa59e80:tests/short-crosspost.test.mjs:generic-api-key:11` |
| C6 | `tests/test_mp_rotation_workflow.py` | 405 | `generic-api-key` | `f47b1f42` | Mercado Pago canary | `f47b1f42bf900869a85749dbec572001198e3f74:tests/test_mp_rotation_workflow.py:generic-api-key:405` |
| C6 | `tests/test_mp_rotation_workflow.py` | 405 | `generic-api-key` | `f59b28ef` | Mercado Pago canary | `f59b28ef58a700fdd973ddccae77bda26789248a:tests/test_mp_rotation_workflow.py:generic-api-key:405` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 47 | `generic-api-key` | `191fa91f` | Test event id | `191fa91fc019cb7f23490099e552be6905c2bddd:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:47` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 47 | `generic-api-key` | `2fa5ea9c` | Test event id | `2fa5ea9c7d9ae621e939f99a50b490d35679a621:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:47` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 54 | `generic-api-key` | `191fa91f` | Test event id | `191fa91fc019cb7f23490099e552be6905c2bddd:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:54` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 54 | `generic-api-key` | `2fa5ea9c` | Test event id | `2fa5ea9c7d9ae621e939f99a50b490d35679a621:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:54` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 90 | `generic-api-key` | `191fa91f` | Test event id | `191fa91fc019cb7f23490099e552be6905c2bddd:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:90` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 90 | `generic-api-key` | `2fa5ea9c` | Test event id | `2fa5ea9c7d9ae621e939f99a50b490d35679a621:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:90` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 92 | `generic-api-key` | `191fa91f` | Test event id | `191fa91fc019cb7f23490099e552be6905c2bddd:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:92` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 92 | `generic-api-key` | `2fa5ea9c` | Test event id | `2fa5ea9c7d9ae621e939f99a50b490d35679a621:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:92` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 95 | `generic-api-key` | `191fa91f` | Test event id | `191fa91fc019cb7f23490099e552be6905c2bddd:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:95` |
| C7 | `tests/integration/psp-dlq-alert-postgres.test.mjs` | 95 | `generic-api-key` | `2fa5ea9c` | Test event id | `2fa5ea9c7d9ae621e939f99a50b490d35679a621:tests/integration/psp-dlq-alert-postgres.test.mjs:generic-api-key:95` |
| C8 | `tests/workflow-node24-pins.test.mjs` | 17 | `generic-api-key` | `84cab02c` | GitHub Action commit SHA pin | `84cab02ced8f8c67e6814801aee1d6bf10b59bbd:tests/workflow-node24-pins.test.mjs:generic-api-key:17` |
| C9 | `.github/workflows/zevanory-admin-control-center.yml` | 269 | `generic-api-key` | `59ded1db` | Idempotency key | `59ded1db1fc4bfb51353b0e0f56b43c1c8ba18a9:.github/workflows/zevanory-admin-control-center.yml:generic-api-key:269` |
| C9 | `.github/workflows/zevanory-admin-control-center.yml` | 269 | `generic-api-key` | `8700285b` | Idempotency key | `8700285ba1a0a240deef9c779d9fb20f79c66500:.github/workflows/zevanory-admin-control-center.yml:generic-api-key:269` |
| C9 | `.github/workflows/zevanory-admin-control-center.yml` | 269 | `generic-api-key` | `c8c4aa53` | Idempotency key | `c8c4aa535dd969d5c68baf68ca21f1d1c8901b21:.github/workflows/zevanory-admin-control-center.yml:generic-api-key:269` |
| C9 | `.github/workflows/zevanory-admin-control-center.yml` | 281 | `generic-api-key` | `59ded1db` | Idempotency key | `59ded1db1fc4bfb51353b0e0f56b43c1c8ba18a9:.github/workflows/zevanory-admin-control-center.yml:generic-api-key:281` |
| C9 | `.github/workflows/zevanory-admin-control-center.yml` | 281 | `generic-api-key` | `8700285b` | Idempotency key | `8700285ba1a0a240deef9c779d9fb20f79c66500:.github/workflows/zevanory-admin-control-center.yml:generic-api-key:281` |
| C9 | `.github/workflows/zevanory-admin-control-center.yml` | 281 | `generic-api-key` | `c8c4aa53` | Idempotency key | `c8c4aa535dd969d5c68baf68ca21f1d1c8901b21:.github/workflows/zevanory-admin-control-center.yml:generic-api-key:281` |
| C9 | `.github/workflows/zevanory-control-plane-v2-proof.yml` | 67 | `generic-api-key` | `39d4e583` | Idempotency key | `39d4e583dd1458bc268722eb7f1de61eb9576b66:.github/workflows/zevanory-control-plane-v2-proof.yml:generic-api-key:67` |
| C9 | `.github/workflows/zevanory-control-plane-v2-proof.yml` | 67 | `generic-api-key` | `90336dde` | Idempotency key | `90336ddeffbbc3666368356502fdefc05b7d6d8f:.github/workflows/zevanory-control-plane-v2-proof.yml:generic-api-key:67` |
| C10 | `.github/workflows/zevanory-admin-render-proof.yml` | 61 | `curl-auth-user` | `7cc8080d` | Local CI mock credential | `7cc8080de1fb05b89c2369e7ffb9fb7cd7514a89:.github/workflows/zevanory-admin-render-proof.yml:curl-auth-user:61` |
| C10 | `.github/workflows/zevanory-admin-render-proof.yml` | 61 | `curl-auth-user` | `974c16eb` | Local CI mock credential | `974c16eb01025f0498f33f1b2bf21dc9406d9281:.github/workflows/zevanory-admin-render-proof.yml:curl-auth-user:61` |
| C11 | `ZEVANORY_MASTER.md` | 45 | `generic-api-key` | `3ec9f421` | Vercel domain-verification TXT (public DNS) | `3ec9f421648fb8b5f645b3dd23e2ba756815342f:ZEVANORY_MASTER.md:generic-api-key:45` |
| C11 | `evidence/EG-0021-dominio-publicado-verificacao-vercel.md` | 16 | `generic-api-key` | `8b82973a` | Vercel domain-verification TXT (public DNS) | `8b82973ab375ccda05078ce505d080af37d3d85a:evidence/EG-0021-dominio-publicado-verificacao-vercel.md:generic-api-key:16` |
| C11 | `evidence/EG-0022-vercel-ownership-txt.md` | 16 | `generic-api-key` | `0b54a9d7` | Vercel domain-verification TXT (public DNS) | `0b54a9d7d68b2062d90678548e3954650e4dda21:evidence/EG-0022-vercel-ownership-txt.md:generic-api-key:16` |
| C12 | `evidence/final-closure/1162a5844a16/control.json` | 1 | `generic-api-key` | `04e9b9c9` | Check identifier in evidence JSON | `04e9b9c9159db16df436916f8b744b7c5e1e33f6:evidence/final-closure/1162a5844a16/control.json:generic-api-key:1` |
| C12 | `evidence/final-closure/1162a5844a16/core.json` | 1 | `generic-api-key` | `04e9b9c9` | Check identifier in evidence JSON | `04e9b9c9159db16df436916f8b744b7c5e1e33f6:evidence/final-closure/1162a5844a16/core.json:generic-api-key:1` |
| C13 | `worker/sandbox-proof-v2.mjs` | 14 | `generic-api-key` | `47b43013` | SHA-256 digest | `47b4301366ce0f63bba0a3edddffce6ebc44bfc0:worker/sandbox-proof-v2.mjs:generic-api-key:14` |
| C13 | `worker/sandbox-proof-v2.mjs` | 14 | `generic-api-key` | `9489f3b1` | SHA-256 digest | `9489f3b197441aac5563a9e3505cc6280f33c9b7:worker/sandbox-proof-v2.mjs:generic-api-key:14` |
| C14 | `scripts/voice_render_client_test.mjs` | 4 | `generic-api-key` | `4b56f644` | Synthetic test fixture | `4b56f6447d8f362353b17ee27f7bd7bfa548c712:scripts/voice_render_client_test.mjs:generic-api-key:4` |
| C14 | `scripts/voice_render_client_test.mjs` | 4 | `generic-api-key` | `6d35b474` | Synthetic test fixture | `6d35b4741a1b8c6f4afcff79366c21b9d1712ada:scripts/voice_render_client_test.mjs:generic-api-key:4` |
| C14 | `scripts/whatsapp_audio_runtime_test.mjs` | 83 | `generic-api-key` | `3b8e6418` | Synthetic test fixture | `3b8e641875fc07bd3c6eda8712c7fe23891c7e2e:scripts/whatsapp_audio_runtime_test.mjs:generic-api-key:83` |
| C14 | `scripts/whatsapp_audio_runtime_test.mjs` | 83 | `generic-api-key` | `fecd365a` | Synthetic test fixture | `fecd365a8d3e8b8a01681e38692e37e47cfc622e:scripts/whatsapp_audio_runtime_test.mjs:generic-api-key:83` |
| C14 | `test/meta-oauth.test.mjs` | 5 | `generic-api-key` | `7a488a8a` | Synthetic test fixture | `7a488a8ad1998abb4e906b3cb566eea98d400d64:test/meta-oauth.test.mjs:generic-api-key:5` |
| C15 | `tests/fixtures/t5-negative-proof/fake-secret.txt` | 3 | `generic-api-key` | `cf033a87` | CI negative-proof fake (PR #950) | `cf033a872b91c83b7c95a119c1d36346a309f100:tests/fixtures/t5-negative-proof/fake-secret.txt:generic-api-key:3` |

Totals: **84** fingerprints.

| Class | Fingerprints |
|---|---|
| C1 | 9 |
| C2 | 7 |
| C3 | 20 |
| C4 | 8 |
| C5 | 4 |
| C6 | 2 |
| C7 | 10 |
| C8 | 1 |
| C9 | 8 |
| C10 | 2 |
| C11 | 3 |
| C12 | 2 |
| C13 | 2 |
| C14 | 5 |
| C15 | 1 |
| C15 | CI negative-proof fake (PR #950) | A random 32-character value generated for this test and labelled SYNTHETIC in the file. It was committed only to prove in a real Actions run that the scan fails (run 122305555353), then reverted (`c312c4b6`). Never a credential. |

Findings left un-ignored: **0**. Every gitleaks finding was classified with
confidence.

### Note on PR #948 (C8): follow-up required after it lands

C8 covers `84cab02c:tests/workflow-node24-pins.test.mjs:generic-api-key:17`. Commit
`84cab02c` exists only on the #948 branch, and gh-pages requires a linear history.
GitHub therefore lands #948 through either a squash or a rebase. **Both create a
new commit SHA, so this fingerprint will not match after the merge.**

Expected effect: as soon as #948 lands, the push scan on gh-pages (and the daily
scan) reports one `generic-api-key` finding at
`tests/workflow-node24-pins.test.mjs:17` in the new commit, and fails. That line
is the 40-hex commit SHA of a pinned action, which is not a secret.

Required follow-up, in a separate PR right after #948 lands:

1. Run the pinned gitleaks with `--redact` on a fresh full clone.
2. Confirm that the only new finding is that line in the landed commit.
3. Add its exact fingerprint (`<new sha>:tests/workflow-node24-pins.test.mjs:generic-api-key:17`)
   to `.gitleaksignore`, with a C8 row here.
4. Keep or remove the `84cab02c` entry. It stays harmless while the #948 branch
   exists.

Do not use inline allow comments: the scan ignores them on purpose.

### Note on PR #950 itself (C15): merge with squash

PR #950 deliberately carries one negative-proof commit that adds a random,
obviously fake key, together with its revert. This proves in a real Actions run
that the scan fails.

- **With a squash merge**, gh-pages never contains that blob.
- **With a rebase merge**, the fake commit would land on gh-pages with a new SHA,
  and the push scan would correctly fail on it.

**Merge #950 with squash.** Nothing in the repository enforces this:
`allow_rebase_merge` is `true`. Linear history already blocks merge commits.

- **Owner recommendation:** disable rebase merging in the repository settings, or
  at least choose "Squash and merge" for #950.
- **If it is rebased by mistake:** the push scan on gh-pages fails on the
  re-written fake commit and the re-written doc line, which is correct and loud.
  The fix is to add their exact fingerprints, classified C15 and C1.

The C15 fingerprint covers the commit on the PR branch.

#948 also edits `secret-history-scan.yml`. This PR adopts the same `runs-on` and
the same action SHAs as #948 to minimise conflicts. Even so, whichever PR lands
second must be rebased and re-checked.

## TruffleHog

CI runs TruffleHog with `--only-verified`, unchanged: only credentials that the
provider confirms as live fail the job.

- No credentials were added to CI.
- `--no-ignore-tag` makes inline `trufflehog:ignore` comments ineffective.
- The job fails closed when:
  - TruffleHog exits non-zero, or
  - its log does not report a `finished scanning` with more than 0 chunks.

  In both cases the tail of its stderr is printed.

Locally, verification was **not** run, because it would contact third-party APIs.
Instead, TruffleHog **v3.99.2** (the pinned version) ran with `--no-verification`
on the same fresh clone. It reported 64 unverified candidates and 0 verified; all
are classified as non-secrets:

| Detector | Location | Count | Classification |
|---|---|---|---|
| Postgres | `tests/**` fixtures: `data-backup`, `internal-financial-audit`, `test_database_identity_worker.py`, `test_database_url_inventory.py`, `test_p20_restore_drill.py`, `production-order-lookup`, integration tests, `tests/helpers/*-probe.mjs` | 49 | Fixture URIs. Hosts are `db.invalid`, `*.local`, `db.example.internal`, `h`, `host.tld`, or Neon-shaped names such as `ep-fake-*` and `ep-synthetic-0001`. Passwords are 1 to 15 characters: placeholders (`fake`/`pass`/`secret`/`synthetic`/`sim`) or equal to the user name. |
| Postgres | `tests/helpers/order-lookup-probe.mjs:87` (included in the row above) | (2) | Synthetic Neon URI: user and password `synthetic`, host `ep-synthetic-0001`. Confirmed false positive by the external auditor (Sol, ORDEM 293). |
| Postgres | `worker/cloudflare-worker.recovered.mjs:6986`, and the recovery-kit `.tgz` inside `evidence/final-closure/1162a5844a16/integral-evidence.zip` | 4 | Documentation example `user:<placeholder>@host.tld`. |
| CloudflareApiToken / CloudflareGlobalApiKey | `.github/workflows/zpc-cloudflare-exact-release.yml:13`, commit message `6a81b3b7` | 7 | `ZPC_SHA: <40-hex commit SHA>`, and the same SHA in the commit message. |
| Box | `docs/certification-isolated-worker.md:6` | 2 | Cloudflare KV namespace id (32 hex): a resource identifier, not a secret. |
| Miro | `scripts/fixtures/voice-fixed.pcm.gz.b64:3` | 2 | Base64 of gzipped PCM audio (about 505 KB decoded); a random substring matched. |

**No TruffleHog exclusions were added.**

- Because CI is verified-only, none of these candidates can fail the job.
- Excluding paths or detectors would only reduce coverage.
- If an exclusion ever becomes necessary, use `--exclude-paths` with an exact,
  anchored path regex, document it here, and update the contract test, which
  currently forbids exclusion flags.

**Known limit (audit B1).** `--only-verified` drops results whose verification
errored, for example on a timeout or rate limit. Accepting `unknown` results
(`--results=verified,unknown`) would make CI flaky on network errors, so it was
left unchanged. This is a candidate for an owner decision.

## Supply chain

- Both release tarballs are pinned by SHA-256 in the workflow. The values were
  checked against each project's official `checksums.txt`, downloaded from
  `github.com/<org>/<repo>/releases/download/`.
- **Cosign was not verified.**
  - TruffleHog publishes `checksums.txt.sig` and `.pem`. Locally, the certificate
    SAN reads `https://github.com/trufflesecurity/trufflehog/.github/workflows/release.yml@refs/tags/v3.99.2`.
  - The full `cosign verify-blob` check could not complete: the sigstore TUF/Rekor
    endpoints are blocked by this environment's proxy.
  - gitleaks v8.30.1 publishes no signature.
  - Because the digests are pinned in the repository, a runtime cosign check would
    add a third pinned binary and a network dependency for little extra assurance.
    It is therefore documented, not added.
- Actions are pinned by full commit SHA:
  - `actions/checkout` `3d3c42e5…` is v7.0.1;
  - `actions/upload-artifact` `cf430e03…` is v7.0.2.

## Maintenance

- **New findings remain fatal.** Never add a fingerprint without a row in this
  file. The contract test enforces this for every entry.
- **Version bumps.** When the pinned version of either scanner changes, re-run
  the scanner locally on a fresh full clone with `--redact` before merging. Rule
  changes can add or rename findings.
- **Do not print values.** Classify findings by structural pattern only.
- **Required checks (owner decision).** The contract and the scan only protect
  gh-pages if these are required checks:
  - `ZEVANORY Public Secret History Scan / full-history`;
  - `secret-scan-contract / contract`;
  - `secret-scan-contract-protected / protected-contract`.

  Today only `product-pages / static-audit` and `zees16-evidence / fail-closed`
  are required.
