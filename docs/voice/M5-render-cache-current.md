# M5 — current WhatsApp audio architecture

WhatsApp replies use Render Gemini TTS and MP3 conversion (`render-gemini`) on a cache miss. The Worker signs text, reads/writes the deterministic KV MP3 cache, and forwards audio to Meta. Catalog price, delivery and refund speech is deterministic. Repeats use `voice_cached:true`; they do not call Gemini.

Historical verified delivery: PR #379, deployed SHA `c750488fda84e0a0ba14ea12d8aabc87add12e16`, run `37292205572`, artifact `11337072269`. The first signed inbound proof sent actual WhatsApp audio via `render-gemini` with CPU 37 ms; the second sent actual audio via cache with CPU 38 ms and `voice_cached:true`. This proof remains preserved; it is not synthesized again by the audit. Final-closure retains its independent real inbound/delivery chain and human naturality requirements; this change does not assert a new final-green certificate.

The operational audit reads the seven unique catalog keys only. Missing keys produce SKIP/warning, never synthesis. For present keys it requires `voice_cached:true`, correlated Worker CPU <50 ms, Whisper word error rate <=10%, and identical numeric values (Portuguese number words normalized). Legacy `audit-source` and `audit-encode` return HTTP 410. Final-closure GET retries 503/HTML at most three attempts.

One authorized cycle, after the exact tagged deployment, dispatches the warm workflow exactly once with a seven-call maximum, then dispatches the cache audit and the Combo sandbox proof. A quota response stops warm immediately and preserves written-key evidence. No schedules are introduced. GitHub public repository runners are free; no provider plans or billing settings are changed.

The Combo proof attempts to create a Mercado Pago test buyer; the provider requires a productive credential for test-user creation (40311 with a test credential). An existing productive credential is allowed only for identity creation; all payments keep the test token. A previously configured distinct test buyer may be reused. The proof uses its official test Visa, and creates the payment for the sandbox checkout's exact order/reference and R$297 amount. It requires actual provider webhook reconciliation, internal order `paid` (provider `approved`), Resend email ID and a valid temporary download with matching SHA256. Sandbox delivery goes only to Resend's official `delivered@resend.dev` test sink, not a human inbox; the report identifies this distinction. Payment creation via API is not a browser Checkout Pro interaction. Global sales remain disabled.

Recovery: initial warm dispatch `37295970731` made zero Gemini calls and wrote zero keys; Secret Manager returned BILLING_DISABLED. The corrected warmer reads the already validated free Gemini credential from the Worker over the existing authenticated RSA-OAEP wrapping endpoint. It does not enable GCP billing and does not persist or print the plaintext key. Independent proofs proceed even if warm setup fails.

Executed warm: run `37296880699`, artifact `11339212000`: five new keys (IA197, delivery, refund, Vendas197, Lucro247), Combo297 already present, Negócio Completo397 absent; stopped on quota. No repeat warm is dispatched. Cache repair never calls Gemini and validates every trimmed MP3 before overwriting its existing key. The first repair preserved the cache after a missing ffmpeg runtime; explicit installation corrects that runner dependency.

## Executed readbacks — 2026-10-05 UTC

Production Worker SHA: `0e59ea91f0e88b648b5f6b887aaea5ab1eabbd3d`. Render primary SHA: `c12ebc0df0e6174832752ca2cc51fc7ef7cd0b39`, live deploy `dep-db1nuj8u01pc73fbg1g0`. Public repository SHA after repair merge: `392ce370f81e6d5d76e182b86c892d7580a42ad5` (workflow/script changes; Worker release stays at its audited SHA).

Cache repair run `37300830527`, artifact `11341352671`, repaired six existing MP3s after removing only the spoken style prefix. Original MP3s are retained in that artifact. New synthesis requests: zero. Independent production audit run `37300963506`, artifact `11341323206`, **PASS**: six checked, one cache miss skipped, all numeric values identical, maximum CPU 5 ms, maximum WER 2.86%.

All keys use prefix `voice-cache:v1:`:

| Speech | Key suffix | Warm result | CPU ms | WER |
|---|---|---|---:|---:|
| IA na Prática 197 | 696fa8ecd4f69c15a0a0a562d8fa6697ae6ac48b18f14eedc82c6c19d042d928 | Newly recorded | 5 | 0% |
| Delivery, shared | 0097f78f4157cd04a1ba0ca69a153a2bd296071034244176af8c447f5fdc77c5 | Newly recorded | 3 | 0% |
| Refund, shared | 1bccf25c9c960ebb6dddb2a3540681ca1b2353bc8b7ade026d2b4774fbf08791 | Newly recorded | 3 | 2.86% |
| Vendas na Prática 197 | 6458a9eed3a67aa89c2ad27fdc835186e4e79ca73af9888855c2c2ea32fa549c | Newly recorded | 2 | 0% |
| Lucro & Caixa 247 | 602abcd912395fc970018489c6ccac959e7b17bc79d23dd91c49545c63260bfc | Newly recorded | 2 | 0% |
| Combo IA + Vendas 297 | eddc60865735ae59c5fccb28641583507aca9f3588aa0dc6977d626cbd0ca6ab | Already cached | 2 | 0% |
| Negócio Completo 397 | f675b1170fe0d009e7dad912bc727bc8eedccd9b0d93836d22267265beeb5506 | Absent after quota stop | SKIP | SKIP |

The audited final-closure reports `whatsapp_e2e:true`, actual inbound/outbound `wamid` chain and `delivered` status, architecture `render-gemini+cache`, and the preserved #379 artifact `11337072269`. `final_green:false`: no perceptual study certificate and no exact-release final certificate. No artificial PASS was written for those independent requirements.

Combo sandbox attempt run `37300600028`, artifact `11342051542`, **BLOCKED before checkout or payment**. Seller test-user ID `3670768257`; test credential cannot create a buyer (`40311`: caller must be productive). Existing `MERCADOPAGO_ACCESS_TOKEN` is absent in this runner; configured `MERCADOPAGO_TEST_BUYER_EMAIL` fails the distinct-test-buyer validation. Payment ID: absent. Order ID: absent. Resend email ID: absent. No genuine provider webhook, approved payment or download could therefore be proved. The configured `delivered@resend.dev` destination is an official test sink, not a controlled receiving inbox; do not declare the requested inbox delivery satisfied.

`SALE_GLOBALLY_ENABLED` remains false (`sales_mode:globally-blocked`). No new schedule, billing activation, paid plan or real card was used. The initial Secret Manager warm setup failed before synthesis; the corrected warm cycle ran once and stopped on quota. Recovery repeats were cache repair/read-only audits, not additional warm cycles.
