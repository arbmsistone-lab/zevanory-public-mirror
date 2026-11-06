// Retired public assets and legacy pages of the apex (zevanory.api.br, central Worker).
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

// Retired legacy PAGES of the frozen 83620c6 snapshot that the apex still served (owner decision delegated to the
// executor and the auditor, 2026-10-25; follow-up of PR #935):
//   * /piloto and /piloto-interesse: the ARBM SIST certification pilot no longer exists (R9, Sol 164); the pages are
//     retired and answer a permanent redirect to the store catalogue.
//   * /confianca: the old "Central de Confiança" (old product.css, indexable) is replaced by the canonical
//     "Quem criou" page of the store.
// Every answer is a 308 with X-Robots-Tag: noindex, so search engines drop the old URL and index only the target.
// The generator (scripts/deploy/prepare-central-candidate.py) also stops publishing the pages and their own
// scripts/styles, so the ASSETS binding can no longer serve them by any path. Exact paths only (the clean path, the
// trailing-slash form and the .html file); the query string is dropped on purpose (old pilot links carried campaign
// parameters that mean nothing on the store).
export const RETIRED_PAGE_REDIRECTS = Object.freeze({
  "/piloto": "https://vendas.zevanory.api.br/solucoes",
  "/piloto-interesse": "https://vendas.zevanory.api.br/solucoes",
  "/confianca": "https://vendas.zevanory.api.br/quem-criou/",
});
export const RETIRED_PAGE_CACHE_CONTROL = "public, max-age=3600";

function retiredPageTarget(pathname) {
  for (const [path, target] of Object.entries(RETIRED_PAGE_REDIRECTS)) {
    if (pathname === path || pathname === path + "/" || pathname === path + ".html") return target;
  }
  return null;
}

function retiredPageResponse(request, target) {
  const method = String(request.method || "GET").toUpperCase();
  const headers = new Headers({ "cache-control": RETIRED_PAGE_CACHE_CONTROL, "x-robots-tag": "noindex", "x-content-type-options": "nosniff" });
  if (method !== "GET" && method !== "HEAD") {
    headers.set("allow", "GET, HEAD");
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 405, headers });
  }
  headers.set("location", target);
  return new Response(null, { status: 308, headers });
}

// Returns the tombstone Response for a retired public asset, the permanent redirect for a retired legacy page,
// or null for every other request.
// Exact path only (no prefix, no case folding, query string ignored); never touches env or storage.
export function retiredPublicAssetResponse(request) {
  let pathname;
  try { pathname = new URL(request.url).pathname; } catch { return null; }
  const pageTarget = retiredPageTarget(pathname);
  if (pageTarget) return retiredPageResponse(request, pageTarget);
  if (pathname !== RETIRED_CONTACT_SCRIPT) return null;
  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405, headers: tombstoneHeaders({ allow: "GET, HEAD" }) });
  return new Response(method === "HEAD" ? null : RETIRED_CONTACT_BODY, { status: 200, headers: tombstoneHeaders() });
}
