import worker from "./cloudflare-worker.recovered.mjs";
import { normalizeEnv } from "./binding-aliases.mjs";
import { buildContinuityPlan, continuityHttpResponse } from "./continuity-router.mjs";
import { handleAdminRequest, isAdminAuthorized } from "./admin-console.mjs";
import { CONTROL_PLANE_VNEXT_JS } from "./control-plane-vnext-source.mjs";
import { handleControlPlaneV2Request, reconcileControlPlane } from "./evidence-control-plane.mjs";
import { handleControlActionRequest } from "./control-action-plane.mjs";

async function fetchJsonThroughWorker(request, env, ctx) {
  const response = await worker.fetch(request, env, ctx);
  if (!response.ok) return { response, body: null };
  try {
    return { response, body: await response.clone().json() };
  } catch {
    return { response, body: null };
  }
}

function legacyTrustProjection(body) {
  const counts = body?.policy?.counts || {};
  const totalProven = Number(counts.proven || 0);
  const liveReady = body?.zea10_live?.ready === true;
  const liveFailClosed = body?.zea10_live?.fail_closed !== false;
  const commercialEnabled = body?.global_state === "operational_commercial_enabled";
  const green = commercialEnabled && totalProven === 10 && liveReady && !liveFailClosed;

  return {
    state: green ? "GREEN" : "BLOCKED",
    artifact_sha: body?.proof_chain?.sha
      || body?.policy?.release_sha
      || body?.release?.deployment?.commit_sha
      || null,
    evidence_root: null,
    policy_version: body?.policy?.framework || "ZEA-10",
    passed: 0,
    total: 0,
    required: 0,
    conflicts: 0,
    independent_keys: 0,
    engines: [
      {
        id: "zea10-live",
        state: liveReady ? (liveFailClosed ? "FAIL_CLOSED" : "GREEN") : "UNAVAILABLE"
      }
    ],
    ledger: {
      checked_at: body?.zea10_live?.report?.generated_at
        || body?.zea10_live?.report?.checked_at
        || null
    },
    compatibility: {
      source: "control-plane-vnext",
      quorum_available: false,
      claim_scope: body?.policy?.claim_scope || "internal_engineering_alignment_not_external_certification"
    }
  };
}


const wrapped = {
  async fetch(request, env, ctx) {
    const normalized = normalizeEnv(env);
    const url = new URL(request.url);

    if (url.pathname === "/control-plane-vnext.js") {
      return new Response(CONTROL_PLANE_VNEXT_JS, {
        status: 200,
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store, max-age=0",
          "x-content-type-options": "nosniff"
        }
      });
    }

    if (
      url.pathname === "/admin" ||
      url.pathname === "/api/admin/snapshot" ||
      url.pathname.startsWith("/api/admin/control/v2/")
    ) {
      if (url.pathname.startsWith("/api/admin/control/v2/")) {
        if (!isAdminAuthorized(request, normalized)) {
          return handleAdminRequest(request, normalized, ctx, wrapped);
        }
        if (url.pathname.startsWith("/api/admin/control/v2/actions")) {
          return handleControlActionRequest(request, normalized, ctx, wrapped);
        }
        return handleControlPlaneV2Request(request, normalized, ctx, wrapped);
      }
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

    if (url.pathname === "/api/control-plane") {
      const { response, body } = await fetchJsonThroughWorker(request, normalized, ctx);
      if (!response.ok || !body) return response;
      if (!body.trust_chain) body.trust_chain = legacyTrustProjection(body);
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("cache-control", "no-store");
      headers.set("x-zevanory-trust-schema", "vnext+legacy-projection");
      return new Response(JSON.stringify(body), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    return worker.fetch(request, normalized, ctx);
  }
};

wrapped.scheduled = async (controller, env, ctx) => {
  const normalized = normalizeEnv(env);
  const tasks = [reconcileControlPlane(wrapped, normalized, ctx).catch(()=>null)];
  if (typeof worker.scheduled === "function") tasks.push(worker.scheduled(controller, normalized, ctx));
  await Promise.all(tasks);
};
if (typeof worker.queue === "function") {
  wrapped.queue = async (batch, env, ctx) => worker.queue(batch, normalizeEnv(env), ctx);
}
if (typeof worker.email === "function") {
  wrapped.email = async (message, env, ctx) => worker.email(message, normalizeEnv(env), ctx);
}

export default wrapped;
