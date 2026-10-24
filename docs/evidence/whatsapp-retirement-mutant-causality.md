# WhatsApp retirement mutants — causality table

Runner: `scripts/ci/mutants_whatsapp_retirement.mjs` (suites `tests/whatsapp-retirement.test.mjs`,
`tests/meta-social-manual-only.test.mjs`, `tests/whatsapp-config-absence.test.mjs`; baseline 26 tests).
Expectations: `scripts/ci/mutants_whatsapp_retirement.expected.json`. Verdict and config validation:
`scripts/ci/mutant_expectations.mjs`, a local port of `load_mutant_config` / `classify` from PR #901
(`scripts/ci/mutant_classifier.py`), with the same spec format so the runner can switch when #901 is authorised.

Sol audit 128 (binding):
- **Primary** (1–3 per mutant): the assertions that directly test the mutated rule, chosen by reasoning about the
  mutation, never by recording which tests failed.
- **Secondary**: a collateral failure the mutation causally implies; each one has a written justification.
- **KILLED** needs an assertion failure in a primary test; every other failure must be primary or justified
  secondary; a failure only in secondaries, an unrelated failure, a non-assertion failure, a crash, a truncated TAP or
  a count mismatch is **INCONCLUSIVE**.
- The runner refuses to start (exit 4, `MUTANT CONFIG REFUSED`) on an unjustified secondary, 0 or more than 3
  primaries, more than 4 distinct tests without `broad_reason`, or a config/mutant mismatch.
- A SURVIVED mutant gets a new direct test; the expected list is never widened to absorb it.
- Meta-tests: `tests/mutant-expectations.test.mjs` (secondary-only, unrelated failure, unjustified entry, runner refusal).

Note on M46: the first strict run classified it INCONCLUSIVE because the `workflows:` test also failed. Cause: the
`--workflows` scan deliberately reuses the public number patterns, so weakening one also stops it flagging the
synthetic `+55 (88) 9234 0423` workflow. That is recorded as a justified secondary, not as a widened primary.

Test prefixes are literal with a token boundary (PR #901 semantics). `assertion_pattern` narrows a primary to one
assertion message where the test holds several rules.

| Mutant | Rule broken by the mutation | Primary (test / assertion) | Secondary: justification | broad_reason |
|---|---|---|---|---|
| M01 | env WHATSAPP_CHANNEL_RETIRED=false re-enables the channel | `kill-switch: retirement is a code constant` | `retired: no fetch`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`status surfaces:`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`Meta webhook: WhatsApp deliveries`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`bundle layer`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`onboarding routes`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`instant reply:`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails<br>`webhook handler:`: the test runs with the REENABLE env (WHATSAPP_CHANNEL_RETIRED=false); an env-honouring switch reopens this path, so its retired-only assertion fails | whatsappChannelRetired() is the master gate read by every WhatsApp path; reading the env makes every REENABLE-driven retired assertion fail |
| M02 | retirement constant flipped to false | `kill-switch: retirement is a code constant` | `retired: no fetch`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`status surfaces:`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`Meta webhook: WhatsApp deliveries`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`bundle layer`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`onboarding routes`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`sender primitives`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`outbound adapter`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`instant reply:`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails<br>`webhook handler:`: the constant is the single gate of this path; flipping it to false re-enables it, so its retired-only assertion fails | WHATSAPP_CHANNEL_RETIRED is the master constant behind every WhatsApp path; flipping it reopens all of them |
| M03 | env re-enables the instant reply | `kill-switch: retirement is a code constant` | `status surfaces:`: the instant-status surface reports whatsappInstantReplyEnabled(env); under REENABLE it now reports enabled | — |
| M04 | process.env re-enables the channel | `kill-switch: retirement is a code constant` | `retired: no fetch`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`status surfaces:`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`Meta webhook: WhatsApp deliveries`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`bundle layer`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`onboarding routes`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`sender primitives`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`outbound adapter`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`instant reply:`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path<br>`webhook handler:`: process.env carries the REENABLE values in these tests, so the process.env-reading gate reopens this path | whatsappChannelRetired() is the master gate; reading process.env reopens every path the tests drive with REENABLE |
| M05 | compat Worker reads the broker status | `retired: no fetch` | `Meta webhook: WhatsApp deliveries`: the compat fetch loads the broker status on every request, so the Meta webhook request now calls the spied WHATSAPP_BROKER binding<br>`onboarding routes`: onboarding/proof routes go through the same compat fetch, which now calls the spied broker binding before answering 410 | — |
| M06 | stale isolate globals kept | `retired: no fetch` | — | — |
| M07 | edge no longer classifies WhatsApp deliveries | `Meta webhook: WhatsApp deliveries` | — | — |
| M08 | edge silently acks every Meta product | `Meta webhook: Instagram/Facebook` | — | — |
| M09 | edge silently acks oversized bodies | `Meta webhook: Instagram/Facebook` | — | — |
| M10 | Instagram classified as WhatsApp | `Meta webhook: Instagram/Facebook` | — | — |
| M11 | classifier without size bound | `Meta webhook: Instagram/Facebook` | — | — |
| M12 | classifier ignores social fields | `Meta webhook: Instagram/Facebook` | — | — |
| M13 | bundle webhook processes WhatsApp | `bundle layer` | — | — |
| M14 | broker-call guard removed | `sender primitives`<br>`bundle layer` | — | — |
| M15 | identity check calls Graph | `retired: no fetch`<br>`status surfaces:` | — | — |
| M16 | migration probe uses the WhatsApp token | `retired: no fetch` | `status surfaces:`: the migration probe result feeds the status surface, which then reports a token-derived probe instead of the retired mode | — |
| M17 | reply guard removed | `instant reply:` | — | — |
| M18 | webhook instant reply defaults to on via env | `static: retired onboarding` / "instant reply must not default to on" | — | — |
| M19 | webhook processes inbound messages | `webhook handler:` | — | — |
| M20 | Graph sender guard removed | `sender primitives` | — | — |
| M21 | voice upload guard removed | `sender primitives` | — | — |
| M22 | media download guard removed | `sender primitives` | — | — |
| M23 | outbound adapter guard removed | `outbound adapter` | — | — |
| M24 | release mode not disabled_permanent | `status surfaces:` | — | — |
| M25 | channel status counts WhatsApp | `status surfaces:` | — | — |
| M26 | distribution counts WhatsApp | `status surfaces:` | — | — |
| M27 | projection ignores retirement | `projection:` | — | — |
| M28 | continuity quorum counts the retired channel | `provider independence:` | — | — |
| M29 | onboarding routes alive | `onboarding routes` | — | — |
| M30 | broker tombstone answers 200 | `broker tombstone:` | — | — |
| M31 | instant status defaults to on via env | `status surfaces:`<br>`static: retired onboarding` / "instant reply must not default to on" | — | — |
| M32 | forged webhook generator reintroduced | `static: no forged` | — | — |
| M33 | proof job parked with if:false | `static: retired workflows` | — | — |
| M34 | webhook accepts runtime verify token | `bundle layer` | — | — |
| M35 | social auto-reply path back | `keyword comments, Page feed`<br>`static: no social automation` | — | — |
| M36 | social auto-reply switch back | `static: no social automation` | — | — |
| M37 | social handler claims non-social payloads | `non-social payloads` | — | — |
| M38 | bundle loads the Page token for social | `static: no social automation` | — | — |
| M39 | generator assigns SUPPORT_CHANNEL (strip removed) | `generated candidate config:`<br>`generator source:` | — | — |
| M40 | generator keeps the legacy base alias | `generated candidate config:` | — | — |
| M41 | generator emits ZEVANORY_WHATSAPP_DISPLAY | `generated candidate config:`<br>`generator source:` | — | — |
| M42 | wrangler.toml regains SUPPORT_CHANNEL | `wrangler configs:` | — | — |
| M43 | WHATSAPP_SALES_ENABLED back to "true" | `generated candidate config:` / "retired WhatsApp channel must stay closed"<br>`generator source:` | — | — |
| M44 | wa.me injector not neutralized | `generated public assets:` | `generated candidate config:`: the leftover wa.me makes the generator abort fail-closed, so the config test's exit-status assertion fails | — |
| M45 | public fail-closed scan disabled | `fail-closed: any leftover` | — | — |
| M46 | 9234-0423 number pattern weakened | `fail-closed: any leftover` | `workflows:`: the --workflows scan reuses PUBLIC_WHATSAPP_PATTERNS, so the weakened 9234-0423 pattern also stops flagging the synthetic '+55 (88) 9234 0423' workflow | — |
| M47 | JSON-LD telephone kept | `generated public assets:` | `generated candidate config:`: the leftover telephone makes the generator abort fail-closed, so the config test's exit-status assertion fails | — |
| M48 | public number rewrite map back | `generator source:` / "public number rewrite is gone" | — | — |
| M49 | a workflow assigns ZEVANORY_WHATSAPP_DISPLAY again | `workflows:` | — | — |
