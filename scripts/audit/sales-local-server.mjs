// Local harness for the sales site: serves a sales-public build THROUGH the real Worker
// (worker/sales-public-worker.mjs), so routing, CSP, Cache-Control and the /whatsapp-contact.js
// tombstone are exactly what production would send. Sales stay closed (no CORE binding).
// Read-only, localhost only, no secrets. Usage:
//   node scripts/audit/sales-local-server.mjs [port=8787] [dir=sales-public] [workerModule]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, normalize, extname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const port = Number(process.argv[2] || 8787);
const dir = resolve(process.argv[3] || join(ROOT, "sales-public"));
const workerPath = resolve(process.argv[4] || join(ROOT, "worker/sales-public-worker.mjs"));
const worker = (await import(pathToFileURL(workerPath).href)).default;

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".json": "application/json" };

// Minimal stand-in for the Workers Static Assets binding (ETag + If-None-Match, 404 otherwise).
const ASSETS = {
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = normalize(join(dir, path));
    if (!file.startsWith(dir)) return new Response("Not found", { status: 404 });
    let body;
    try { body = await readFile(file); } catch { return new Response("Not found", { status: 404 }); }
    const etag = '"' + createHash("sha1").update(body).digest("hex").slice(0, 16) + '"';
    const headers = { "content-type": TYPES[extname(file)] || "application/octet-stream", etag };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(req.method === "HEAD" ? null : body, { status: 200, headers });
  },
};
const env = { ASSETS };
const ctx = { waitUntil() {} };

createServer(async (inc, out) => {
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(inc.headers)) if (typeof v === "string") headers.set(k, v);
    const req = new Request(`http://127.0.0.1:${port}${inc.url}`, { method: inc.method, headers });
    const res = await worker.fetch(req, env, ctx);
    const h = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    out.writeHead(res.status, h);
    out.end(res.body && inc.method !== "HEAD" ? Buffer.from(await res.arrayBuffer()) : undefined);
  } catch (e) {
    out.writeHead(500, { "content-type": "text/plain" });
    out.end("harness error: " + String(e && e.message || e).slice(0, 200));
  }
}).listen(port, "127.0.0.1", () => console.log(`SALES_LOCAL_SERVER=http://127.0.0.1:${port} dir=${dir}`));
