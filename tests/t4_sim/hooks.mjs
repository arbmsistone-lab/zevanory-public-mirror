// T4 local only: lets Node import the production bundle. `cloudflare:node` exists only inside
// Workers; here handleAsNodeRequest forwards to the bundle's own Node http server (server.listen).
const STUB = `
const realFetch = globalThis.fetch;
export async function handleAsNodeRequest(port, request) {
  const url = new URL(request.url);
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  return realFetch("http://127.0.0.1:" + port + url.pathname + url.search, { method: request.method, headers: request.headers, body, redirect: "manual" });
}`;
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:node") return { url: "data:text/javascript," + encodeURIComponent(STUB), shortCircuit: true };
  if (specifier.startsWith("cloudflare:")) return { url: "data:text/javascript,export default {}; export class DurableObject{}; export class WorkerEntrypoint{}; export const env={};", shortCircuit: true };
  return next(specifier, context);
}
