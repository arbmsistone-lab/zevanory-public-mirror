import worker from "./cloudflare-worker.recovered.mjs";
import { normalizeEnv } from "./binding-aliases.mjs";
import { buildContinuityPlan, continuityHttpResponse } from "./continuity-router.mjs";
import { handleAdminRequest } from "./admin-console.mjs";

async function fetchJsonThroughWorker(request, env, ctx) {
  const response = await worker.fetch(request, env, ctx);
  if (!response.ok) return { response, body: null };
  try {
    return { response, body: await response.clone().json() };
  } catch {
    return { response, body: null };
  }
}

const wrapped = {
  async fetch(request, env, ctx) {
    const normalized = normalizeEnv(env);
    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname === "/api/admin/snapshot") {
      return handleAdminRequest(request, normalized, ctx, wrapped);
    }

    if (url.pathname === "/api/continuity") {
      const statusUrl = new URL("/api/status", url);
      const statusRequest = new Request(statusUrl, request);
      const { response, body } = await fetchJsonThroughWorker(statusRequest, normalized, ctx);
      if (!response.ok || !body) return response;
      return continuityHttpResponse(body, { minQuorum: 3 });
    }

    if (url.pathname === "/api/status") {
      const { response, body } = await fetchJsonThroughWorker(request, normalized, ctx);
      if (!response.ok || !body) return response;
      body.continuity = buildContinuityPlan(body, { minQuorum: 3 });
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("cache-control", "no-store");
      return new Response(JSON.stringify(body), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    return worker.fetch(request, normalized, ctx);
  }
};

if (typeof worker.scheduled === "function") {
  wrapped.scheduled = async (controller, env, ctx) => worker.scheduled(controller, normalizeEnv(env), ctx);
}
if (typeof worker.queue === "function") {
  wrapped.queue = async (batch, env, ctx) => worker.queue(batch, normalizeEnv(env), ctx);
}
if (typeof worker.email === "function") {
  wrapped.email = async (message, env, ctx) => worker.email(message, normalizeEnv(env), ctx);
}

export default wrapped;
