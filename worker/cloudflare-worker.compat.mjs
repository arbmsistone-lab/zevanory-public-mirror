import { handleFirstOrderWatchReadOnly } from "./first-order-watch-audit.mjs";
import { syncProductionActivity } from "./production-activity-sync.mjs";
import { runAcquisitionEngine, acquisitionSnapshot } from "./acquisition-engine.mjs";
import { handleVoiceChunk, handleVoiceEncodeAudit, handleVoiceStream } from "./voice-chunks.mjs";
import { handleAsaasPixRefundAuthorization } from "./asaas-pix-refund-auth.mjs";
import { latestWhatsappStage } from "./whatsapp-background.mjs";
import { handleVoiceFinalClosure } from "./voice-final-closure.mjs";
import { handleWhatsappOnboarding, loadWhatsappRuntimeCredentials } from "./whatsapp-onboarding.mjs";
import { handleVoiceStudy } from "./voice-naturality-study.mjs";
import { handleSupportKnowledge } from "./support-knowledge.mjs";
import { validateReply } from "./whatsapp-conversation.mjs";
import { getWhatsappOpsStore } from "./whatsapp-neon-store.mjs";
import worker, { whatsappProofDatabase, runPaidDeliveryWatchdog, runSalesPreflight } from "./cloudflare-worker.recovered.mjs";
import { normalizeEnv } from "./binding-aliases.mjs";
import { buildContinuityPlan, continuityHttpResponse } from "./continuity-router.mjs";
import { handleAdminRequest, isAdminAuthorized } from "./admin-console.mjs";
import { CONTROL_PLANE_VNEXT_JS } from "./control-plane-vnext-source.mjs";
import { handleControlPlaneV2Request, readControlState, reconcileControlPlane } from "./evidence-control-plane.mjs";
import { handleControlActionRequest } from "./control-action-plane.mjs";
import { handleZea10AutonomyRequest } from "./zea10-autonomy.mjs";
import { handleControlCoreRequest } from "./zevanory-control-core.mjs";
import { handleSandboxProofV2, handleSandboxInboundEmail } from "./sandbox-proof-v2.mjs";
import { handleRefundFlow, runRefundWatchdog } from "./refund-flow.mjs";
import { handlePostSale, runPostSale } from "./post-sale.mjs";
import { handleFunnel, publishFunnelSummary } from "./funnel.mjs";
import { runOwnerAlertDigest, alertFinancialProofStale } from "./owner-alerts.mjs";
import { handleLeadMagnet, runLeadNurture } from "./lead-magnet.mjs";
import { handleReviews } from "./reviews.mjs";
import { applySalesSwitch, handleSalesControl, readSalesSwitch, resetSalesSwitchCache } from "./sales-control.mjs";
import { projectLiveStatus, projectLocalZea10, whatsappTransportIsOperational } from "./live-runtime-status.mjs";
import { handleInternalFinancialAudit } from "./internal-financial-audit.mjs";
import { readFinancialProofSnapshot, projectProductionOnlyStatus, refreshFinancialProofSnapshot, persistClassificationSnapshot, describeFinancialProofSnapshot, recordLaunchEpoch } from "./commercial-metrics-projection.mjs";
import { verifySignedAuditProbe } from "./signed-audit-probe.mjs";
import { isCheckoutRoute, evaluateCheckout, denyCheckout, isProductionPilotBlocked, requiresPilotDenial } from "./commercial-checkout-guard.mjs";

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
    applySalesSwitch(await readSalesSwitch(normalized));
    let url = new URL(request.url);
    // Signed probes are accepted only on explicit read-only audit/status routes.
    if (request.headers.has("x-zevanory-audit-ts") || request.headers.has("x-zevanory-audit-signature")) {
      if (!(await verifySignedAuditProbe(request, normalized))) {
        return new Response(JSON.stringify({error:"invalid_audit_signature"}),{status:401,headers:{"content-type":"application/json","cache-control":"no-store"}});
      }
    }
    // HMAC is mandatory even for unsigned GETs: never expose database aggregates anonymously.
    if (url.pathname === "/api/internal/watch/paid-delivery") {
      return handleFirstOrderWatchReadOnly(request, normalized, {sqlFactory: whatsappProofDatabase});
    }
    // Operator-authenticated READ-ONLY audit before legacy routing. Does not mutate commerce.
    if (url.pathname.startsWith("/api/internal/audit/")) {
      const audit = await handleInternalFinancialAudit(request, normalized, { sqlFactory: whatsappProofDatabase });
      if (audit && audit.status === 200) {
        // Authenticated read-only audit already computed the provider-verified classification:
        // persist the derived snapshot (fail-closed validation) and expose its diagnostic state.
        try {
          const body = await audit.clone().json();
          if (url.pathname.endsWith("/financial-classification")) {
            const persisted = await persistClassificationSnapshot(normalized, { code: 200, result: body }, { sqlFactory: whatsappProofDatabase });
            body.snapshot_persist = persisted.reason;
          }
          body.financial_snapshot = await describeFinancialProofSnapshot(normalized);
          const headers = new Headers(audit.headers);
          return new Response(JSON.stringify(body), { status: 200, headers });
        } catch {}
      }
      if (audit) return audit;
      return new Response("not_found",{status:404});
    }
    // Universal pre-routing guard: applies to private service binding and legacy checkout paths.
    if (await requiresPilotDenial(request, normalized)) return denyCheckout("production_certification_pilot_disabled");
    if (isCheckoutRoute(url.pathname)) {
      const pilot = Boolean(request.headers.get("x-certification-pilot-token"));
      if (pilot) {
        if (isProductionPilotBlocked(normalized) ||
            String(normalized.MERCADOPAGO_ENV || "").toLowerCase() !== "sandbox" ||
            String(normalized.CERTIFICATION_PILOT_ENV || "").toLowerCase() !== "sandbox" ||
            String(normalized.SALE_GLOBALLY_ENABLED || "").toLowerCase() === "true" ||
            (await readSalesSwitch(normalized)).enabled === true) {
          return denyCheckout("certification_checkout_not_isolated");
        }
      } else {
        const gate = await evaluateCheckout(normalized, await readSalesSwitch(normalized));
        if (!gate.allowed) return denyCheckout();
      }
    }
    if (url.hostname === "checkout.internal") {
      // Public checkout is only reachable through the sales Worker's private service binding.
      if (!url.pathname.startsWith("/api/checkout/")) return new Response("not_found", { status: 404 });
      request = new Request("https://zevanory.api.br" + url.pathname + url.search, request);
      url = new URL(request.url);
    } else if (url.pathname.startsWith("/api/checkout/") && !request.headers.get("x-certification-pilot-token")) {
      return new Response(JSON.stringify({ error: "checkout_via_sales_page_only", buy: "https://vendas.zevanory.api.br/solucoes" }), { status: 404, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.hostname === "leads.internal" || url.pathname.startsWith("/material-gratuito/")) {
      const lead = await handleLeadMagnet(request, normalized, { sqlFactory: whatsappProofDatabase });
      if (lead) return lead;
    }
    if (url.hostname === "funnel.internal") return (await handleFunnel(request, normalized, { sqlFactory: whatsappProofDatabase, ctx })) || new Response("not_found", { status: 404 });
    if(url.pathname==="/internal/voice/encode-chunk"||url.pathname==="/api/internal/voice/encode-chunk") return handleVoiceChunk(request,normalized);
    if(url.pathname==="/api/internal/voice/encode-stream") return handleVoiceStream(request,normalized);
    if(url.pathname==="/api/admin/voice/encode-audit") return handleVoiceEncodeAudit(request,normalized);
    {
      const refund = await handleRefundFlow(request, normalized, { sqlFactory: whatsappProofDatabase, isAdminAuthorized, worker, ctx });
      if (refund) return refund;
      const postSale = await handlePostSale(request, normalized, { sqlFactory: whatsappProofDatabase, isAdminAuthorized });
      if (postSale) return postSale;
      const reviews = await handleReviews(request, normalized, { sqlFactory: whatsappProofDatabase });
      if (reviews) return reviews;
      const salesControl = await handleSalesControl(request, normalized, { sqlFactory: whatsappProofDatabase, worker, ctx });
      if (salesControl) return salesControl;
    }

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
      url.pathname === "/api/status" ||
      url.pathname === "/api/health" ||
      url.pathname === "/api/continuity" ||
      url.pathname === "/api/control-plane" ||
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
      const whatsappOpsStore = getWhatsappOpsStore(normalized, whatsappProofDatabase);
      globalThis.__ZEVANORY_WHATSAPP_OPS_STORE__ = whatsappOpsStore;
      globalThis.__ZEVANORY_WHATSAPP_E2E_STORE__ = whatsappOpsStore;
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
      const opsStore = getWhatsappOpsStore(normalized, whatsappProofDatabase);
      let last = await latestWhatsappStage(opsStore);
      // Preserve the timestamp and facts of historical text-only records. Null means
      // the old runtime did not record that field; it is not new conversation evidence.
      if (last) last = { mode: null, model: null, text_sent: last.sent ?? false, voice_sent: false, voice_error: null, ...last };
      return new Response(JSON.stringify({ service: "zevanory-whatsapp-instant-reply", enabled: (env.WHATSAPP_INSTANT_REPLY ?? "true") !== "false", ai_binding_present: Boolean(normalized.AI?.run), broker_binding_present: Boolean(normalized.WHATSAPP_BROKER?.fetch), voice_free_only: normalized.VOICE_TTS_FREE_ONLY === "true", gemini_voice_configured: Boolean(globalThis.__ZEVANORY_WHATSAPP_RUNTIME__?.gemini_api_key), sales_globally_enabled: normalized.SALE_GLOBALLY_ENABLED === "true", release_sha: normalized.ZEVANORY_RELEASE_SHA || null, last }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }

    if (url.pathname === "/api/support/knowledge") {
      return handleSupportKnowledge(request);
    }

    if (url.pathname === "/api/support/validate-reply") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "allow": "POST" }
        });
      }
      const body = await request.json().catch(() => ({}));
      const text = typeof body?.text === "string" ? body.text : "";
      const result = validateReply(text);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
      });
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

    // Read-only owner API. Never expose private activity or metrics without admin PIN.
    if (url.pathname === "/api/admin/acquisition/snapshot") {
      if (request.method !== "GET") return new Response(null,{status:405});
      if (!isAdminAuthorized(request, normalized))
        return new Response(JSON.stringify({error:"admin_auth_required"}),{status:401,headers:{"content-type":"application/json","cache-control":"no-store"}});
      const payload=await acquisitionSnapshot(normalized,new Date());
      return new Response(JSON.stringify(payload),{headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
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

    if (url.pathname.startsWith("/api/internal/certification/e2e/") || url.pathname.startsWith("/api/internal/certification/inbox/")) {
      const response = await handleSandboxProofV2(request, normalized, ctx, worker, whatsappProofDatabase);
      if (response) return response;
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
      const salesClosed = String(normalized.SALE_GLOBALLY_ENABLED || "").toLowerCase() !== "true" && globalThis.__ZEVANORY_SALES_SWITCH__ !== true;
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
      const salesSwitch = await readSalesSwitch(normalized);
      const snapshot = await readFinancialProofSnapshot(normalized);
      const safeRelease = snapshot?.verified === true && salesSwitch.enabled === true && salesSwitch.authorized === true &&
        String(normalized.ABSOLUTE_RELEASE_APPROVED || "").toLowerCase() === "true" &&
        String(normalized.PRE_SALE_GATES_APPROVED || "").toLowerCase() === "true" &&
        String(normalized.MERCADOPAGO_ENV || "").toLowerCase() === "production";
      const projected = projectProductionOnlyStatus(projectLiveStatus(body, {
        salesOpen: safeRelease,
        whatsappTransportOperational: whatsappTransportIsOperational(normalized, globalThis.__ZEVANORY_WHATSAPP_RUNTIME__, globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__)
      }), snapshot, { env: normalized, salesRelease: safeRelease });
      projected.sales_authorization = salesSwitch.enabled === true && salesSwitch.authorized === true
        ? { state: safeRelease ? "open_authorized" : "open_authorized_proof_pending", authorized_by_owner: true, at: String(salesSwitch.at || ""), revision: salesSwitch.revision || null }
        : { state: salesSwitch.requested === true ? "requested_blocked" : "closed", authorized_by_owner: false, blocked: salesSwitch.blocked || null, revision: salesSwitch.revision || null };
      projected.continuity = buildContinuityPlan(projected, { minQuorum: 3 });
      try {
        const raw = await normalized.ZEVANORY_PRIVATE_ARTIFACTS?.get?.("zpc:financial-proof:last-isolated-run:v1");
        const evidence = JSON.parse(String(raw || "null"));
        if (evidence && typeof evidence.at === "string" && typeof evidence.ok === "boolean" && !Number.isNaN(Date.parse(evidence.at))) {
          projected.financial_proof = { last_isolated_run: { at: evidence.at, ok: evidence.ok } };
        }
      } catch { /* Missing evidence is never a synthetic success. */ }
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("cache-control", "no-store");
      return new Response(JSON.stringify(projected), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    if (url.pathname === "/api/control-plane") {
      const { response, body } = await fetchJsonThroughWorker(request, normalized, ctx);
      if (!response.ok || !body) return response;
      const releaseSha = body?.release?.deployment?.commit_sha || body?.proof_chain?.sha || null;
      const zees16 = await readControlState(normalized).catch(() => null);
      body.zea10_live = projectLocalZea10(zees16, releaseSha);
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
  if (controller?.cron === "5,35 * * * *") {
    try {
      const out = await syncProductionActivity(normalized, {sqlFactory:whatsappProofDatabase});
      console.info("order13_activity_sync", JSON.stringify({
        ok:out.ok===true,emitted:out.emitted||0,finance:out.finance||0,
        proof_accepted:out.proof_accepted===true
      }));
      if (!out.ok) throw new Error("order13_activity_sync_unavailable");
    } catch {
      // Never log database records, customer references or provider errors.
      console.error("order13_activity_sync_failed");
      throw new Error("order13_activity_sync_failed");
    }
    return;
  }
  // Separate cron invocation: the financial proof must not share a Workers Free
  // subrequest/CPU budget with blog, email, orders and other hourly jobs.
  // The original hourly cron remains fully operational.
  if (controller?.cron === "15,45 * * * *") {
    try {
      const proof = await refreshFinancialProofSnapshot(normalized, {
        sqlFactory: whatsappProofDatabase, force: true
      });
      console.info("commercial_metrics_proof_isolated", JSON.stringify({
        ok: proof.ok === true, reason: proof.reason || "unavailable",
        ambiguous: proof.ambiguous ?? null
      }));
      await normalized.ZEVANORY_PRIVATE_ARTIFACTS?.put?.("zpc:financial-proof:last-isolated-run:v1", JSON.stringify({at:new Date().toISOString(),ok:proof.ok===true}), {expirationTtl:7*86400});
      if (!proof.ok) {
        console.error("commercial_metrics_proof_isolated_failed", String(proof.reason || "unavailable"));
        throw new Error("financial_proof_not_renewed");
      }
    } catch (error) {
      // Only a fixed category, never raw SQL/HTTP errors or account details.
      console.error("commercial_metrics_proof_isolated_failed", "exception");
      throw new Error("commercial_metrics_proof_isolated_failed");
    }
    return;
  }
  await runSalesPreflight(normalized).then((out) => console.info("sales_preflight", JSON.stringify({ ok: out.ok, failed: out.checks.filter((c) => !c.ok).map((c) => c.id) }))).catch((error) => console.error("sales_preflight_failed", error instanceof Error ? error.message : String(error)));
  resetSalesSwitchCache();
  const salesSwitchState = await readSalesSwitch(normalized);
  const salesOpen = applySalesSwitch(salesSwitchState);
  const tasks = [reconcileControlPlane(wrapped, normalized, ctx).catch(()=>null)];
  tasks.push(recordLaunchEpoch(normalized, salesSwitchState)
    .then(() => refreshFinancialProofSnapshot(normalized, { sqlFactory: whatsappProofDatabase }))
    .then(async (out) => {
      console.info("commercial_metrics_proof", JSON.stringify({ok:out.ok===true,reason:out.reason||"unavailable",ambiguous:out.ambiguous??null}));
      if (salesOpen && !(await readFinancialProofSnapshot(normalized))) {
        const alert = await alertFinancialProofStale(normalized, await describeFinancialProofSnapshot(normalized));
        console.error("financial_proof_stale_with_sales_open", JSON.stringify({ alerted: alert.sent === true }));
      }
    })
    .catch(() => console.error("commercial_metrics_proof_unavailable")));
  tasks.push(publishFunnelSummary(normalized, { sqlFactory: whatsappProofDatabase, production: salesOpen, salesOpen }).then((out) => console.info("funnel_summary", JSON.stringify(out))).catch((error) => console.error("funnel_summary_failed", error instanceof Error ? error.message : String(error))));
  tasks.push(runPaidDeliveryWatchdog(normalized).then((out) => console.info("paid_delivery_watchdog", JSON.stringify(out))).catch((error) => console.error("paid_delivery_watchdog_failed", error instanceof Error ? error.message : String(error))));
  tasks.push(runLeadNurture(normalized, { sqlFactory: whatsappProofDatabase, salesOpen }).then((out) => console.info("lead_nurture", JSON.stringify(out))).catch((error) => console.error("lead_nurture_failed", error instanceof Error ? error.message : String(error))));
  tasks.push(runOwnerAlertDigest(normalized).then((out) => console.info("owner_alert_digest", JSON.stringify(out))).catch((error) => console.error("owner_alert_digest_failed", error instanceof Error ? error.message : String(error))));
  tasks.push(runRefundWatchdog(normalized, Date.now(), { sqlFactory: whatsappProofDatabase }).then((out) => console.info("refund_watchdog", JSON.stringify(out))).catch((error) => console.error("refund_watchdog_failed", error instanceof Error ? error.message : String(error))));
  tasks.push(runPostSale(normalized, { sqlFactory: whatsappProofDatabase, production: true }).then((out) => console.info("post_sale_run", JSON.stringify(out))).catch((error) => console.error("post_sale_run_failed", error instanceof Error ? error.message : String(error))));
  if (typeof worker.scheduled === "function") tasks.push(worker.scheduled(controller, normalized, ctx));
  await Promise.all(tasks);
  // The existing Cloudflare hourly cron is the sole ingress for acquisition.
  // Run after legacy scheduled work to prevent competing Telegram/Blog writes.
  if (controller?.cron === "0 * * * *") {
    try {
      const out=await runAcquisitionEngine(normalized,new Date());
      console.info("acquisition_cycle",JSON.stringify({ok:out.ok===true,day:out.day||null,channels:(out.outcomes||[]).map(x=>({channel:x.channel,status:x.status}))}));
    } catch {
      console.error("acquisition_cycle_failed");
    }
  }
};
if (typeof worker.queue === "function") {
  wrapped.queue = async (batch, env, ctx) => worker.queue(batch, normalizeEnv(env), ctx);
}
wrapped.email = async (message, env, ctx) => {
  const normalized = normalizeEnv(env);
  if (await handleSandboxInboundEmail(message, normalized)) return;
  if (typeof worker.email === "function") return worker.email(message, normalized, ctx);
  message.setReject?.("mailbox_unavailable");
};

export default wrapped;
