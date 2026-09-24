import { handleVoiceFinalClosure } from "./voice-final-closure.mjs";
import { handleWhatsappOnboarding, loadWhatsappRuntimeCredentials } from "./whatsapp-onboarding.mjs";
import { handleVoiceStudy } from "./voice-naturality-study.mjs";
import worker from "./cloudflare-worker.recovered.mjs";
import { normalizeEnv } from "./binding-aliases.mjs";
import { buildContinuityPlan, continuityHttpResponse } from "./continuity-router.mjs";
import { handleAdminRequest, isAdminAuthorized } from "./admin-console.mjs";
import { CONTROL_PLANE_VNEXT_JS } from "./control-plane-vnext-source.mjs";
import { handleControlPlaneV2Request, reconcileControlPlane } from "./evidence-control-plane.mjs";
import { handleControlActionRequest } from "./control-action-plane.mjs";
import { handleZea10AutonomyRequest } from "./zea10-autonomy.mjs";
import { handleControlCoreRequest } from "./zevanory-control-core.mjs";

async function loadWhatsappBrokerState(binding) {
  if (!binding?.fetch) return null;
  try {
    const r = await binding.fetch(new Request("https://whatsapp-broker.internal/broker/status", {
      headers: { "x-zevanory-internal": "service-binding" }
    }));
    if (!r.ok) return null;
    const body = await r.json().catch(() => null);
    return body && typeof body === "object" ? Object.freeze(body) : null;
  } catch {
    return null;
  }
}

async function fetchJsonThroughWorker(request, env, ctx) {
  const response = await worker.fetch(request, env, ctx);
  if (!response.ok) return { response, body: null };
  try {
    return { response, body: await response.clone().json() };
  } catch {
    return { response, body: null };
  }
}

function canonicalizePublicPath(request, url) {
  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (url.pathname === "/" || !url.pathname.endsWith("/")) return null;
  if (url.pathname.startsWith("/api/")) return null;

  const target = new URL(url.toString());
  target.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return Response.redirect(target.toString(), 308);
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
    const whatsappRuntime = await loadWhatsappRuntimeCredentials(normalized).catch(()=>null);
    globalThis.__ZEVANORY_WHATSAPP_RUNTIME__ = whatsappRuntime || {};
    globalThis.__ZEVANORY_WHATSAPP_BROKER__ = normalized.WHATSAPP_BROKER || null;
    globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__ = await loadWhatsappBrokerState(normalized.WHATSAPP_BROKER);
    globalThis.__ZEVANORY_WHATSAPP_E2E_STORE__ = normalized.ZEVANORY_PRIVATE_ARTIFACTS || null;
    const canonicalRedirect = canonicalizePublicPath(request, url);
    if (canonicalRedirect) return canonicalRedirect;

    if (
      url.pathname === "/admin/whatsapp-onboard/callback" ||
      (url.pathname === "/admin/whatsapp-onboard/embedded-complete" && request.method === "POST")
    ) {
      const response = await handleWhatsappOnboarding(request, normalized);
      if (response) return response;
    }
    // Narrow public launcher for Meta Embedded Signup. It creates a short-lived
    // broker-backed CSRF state and renders the official Meta JS SDK flow. No
    // credentials are disclosed, and all other onboarding/admin routes remain protected.
    if (url.pathname === "/admin/whatsapp-onboard/start" && request.method === "GET") {
      const response = await handleWhatsappOnboarding(request, normalized);
      if (response) return response;
    }
    if (url.pathname.startsWith("/admin/whatsapp-onboard") || url.pathname === "/api/admin/whatsapp-onboard/status") {
      if (!isAdminAuthorized(request, normalized)) return handleAdminRequest(request, normalized, ctx, wrapped);
      const response = await handleWhatsappOnboarding(request, normalized);
      if (response) return response;
    }

    if (url.pathname === "/api/voice/final-closure") {
      const response = await handleVoiceFinalClosure(request, normalized);
      if (response) return response;
    }

    if (url.pathname === "/voice-study" || url.pathname.startsWith("/api/voice-study/")) {
      const response = await handleVoiceStudy(request, normalized);
      if (response) return response;
    }

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

    if (url.pathname.startsWith("/api/core/v1/")) {
      if (url.pathname.startsWith("/api/core/v1/commands/")) {
        if (!isAdminAuthorized(request, normalized)) {
          return handleAdminRequest(request, normalized, ctx, wrapped);
        }
      }
      return handleControlCoreRequest(request, normalized, ctx, wrapped);
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

    if (url.pathname === "/api/internal/certification/e2e/invite") {
      if (String(request.method || "GET").toUpperCase() !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
      }
      const expected = String(normalized.CERTIFICATION_E2E_TOKEN || "");
      const provided = String(request.headers.get("x-certification-e2e-token") || "");
      const sandbox = String(normalized.CERTIFICATION_PILOT_ENV || "").toLowerCase() === "sandbox";
      const salesClosed = String(normalized.SALE_GLOBALLY_ENABLED || "").toLowerCase() !== "true";
      if (!sandbox || !salesClosed) {
        return new Response(JSON.stringify({ error: "certification_e2e_not_fail_closed" }), {
          status: 409,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
      }
      if (expected.length < 32 || provided !== expected) {
        return new Response(JSON.stringify({ error: "certification_e2e_auth_required" }), {
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
      }
      const operatorToken = String(normalized.OPERATOR_TOKEN || "");
      if (operatorToken.length < 24) {
        return new Response(JSON.stringify({ error: "operator_secret_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
      }
      const internalRequest = new Request(new URL("/api/events/operator", url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${operatorToken}`
        },
        body: JSON.stringify({ name: "certification_pilot_invite_create", ttl_hours: 1 })
      });
      return worker.fetch(internalRequest, normalized, ctx);
    }

    if (url.pathname === "/api/zea10/autonomy") {
      return handleZea10AutonomyRequest(request, normalized, ctx, wrapped);
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
      if (body.policy && typeof body.policy === "object") {
        body.policy = {
          ...body.policy,
          role: "legacy_projection",
          authority: false,
          deprecated_for_decision: true,
          canonical_evaluation: "/api/core/v1/evaluation/zea10"
        };
      }
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("cache-control", "no-store");
      headers.set("x-zevanory-trust-schema", "vnext+legacy-projection");
      headers.set("x-zevanory-state-authority", "ZEVANORY-Control-Core");
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
