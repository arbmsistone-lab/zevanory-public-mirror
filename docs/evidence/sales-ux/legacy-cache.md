# Retired contact script vs. the browser HTTP cache (counterproof, PR #911)

Auditor requirement: Sol 170 (conditional PASS on #911), items 1 to 3.
Harness: `scripts/audit/sales-legacy-cache-proof.mjs`, run on every PR by
`.github/workflows/sales-legacy-cache-proof.yml` (job `sales-legacy-cache / browser-cache-counterproof`,
artifact `sales-legacy-cache-evidence` with the per-step JSON, the server log and the table).

## What was in browsers before this PR

| build | page `Cache-Control` | `/whatsapp-contact.js` `Cache-Control` | script bytes |
|---|---|---|---|
| up to `36f4e2d6` (parent of #892) | `public, max-age=300, stale-while-revalidate=3600, no-transform` (sales-switch pages: `no-store, no-transform`) | `public, max-age=86400, stale-while-revalidate=604800` | injects `wa.me` CTAs (banned number) |
| #892 live (`6f2f0378`, base of this PR) | same | same | e-mail only, but **every page still references the path** |
| this PR | `public, max-age=300, must-revalidate, no-transform` (sales-switch pages unchanged) | `no-store` + `Clear-Site-Data: "cache"`, empty body | `/* retired: intentionally empty */` |

The danger before this PR is the combination "a #892 page (references the path)" plus "the
injector bytes still in the browser cache from before #892 went live" (fresh for 1 day, then served
once more within the 7-day stale-while-revalidate window). The first scenario below shows this.
On a #892 page the cached injector still adds the banned CTAs, with no request to the server.

## Method

There is one localhost origin and one server process. Three builds are switched in place, and each is
served through its own Worker: `injector` = `36f4e2d6`, `base` = `6f2f0378`, `new` = this PR. Each one
uses its committed `sales-public/` and `worker/`. Each scenario gets a fresh persistent Chromium profile
with a real disk cache, and Chrome DevTools Protocol `Network.*` events record where each document and
script came from. The server log records what actually reached the origin.

Expiry is simulated with the HTTP `Age` header on the old responses. A browser counts `Age` as time
already spent in caches (RFC 9111 §4.2.3), so every `Cache-Control` value stays exactly as the old
Worker sent it. The banned number is replaced in the served bytes by `5500000000000`, and the harness
refuses to serve any other 11+ digit run.

The harness fails the run when any of these invariants breaks:

1. A document that does not reference the old path never shows a `wa.me` link or an injected CTA.
2. While the new server is live, any injection comes from a document the browser took from its own
   cache, never from the network.
3. When an old page has passed `max-age=300`, a navigation never uses it, either inside its
   stale-while-revalidate window or after it.
4. After the tombstone is fetched with `Clear-Site-Data`, the next navigations get the new HTML from
   the network. The control run (header stripped) shows that the eviction came from the header.
5. Once the tombstone has been fetched, the old script never runs again.
6. The scenario is not vacuous: the injector really injects, and a #892 page combined with the
   cached injector really injects.

## Results (Chromium 141, Playwright 1.56, local run on 2026-10-24; CI repeats this with Playwright 1.55)

Only the steps after priming are shown. `doc`/`script` give where each one came from.

| scenario | step | server | doc | script | wa.me links | injected CTAs |
|---|---|---|---|---|---|---|
| S1 real headers | #892 live: another #892 page | base | network | browser-cache | 2 | 2 |
| S1 | #892 live: reload (page revalidated, script still from cache) | base | network (304) | browser-cache | 2 | 2 |
| S1 | PR live: unseen page | new | network | not referenced | 0 | 0 |
| S1 | PR live: back to the #892 page | new | browser-cache | browser-cache | 2 | 2 |
| S1 | PR live: reload it | new | network | not referenced | 0 | 0 |
| S1 | PR live: fresh navigation to a #892 page cached < 300 s ago | new | browser-cache | browser-cache | 2 | 2 |
| S1 | PR live: link navigation to a #892 page cached < 300 s ago | new | browser-cache | browser-cache | 0 (page has no CTA anchor) | 0 |
| S1 | PR live: sales-switch page (no-store before and after) | new | network | not referenced | 0 | 0 |
| S2 old page at 302 s (inside SWR 3600) | PR live: navigation | new | network (revalidated) | not referenced | 0 | 0 |
| S3 old page at 3902 s (past SWR) | PR live: navigation | new | network | not referenced | 0 | 0 |
| S4 old script inside its SWR, page fresh | PR live: cached #892 page | new | browser-cache | stale copy + background revalidation, which fetched the tombstone (+CSD) | 2 | 2 |
| S4 | PR live: next navigation, same page | new | **network** (evicted) | not referenced | 0 | 0 |
| S4 | PR live: other cached #892 page | new | **network** (evicted) | not referenced | 0 | 0 |
| S4c same without Clear-Site-Data | PR live: cached #892 page | new | browser-cache | stale copy + background revalidation | 2 | 2 |
| S4c | PR live: next navigation, same page | new | browser-cache (old page) | network (tombstone) | 0 | 0 |
| S4c | PR live: other cached #892 page | new | browser-cache (old page) | network (tombstone) | 0 | 0 |
| S5 script past its whole window | PR live: cached #892 page | new | browser-cache | network (tombstone +CSD) | 0 | 0 |
| S5 | PR live: next navigations | new | **network** (evicted) | not referenced | 0 | 0 |
| S5c same without Clear-Site-Data | PR live: next navigations | new | browser-cache (old page) | network (tombstone) | 0 | 0 |

## Measured residual window

After this PR goes live, a `wa.me` injection can happen only when the browser reuses a pre-PR page
(one that still references the old path) straight from its HTTP cache, and only if it still holds
the injector bytes. That reuse happens on a fresh navigation (typed URL, bookmark, link) or a
back/forward navigation within that page's own `max-age=300`.

* **Upper bound: 300 s after the deploy.** This holds when the old page was fetched just before the
  switch. Chromium does not use `stale-while-revalidate` for navigations. At 302 s it revalidated
  synchronously and rendered the new HTML (S2), so the old `stale-while-revalidate=3600` adds nothing.
* **Reload** always revalidates the document and is clean, even inside the 300 s.
* **Pages not seen before**, and the sales-switch pages, which were always `no-store`, are always clean.
* **Old script inside its stale-while-revalidate window (S4)**: the stale copy runs once more on the
  first such navigation. The background revalidation then fetches the tombstone, and the old bytes
  never run again (S4 and S4c).
* **Not covered by any HTTP header:** a tab that is already showing an old page keeps its DOM until it
  is navigated or reloaded. Back/forward-cache restores in a real Chrome profile are also not covered,
  because Chrome keeps a page in that cache for a few minutes. Playwright served "back" from the HTTP
  cache, so this run did not measure the back/forward cache. Both cases are limited to a tab that
  already had the old page open.
* **Edge:** the sales Worker builds every response, and nothing is stored in Cloudflare's cache, so no
  CDN purge is involved. This is an assumption from the architecture and was not measured here.

When this PR is merged and deployed, it ends the hazard that is live today. On a #892 page a
returning visitor with the cached injector gets the CTAs on every navigation for up to a day. After
the deploy, the exposure is bounded by the 300 s above.

## Clear-Site-Data decision

* **Implemented on the tombstone only:** `Clear-Site-Data: "cache"`. Only an old cached page ever
  requests `/whatsapp-contact.js`, so the header reaches exactly the browsers that hold old bytes.
  In Chromium it dropped the origin's HTTP cache, both the old pages and the old script. The next
  navigations went to the network and got the new HTML (S4 and S5, compared with the S4c and S5c
  controls). It does not shorten the S4 "runs once more" case, because the stale copy has already
  executed by the time the revalidation returns. Browsers without support behave like S4c and S5c:
  the old script still never runs again.
  Scope is enforced by `tests/sales-asset-cache.test.mjs`: the value is `"cache"` only (never cookies or
  storage), and no page, asset, 404 or other route carries the header.
* **Rejected on HTML responses.** The 300 s residual involves no request to the server, so no header
  on any response can reach it. On every page response the header would also wipe the immutable,
  content-hashed assets on every navigation. A time-bounded version would need the deploy date, which
  is outside this PR.
* **Removal:** the tombstone header can be removed 8 days after this Worker is deployed (old script
  max-age of 1 day plus 7 days of stale-while-revalidate). Review date in the code: 2026-12-01.

## Distributed pages that reference the old path (item 3)

* **Sales build (`sales-public/`):** none. `tests/sales-asset-cache.test.mjs` (b) checks every published
  file, the overlay and the page sources, and it limits the repo-wide survivors to an explicit
  allowlist of non-sales files.
* **Main site (zevanory.api.br, central Worker):** the apex build is the frozen `83620c6` `public/`
  snapshot plus `scripts/deploy/prepare-central-candidate.py`. **19 of its 65 files** reference
  `/whatsapp-contact.js`, and the generator publishes an e-mail-only copy at that path. A separate
  draft PR fixes this for the central Worker: it adds the tombstone, stops generating the copy, removes
  the references, and adds tests.
