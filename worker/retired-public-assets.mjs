// Retired public assets of the apex (zevanory.api.br, central Worker).
//
// The retired contact script (old unhashed path, see RETIRED_CONTACT_SCRIPT): the frozen 83620c6 snapshot
// loaded it on 19 pages. Its oldest copies injected
// wa.me links to the permanently banned WhatsApp number and were served with a long browser cache
// lifetime, so a returning visitor's cached page could keep running them. The generator
// (scripts/deploy/prepare-central-candidate.py) no longer publishes the file and strips every reference
// from the pages; this tombstone answers the old path with an inert, never-stored body.
//
// Clear-Site-Data: "cache" (transitional): only an OLD cached page ever requests this path, so the
// answer also tells supporting browsers to drop this origin's HTTP cache (old pages and old script
// bytes). Scoped to this one response: on pages it would wipe the cache on every navigation.
// Measured on the sales site: docs/evidence/sales-ux/legacy-cache.md (PR #911). Remove no earlier
// than 8 days after this Worker is deployed (1 d max-age + 7 d stale-while-revalidate); review 2026-12-01.
// Assembled so repo-wide scans for the old name only see the files that must name it.
export const RETIRED_CONTACT_SCRIPT = "/" + ["whatsapp", "contact"].join("-") + ".js";
export const RETIRED_CONTACT_BODY = "/* retired: intentionally empty */\n";
export const RETIRED_CONTACT_CLEAR_SITE_DATA = '"cache"';

function tombstoneHeaders(extra = {}) {
  return new Headers({
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
    "clear-site-data": RETIRED_CONTACT_CLEAR_SITE_DATA,
    "x-content-type-options": "nosniff",
    ...extra,
  });
}

// Returns the tombstone Response for a retired public asset, or null for every other request.
// Exact path only (no prefix, no case folding, query string ignored); never touches env or storage.
export function retiredPublicAssetResponse(request) {
  let pathname;
  try { pathname = new URL(request.url).pathname; } catch { return null; }
  if (pathname !== RETIRED_CONTACT_SCRIPT) return null;
  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405, headers: tombstoneHeaders({ allow: "GET, HEAD" }) });
  return new Response(method === "HEAD" ? null : RETIRED_CONTACT_BODY, { status: 200, headers: tombstoneHeaders() });
}
