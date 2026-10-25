# WhatsApp retirement mutants — causality table

Runner: `scripts/ci/mutants_whatsapp_retirement.mjs` (suites `tests/whatsapp-retirement.test.mjs`,
`tests/meta-social-manual-only.test.mjs`, `tests/whatsapp-config-absence.test.mjs`; baseline 27 tests).
Expectations: `scripts/ci/mutants_whatsapp_retirement.expected.json`. Config validation (`load_mutant_config`) and
verdicts (`classify` CLI) come from the shared classifier `scripts/ci/mutant_classifier.py` (PR #901, merged); the
runner writes each run's TAP to a file and calls the CLI.

Sol audits 128/131 (binding):
- **Primary** (1–3 per mutant): the assertions that directly test the mutated rule, chosen by reasoning about the
  mutation, never by recording which tests failed. Every primary names its assertion: the suites label each such
  assertion with a `[WR-...]` token, and the classifier requires that label inside the `not ok` block of the primary
  test (a failure of the same test on another assertion is INCONCLUSIVE). `re:` patterns pin the specific case
  (e.g. M10 only on the `instagram small` classification, M44 only on `whatsapp-contact.js:wa.me`).
- **Secondary**: a collateral failure the mutation causally implies; each one has a written justification.
- **KILLED** needs a labelled assertion failure in a primary test; every other failure must be primary or justified
  secondary. A failure only in secondaries, an unrelated failure, a non-assertion failure, a crash, a truncated TAP,
  skip/todo/cancelled or a count mismatch is **INCONCLUSIVE**.
- The runner refuses to start (exit 4, `MUTANT CONFIG REFUSED`) when `load_mutant_config` rejects the config
  (unjustified secondary, 0 or more than 3 primaries, more than 4 distinct tests without `broad_reason`), when a
  primary has no `assertion_pattern`, or on a config/mutant mismatch.
- A SURVIVED mutant gets a new direct test; the expected list is never widened to absorb it.
- Meta-tests: `tests/whatsapp-mutants-classifier.test.mjs` (secondary-only, unrelated failure, wrong assertion in the
  primary test, runner refusal on an unjustified secondary / unlabelled primary / missing broad_reason).

Note on M46: the first strict run classified it INCONCLUSIVE because the `workflows:` test also failed. Cause: the
`--workflows` scan deliberately reuses the public number patterns, so weakening one also stops it flagging the
synthetic `+55 (88) 9234 0423` workflow. That is recorded as a justified secondary, not as a widened primary.

| Mutant | Rule broken by the mutation | Primary (test / assertion) | Secondary: justification | broad_reason |
|---|---|---|---|---|
| M01 | env WHATSAPP_CHANNEL_RETIRED=false re-enables the channel | `kill-switch: retirement is a code constant` / `WR-SW-ENV` | `retired: no fetch`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`status surfaces:`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`Meta webhook: WhatsApp deliveries`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`bundle layer`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`onboarding routes`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`instant reply:`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`webhook handler:`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails | whatsappChannelRetired() is the master gate read by every WhatsApp path; reading the env makes every REENABLE-driven retired assertion fail |
| M02 | retirement constant flipped to false | `kill-switch: retirement is a code constant` / `WR-SW-CONST` | `retired: no fetch`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`status surfaces:`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`Meta webhook: WhatsApp deliveries`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`bundle layer`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`onboarding routes`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`sender primitives`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`outbound adapter`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`instant reply:`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`webhook handler:`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails | WHATSAPP_CHANNEL_RETIRED is the master constant behind every WhatsApp path; flipping it reopens all of them |
| M03 | env re-enables the instant reply | `kill-switch: retirement is a code constant` / `WR-SW-REPLY` | `status surfaces:`: the instant-status surface reports whatsappInstantReplyEnabled(env); under REENABLE it now reports enabled | — |
| M04 | process.env re-enables the channel | `kill-switch: retirement is a code constant` / `WR-SW-ENV` | `retired: no fetch`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`status surfaces:`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`Meta webhook: WhatsApp deliveries`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`bundle layer`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`onboarding routes`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`sender primitives`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`outbound adapter`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`instant reply:`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`webhook handler:`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path | whatsappChannelRetired() is the master gate; reading process.env reopens every path the tests drive with REENABLE |
| M05 | compat Worker reads the broker status | `retired: no fetch` / `WR-PATH-BROKER` | `Meta webhook: WhatsApp deliveries`: the compat fetch loads the broker status on every request, so the Meta webhook request now calls the spied WHATSAPP_BROKER binding<br>`onboarding routes`: onboarding/proof routes go through the same compat fetch, which now calls the spied broker binding before answering 410 | — |
| M06 | stale isolate globals kept | `retired: no fetch` / `WR-PATH-CREDS` | — | — |
| M07 | edge no longer classifies WhatsApp deliveries | `Meta webhook: WhatsApp deliveries` / `WR-HOOK-EDGE` | — | — |
| M08 | edge silently acks every Meta product | `Meta webhook: Instagram/Facebook` / `WR-NONWA-SILENT` | — | — |
| M09 | edge silently acks oversized bodies | `Meta webhook: Instagram/Facebook` / `WR-NONWA-DECLARED` | — | — |
| M10 | Instagram classified as WhatsApp | `Meta webhook: Instagram/Facebook` / `re:WR-NONWA-CLASSIFY\] instagram small` | — | — |
| M11 | classifier without size bound | `Meta webhook: Instagram/Facebook` / `re:WR-NONWA-CLASSIFY\] instagram large` | — | — |
| M12 | classifier ignores social fields | `Meta webhook: Instagram/Facebook` / `re:WR-NONWA-CLASSIFY\] mixed product` | — | — |
| M13 | bundle webhook processes WhatsApp | `bundle layer` / `WR-BHOOK-ACK` | — | — |
| M14 | broker-call guard removed | `sender primitives` / `WR-PRIM-BROKER`<br>`bundle layer` / `WR-BHOOK-BROKER` | — | — |
| M15 | identity check calls Graph | `retired: no fetch` / `WR-PATH-PROVIDER`<br>`status surfaces:` / `WR-SURF-IDENTITY` | — | — |
| M16 | migration probe uses the WhatsApp token | `retired: no fetch` / `WR-PATH-PROVIDER` | `status surfaces:`: the migration probe result feeds the status surface, which then reports a token-derived probe instead of the retired mode | — |
| M17 | reply guard removed | `instant reply:` / `WR-REPLY` | — | — |
| M18 | webhook instant reply defaults to on via env | `static: retired onboarding` / `WR-ONB-BUNDLE-REPLY` | — | — |
| M19 | webhook processes inbound messages | `webhook handler:` / `WR-H18-INBOUND` | — | — |
| M20 | Graph sender guard removed | `sender primitives` / `WR-PRIM-SEND` | — | — |
| M21 | voice upload guard removed | `sender primitives` / `WR-PRIM-VOICE` | — | — |
| M22 | media download guard removed | `sender primitives` / `WR-PRIM-MEDIA` | — | — |
| M23 | outbound adapter guard removed | `outbound adapter` / `WR-ADAPTER` | — | — |
| M24 | release mode not disabled_permanent | `status surfaces:` / `WR-SURF-RELEASE` | — | — |
| M25 | channel status counts WhatsApp | `status surfaces:` / `WR-SURF-CHANNEL` | — | — |
| M26 | distribution counts WhatsApp | `status surfaces:` / `WR-SURF-DIST` | — | — |
| M27 | projection ignores retirement | `projection:` / `WR-PROJ` | — | — |
| M28 | continuity quorum counts the retired channel | `provider independence:` / `WR-QUORUM` | — | — |
| M29 | onboarding routes alive | `onboarding routes` / `WR-GONE-PROOF` | — | — |
| M30 | broker tombstone answers 200 | `broker tombstone:` / `WR-BROKER-410` | — | — |
| M31 | instant status defaults to on via env | `status surfaces:` / `WR-SURF-INSTANT`<br>`static: retired onboarding` / `WR-ONB-COMPAT-REPLY` | — | — |
| M32 | forged webhook generator reintroduced | `static: no forged` / `WR-FORGER` | — | — |
| M33 | proof job parked with if:false | `static: retired workflows` / `WR-WF-PROOF` | — | — |
| M34 | webhook accepts runtime verify token | `bundle layer` / `WR-BHOOK-VERIFY` | — | — |
| M35 | social auto-reply path back | `keyword comments, Page feed` / `WR-SOC-REPLY`<br>`static: no social automation` / `WR-SOC-STATIC` | — | — |
| M36 | social auto-reply switch back | `static: no social automation` / `re:WR-SOC-STATIC\] META_SOCIAL_AUTOREPLY` | — | — |
| M37 | social handler claims non-social payloads | `non-social payloads` / `WR-SOC-NONSOCIAL` | — | — |
| M38 | bundle loads the Page token for social | `static: no social automation` / `WR-SOC-TOKEN` | — | — |
| M39 | generator assigns SUPPORT_CHANNEL (strip removed) | `generated candidate config:` / `WR-CFG-ALIAS`<br>`generator source:` / `WR-SRC-ALIAS` | — | — |
| M40 | generator keeps the legacy base alias | `generated candidate config:` / `WR-CFG-ALIAS` | — | — |
| M41 | generator emits ZEVANORY_WHATSAPP_DISPLAY | `generated candidate config:` / `WR-CFG-ALIAS`<br>`generator source:` / `WR-SRC-ALIAS` | — | — |
| M42 | wrangler.toml regains SUPPORT_CHANNEL | `wrangler configs:` / `WR-TOML` | — | — |
| M43 | WHATSAPP_SALES_ENABLED back to "true" | `generated candidate config:` / `WR-CFG-SALES`<br>`generator source:` / `WR-SRC-SALES` | — | — |
| M44 | wa.me injector not neutralized | `generated public assets:` / `re:WR-PUB-NEUTRAL[\s\S]*whatsapp-contact\.js:wa\.me` | `generated candidate config:`: the leftover wa.me makes the generator abort fail-closed, so the config test's exit-status assertion fails<br>`no over-stripping:`: the leftover wa.me makes the generator abort fail-closed, so the over-stripping guard's exit-status assertion fails before it can inspect the kept keys | — |
| M45 | public fail-closed scan disabled | `fail-closed: any leftover` / `re:WR-FAILCLOSED\] generator must fail closed on: <a href=\"https://wa\.me/` | — | — |
| M46 | 9234-0423 number pattern weakened | `fail-closed: any leftover` / `re:WR-FAILCLOSED\] generator must fail closed on: Atendimento \(88\) 9234 0423` | `workflows:`: the --workflows scan reuses PUBLIC_WHATSAPP_PATTERNS, so the weakened 9234-0423 pattern also stops flagging the synthetic '+55 (88) 9234 0423' workflow | — |
| M47 | JSON-LD telephone kept | `generated public assets:` / `re:WR-PUB-NEUTRAL[\s\S]*index\.html:number 9234-0423` | `generated candidate config:`: the leftover telephone makes the generator abort fail-closed, so the config test's exit-status assertion fails<br>`no over-stripping:`: the leftover telephone makes the generator abort fail-closed, so the over-stripping guard's exit-status assertion fails before it can inspect the kept keys | — |
| M48 | public number rewrite map back | `generator source:` / `WR-SRC-REWRITE` | — | — |
| M49 | a workflow assigns ZEVANORY_WHATSAPP_DISPLAY again | `workflows:` / `WR-WF-ASSIGN` | — | — |
| M50 | generator ships WHATSAPP_PHONE_NUMBER_ID again (dropped from RETIRED_WHATSAPP_META_KEYS) | `generated candidate config:` / `WR-CFG-META` | — | — |
| M51 | strip over-reaches META_VERIFY_TOKEN (shared Instagram/Facebook verify token) | `no over-stripping:` / `WR-CFG-KEEP` | — | — |
