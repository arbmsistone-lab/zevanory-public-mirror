// Marco B / C2 — one owner per URL. Commercial pages are canonical on vendas.zevanory.api.br (their
// canonicals and the 69-URL sales sitemap already say so); the apex keeps only the blog.
//  * GET / on the apex served a copy of the catalogue whose canonical pointed at a redirecting URL:
//    now a permanent 301 to the canonical catalogue.
//  * /sitemap.xml on the apex listed commercial URLs that redirect: now it lists only apex-owned
//    URLs (the blog index and its articles), so no sitemap entry ever redirects.
import { appendBlogSitemap } from "./multichannel-autonomy.mjs";

export const APEX_HOST = "zevanory.api.br";
export const SALES_CATALOGUE = "https://vendas.zevanory.api.br/solucoes";
const EMPTY = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://zevanory.api.br/blog</loc></url></urlset>';

export async function apexSeoResponse(request, url, env) {
  if (url.hostname !== APEX_HOST) return null;
  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (url.pathname === "/") {
    return new Response(null, { status: 301, headers: { location: SALES_CATALOGUE + url.search, "cache-control": "public, max-age=3600" } });
  }
  if (url.pathname === "/sitemap.xml") {
    const xml = await appendBlogSitemap(env, EMPTY);
    return new Response(method === "HEAD" ? null : xml, { status: 200, headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
  }
  return null;
}
