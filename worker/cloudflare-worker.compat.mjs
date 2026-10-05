import { handleVoiceChunk, handleVoiceEncodeAudit, handleVoiceStream } from "./voice-chunks.mjs";
import { handleAsaasPixRefundAuthorization } from "./asaas-pix-refund-auth.mjs";
import { latestWhatsappStage } from "./whatsapp-background.mjs";
import { handleVoiceFinalClosure } from "./voice-final-closure.mjs";
import { handleWhatsappOnboarding, loadWhatsappRuntimeCredentials } from "./whatsapp-onboarding.mjs";
import { handleVoiceStudy } from "./voice-naturality-study.mjs";
import { handleSupportKnowledge } from "./support-knowledge.mjs";
import worker, { whatsappProofDatabase } from "./cloudflare-worker.recovered.mjs";
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
    return wrapped.processFetch(request, env, ctx);
  },
  async processFetch(request, env, ctx) {
    let normalized = normalizeEnv(env);
    globalThis.__ZEVANORY_VOICE_SELF__ = normalized.SELF;
    const url = new URL(request.url);
    if(url.pathname==="/internal/voice/encode-chunk"||url.pathname==="/api/internal/voice/encode-chunk") return handleVoiceChunk(request,normalized);
    if(url.pathname==="/api/internal/voice/encode-stream") return handleVoiceStream(request,normalized);
    if(url.pathname==="/api/admin/voice/encode-audit") return handleVoiceEncodeAudit(request,normalized);

    // One administrative surface only: legacy HTML entrypoints permanently
    // converge on the canonical React Control Center. Technical admin APIs stay
    // in this worker for compatibility and Core integration.
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/admin") {
      return Response.redirect("https://controle.zevanory.api.br/", 308);
    }

    // Keep the administrative/control critical path independent from WhatsApp.
    // Broker/credential I/O is intentionally lazy so PIN -> Control Center is not
    // delayed by an unrelated provider or service binding.
    const whatsappPath =
      url.pathname.startsWith("/admin/whatsapp-onboard") ||
      url.pathname.startsWith("/api/admin/whatsapp-onboard") ||
      url.pathname.startsWith("/api/whatsapp") ||
      url.pathname.startsWith("/webhooks/whatsapp") ||
      // Inbound Meta messages and the WhatsApp/voice diagnostics need the stored credentials too.
      url.pathname.startsWith("/api/webhooks") ||
      url.pathname.startsWith("/api/voice") ||
      url.pathname === "/api/support/instant-status" ||
      (url.pathname === "/api/config" && /^(channel_identity_health|closure_status)$/.test(url.searchParams.get("view") || ""));
    if (whatsappPath) {
      const [whatsappRuntime, whatsappBrokerState] = await Promise.all([
        loadWhatsappRuntimeCredentials(normalized).catch(()=>null),
        loadWhatsappBrokerState(normalized.WHATSAPP_BROKER).catch(()=>null)
      ]);
      globalThis.__ZEVANORY_WHATSAPP_RUNTIME__ = whatsappRuntime || {};
      // Credentials verified live by the official onboarding win over legacy Worker vars,
      // which may belong to a previous number/app (Meta answered HTTP 400 with them).
      const overrides = {};
      if (whatsappRuntime?.identity_verified === true && whatsappRuntime.access_token && whatsappRuntime.phone_number_id) {
        Object.assign(overrides, {
          WHATSAPP_ACCESS_TOKEN: whatsappRuntime.access_token,
          WHATSAPP_PHONE_NUMBER_ID: whatsappRuntime.phone_number_id,
          WHATSAPP_BUSINESS_ACCOUNT_ID: whatsappRuntime.waba_id || "",
          META_APP_SECRET: whatsappRuntime.app_secret,
          META_VERIFY_TOKEN: whatsappRuntime.verify_token,
          META_WEBHOOK_VERIFY_TOKEN: whatsappRuntime.verify_token,
          META_GRAPH_VERSION: whatsappRuntime.graph_version || "v26.0"
        });
      }
      if (whatsappRuntime?.gemini_api_key) {
        Object.assign(overrides, {
          GEMINI_API_KEY: whatsappRuntime.gemini_api_key,
          GEMINI_FREE_TIER_CONFIRMED: "true",
          VOICE_TTS_PROVIDER_CHAIN: "gemini,piper-relay"
        });
      }
      if (Object.keys(overrides).length) {
        const base = normalized;
        const own = (k) => Object.prototype.hasOwnProperty.call(overrides, k);
        // Empty extensible target: forwarding to a frozen env would violate Proxy invariants.
        normalized = new Proxy({}, {
          get(_t, prop) { return own(prop) ? overrides[prop] : Reflect.get(base, prop); },
          has(_t, prop) { return own(prop) || Reflect.has(base, prop); },
          ownKeys() { return [...new Set([...Reflect.ownKeys(base), ...Object.keys(overrides)])]; },
          getOwnPropertyDescriptor(_t, prop) {
            if (own(prop)) return { value: overrides[prop], enumerable: true, configurable: true, writable: false };
            const d = Reflect.getOwnPropertyDescriptor(base, prop);
            return d ? { ...d, configurable: true } : undefined;
          }
        });
      }
      globalThis.__ZEVANORY_WHATSAPP_BROKER__ = normalized.WHATSAPP_BROKER || null;
      globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__ = whatsappBrokerState;
      globalThis.__ZEVANORY_WHATSAPP_E2E_STORE__ = normalized.ZEVANORY_PRIVATE_ARTIFACTS || null;
    }
    // Meta webhook verification answered at the edge from the original request URL:
    // the legacy node bridge loses the hub.* query (observed mode="" / no token).
    if (url.pathname === "/api/webhooks/meta" && request.method === "GET") {
      const mode = url.searchParams.get("hub.mode") || "";
      const token = url.searchParams.get("hub.verify_token") || "";
      const challenge = url.searchParams.get("hub.challenge") || "";
      const rt = globalThis.__ZEVANORY_WHATSAPP_RUNTIME__ || {};
      const candidates = [rt.verify_token, normalized.META_VERIFY_TOKEN, normalized.META_WEBHOOK_VERIFY_TOKEN].map((v) => String(v || "").trim()).filter(Boolean);
      const matched = mode === "subscribe" && Boolean(token) && candidates.includes(token);
      try {
        const kv = normalized.ZEVANORY_PRIVATE_ARTIFACTS;
        if (kv?.put) await kv.put("whatsapp:webhook:last-verify", JSON.stringify({ at: new Date().toISOString(), layer: "edge", mode, token_present: Boolean(token), token_len: token.length, candidates: candidates.length, runtime_token_loaded: Boolean(rt.verify_token), matched, ua: String(request.headers.get("user-agent") || "").slice(0, 80) }), { expirationTtl: 86400 });
      } catch {}
      if (matched) return new Response(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      return new Response(JSON.stringify({ error: "webhook_verification_failed" }), { status: 403, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }

    const canonicalRedirect = canonicalizePublicPath(request, url);
    if (canonicalRedirect) return canonicalRedirect;

    const asaasAuthResponse = await handleAsaasPixRefundAuthorization(request, normalized);
    if (asaasAuthResponse) return asaasAuthResponse;

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
    if (url.pathname === "/api/admin/whatsapp-onboard/delivery-proof") return handleWhatsappOnboarding(request, normalized, { proofSql: () => whatsappProofDatabase(normalized.DATABASE_URL) });
    if (url.pathname.startsWith("/admin/whatsapp-onboard") || url.pathname === "/api/admin/whatsapp-onboard/status") {
      if (!isAdminAuthorized(request, normalized)) return handleAdminRequest(request, normalized, ctx, wrapped);
      const response = await handleWhatsappOnboarding(request, normalized);
      if (response) return response;
    }

    if (url.pathname === "/api/support/instant-status" && request.method === "GET") {
      const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
      let last = await latestWhatsappStage(kv);
      // Preserve the timestamp and facts of historical text-only records. Null means
      // the old runtime did not record that field; it is not new conversation evidence.
      if (last) last = { mode: null, model: null, text_sent: last.sent ?? false, voice_sent: false, voice_error: null, ...last };
      return new Response(JSON.stringify({ service: "zevanory-whatsapp-instant-reply", enabled: (env.WHATSAPP_INSTANT_REPLY ?? "true") !== "false", ai_binding_present: Boolean(normalized.AI?.run), broker_binding_present: Boolean(normalized.WHATSAPP_BROKER?.fetch), voice_free_only: normalized.VOICE_TTS_FREE_ONLY === "true", gemini_voice_configured: Boolean(globalThis.__ZEVANORY_WHATSAPP_RUNTIME__?.gemini_api_key), sales_globally_enabled: normalized.SALE_GLOBALLY_ENABLED === "true", release_sha: normalized.ZEVANORY_RELEASE_SHA || null, last }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }

    if (url.pathname === "/api/support/knowledge") {
      return handleSupportKnowledge(request);
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
