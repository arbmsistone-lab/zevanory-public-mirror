import { handleFirstOrderWatchReadOnly } from "./first-order-watch-audit.mjs";
import { retiredPublicAssetResponse } from "./retired-public-assets.mjs";
import { legacyTrustProjection, guardTrustChain } from "./trust-projection.mjs";
import { syncProductionActivity } from "./production-activity-sync.mjs";
import { runAcquisitionEngine, acquisitionSnapshot } from "./acquisition-engine.mjs";
import { syncBrandProfiles, brandProfileSnapshot, publicBrandProfileStatus } from "./brand-profiles.mjs";
import { handleOwnerOAuth, handleYoutubePublisherAccess, handlePublisherAccess } from "./owner-oauth.mjs";
import { handleHotmartWebhook, handleBriefing, handlePackageView, retryPendingPackages } from "./content-service.mjs";
import { BRAND_SIZES } from "./brand-kit.mjs";
import { handleVoiceChunk, handleVoiceEncodeAudit, handleVoiceStream } from "./voice-chunks.mjs";
import { handleAsaasPixRefundAuthorization } from "./asaas-pix-refund-auth.mjs";
import { latestWhatsappStage } from "./whatsapp-background.mjs";
import { handleVoiceFinalClosure } from "./voice-final-closure.mjs";
import { handleWhatsappOnboarding, isWhatsappOnboardingPath, loadVoiceGeminiKey } from "./whatsapp-onboarding.mjs";
import { whatsappChannelRetired, whatsappInstantReplyEnabled, whatsappGoneResponse, whatsappWebhookAckResponse, classifyMetaWebhookBody, META_WEBHOOK_CLASSIFY_MAX_BYTES, retiredWhatsappStatus } from "./whatsapp-retirement.mjs";
import { handleVoiceAudit } from "./voice-operational-audit.mjs";
import { handleVoiceStudy } from "./voice-naturality-study.mjs";
import { handleSupportKnowledge } from "./support-knowledge.mjs";
import { handleSiteChat, handleSiteChatAdmin, runSiteChatRetention } from "./site-chat.mjs";
import { validateReply } from "./whatsapp-conversation.mjs";
import { getWhatsappOpsStore } from "./whatsapp-neon-store.mjs";
import worker, { whatsappProofDatabase, runPaidDeliveryWatchdog, runSalesPreflight, loadAiVaultSecret } from "./cloudflare-worker.recovered.mjs";
import { runVoiceEval, VOICE_EVAL_KEY } from "./voice-eval.mjs";
import { synthesizeVoice } from "./voice-remote-tts.mjs";
import { ttsBytesWithFailover, voiceProviderStatus } from "./voice-provider-router.mjs";
import { normalizeEnv } from "./binding-aliases.mjs";
import { withMeteredKv, putBeat } from "./kv-meter.mjs";
import { buildContinuityPlan, continuityHttpResponse } from "./continuity-router.mjs";
import { handleAdminRequest, isAdminAuthorized } from "./admin-console.mjs";
import { CONTROL_PLANE_VNEXT_JS } from "./control-plane-vnext-source.mjs";
import { handleControlPlaneV2Request, readControlState, reconcileControlPlane } from "./evidence-control-plane.mjs";
import { handleControlActionRequest } from "./control-action-plane.mjs";
import { handleZea10AutonomyRequest } from "./zea10-autonomy.mjs";
import { handleControlCoreRequest } from "./zevanory-control-core.mjs";
import { handleSandboxProofV2, handleSandboxInboundEmail } from "./sandbox-proof-v2.mjs";
import { handleSupportInboundWebhook, handleSupportDrainRequest, dispatchSupportDrain } from "./support-email-forward.mjs";
import { handleRefundFlow, runRefundWatchdog } from "./refund-flow.mjs";
import { handlePostSale, runPostSale } from "./post-sale.mjs";
import { handleFunnel, publishFunnelSummary } from "./funnel.mjs";
import { runOwnerAlertDigest, alertFinancialProofStale } from "./owner-alerts.mjs";
import { handleLeadMagnet, runLeadNurture } from "./lead-magnet.mjs";
import { handleWaitlist, runWaitlistNotify } from "./waitlist.mjs";
import { runSupportEvalIfDue } from "./support-eval.mjs";
import { runDataBackup, finalizeBackup, tokenOk as backupTokenOk } from "./data-backup.mjs";
import { handleReviews } from "./reviews.mjs";
import { applySalesSwitch, handleSalesControl, readSalesSwitch, resetSalesSwitchCache } from "./sales-control.mjs";
import { dbEconomySkip } from "./db-economy.mjs";
import { syncOperationalActivity } from "./operational-activity-sync.mjs";
import { projectLiveStatus, projectLocalZea10, whatsappTransportIsOperational } from "./live-runtime-status.mjs";
import { handleInternalFinancialAudit } from "./internal-financial-audit.mjs";
import { readFinancialProofSnapshot, projectProductionOnlyStatus, refreshFinancialProofSnapshot, persistClassificationSnapshot, describeFinancialProofSnapshot, recordLaunchEpoch, PROOF_INVALIDATION_KV_KEY, PROOF_INVALIDATION_REASONS } from "./commercial-metrics-projection.mjs";
import { verifySignedAuditProbe } from "./signed-audit-probe.mjs";
import { isCheckoutRoute, evaluateCheckout, denyCheckout, isProductionPilotBlocked, requiresPilotDenial } from "./commercial-checkout-guard.mjs";
import { verifyOperatorToken } from "./operator-credential.mjs";
import { productionEnvView } from "./production-pilot-guard.mjs";

async function loadWhatsappBrokerState(binding, env) {
  // Retired channel (Meta disabled the WABA on 2026-10-10): never call the broker.
  if (whatsappChannelRetired(env)) return null;
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

const wrapped = {
  async fetch(request, env, ctx) {
    // KV write census (METACLOUD phase A): every write on the shared namespace is logged by prefix.
    let path = "/";
    // Only route words: any segment that could carry an id or token becomes "*" (public census).
    try { path = new URL(request.url).pathname.split("/").slice(0, 4).map((seg) => (seg === "" || /^[a-z][a-z-]{0,23}$/.test(seg) ? seg : "*")).join("/") || "/"; } catch {}
    return wrapped.processFetch(request, withMeteredKv(env, "fetch:" + path), ctx);
  },
  async processFetch(request, env, ctx) {
    // Retired public assets (old contact script): inert, no-store tombstone before any env/KV access.
    const retiredAsset = retiredPublicAssetResponse(request);
    if (retiredAsset) return retiredAsset;
    // R9: fora do perímetro de certificação nenhum CERTIFICATION_PILOT_* chega ao runtime (worker/production-pilot-guard.mjs).
    let normalized = normalizeEnv(productionEnvView(env));
    globalThis.__ZEVANORY_VOICE_SELF__ = normalized.SELF;
    const salesOpenNow = applySalesSwitch(await readSalesSwitch(normalized));
    let url = new URL(request.url);
    if (url.pathname.startsWith("/api/owner/oauth/")) return handleOwnerOAuth(request,normalized);
    // Conteúdo Pronto (Hotmart subscription): authenticated postback + private briefing/package pages.
    if (url.pathname === "/api/webhooks/hotmart") return handleHotmartWebhook(request,normalized,ctx);
    // suporte@/contato@ (e-mail oficial do consumidor): Resend email.received assinado -> encaminha ao dono.
    // Devolve null para outros eventos/destinatários (entregas, prova-sandbox@): o handler legado segue igual.
    if (url.pathname === "/api/webhooks/resend" && request.method === "POST") {
      const support = await handleSupportInboundWebhook(request, normalized, { sqlFactory: whatsappProofDatabase });
      if (support) return support;
    }
    // Dreno do outbox em invocação própria (chamado pelo cron horário via SELF; token HMAC de minuto).
    if (url.pathname === "/api/internal/support/outbox/drain") {
      const drained = await handleSupportDrainRequest(request, normalized, { sqlFactory: whatsappProofDatabase });
      if (drained) return drained;
    }
    if (url.pathname === "/conteudo-pronto/briefing") return handleBriefing(request,normalized,ctx);
    if (url.pathname === "/conteudo-pronto/pacote") return handlePackageView(request,normalized);
    if (url.pathname==="/api/internal/owner/oauth/youtube-access") return handleYoutubePublisherAccess(request,normalized);
    if (url.pathname==="/api/internal/owner/oauth/tiktok-access") return handlePublisherAccess(request,normalized,"tiktok");
    // Daily Short video, published by the Short job for platforms that pull media by URL (Instagram Reels).
    if ((request.method==="GET"||request.method==="HEAD") && /^\/media\/short\/\d{4}-\d{2}-\d{2}(-(dica|calc))?\.mp4$/.test(url.pathname)) {
      const id=url.pathname.slice(13,-4);
      const body=await normalized.ZEVANORY_PRIVATE_ARTIFACTS?.get?.("zpc:media:short:"+id,"arrayBuffer");
      if(!body) return new Response("not found",{status:404,headers:{"cache-control":"no-store"}});
      return new Response(request.method==="HEAD"?null:body,{headers:{"content-type":"video/mp4","content-length":String(body.byteLength),"cache-control":"public, max-age=86400","x-content-type-options":"nosniff","accept-ranges":"none"}});
    }
    // Wrangler has assets.run_worker_first=true. Explicitly delegate the
    // exact, SHA-pinned public brand exports; legacy Worker routing cannot serve them.
    if (url.pathname.startsWith("/brand/export/")) {
      if (request.method !== "GET" && request.method !== "HEAD")return new Response(null,{status:405});
      const name=url.pathname.slice("/brand/export/".length);
      if(!Object.prototype.hasOwnProperty.call(BRAND_SIZES,name))return new Response("not_found",{status:404});
      if(!normalized.ASSETS?.fetch)return new Response("brand_assets_unavailable",{status:503});
      return normalized.ASSETS.fetch(request);
    }
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
      // order-lookup (conciliação somente leitura) devolve só o resultado do SELECT: nada é persistido nem anexado.
      if (audit && audit.status === 200 && url.pathname !== "/api/internal/audit/order-lookup") {
        // Authenticated read-only audit already computed the provider-verified classification:
        // persist the derived snapshot (fail-closed validation) and expose its diagnostic state.
        try {
          const body = await audit.clone().json();
          if (url.pathname.endsWith("/financial-classification")) {
            // A thrown error must be visible to the renewal (it used to be swallowed, leaving sales
            // fail-closed with no reason). Only the error class/message prefix, never data.
            try {
              const persisted = await persistClassificationSnapshot(normalized, { code: 200, result: body }, { sqlFactory: whatsappProofDatabase });
              body.snapshot_persist = persisted.reason;
            } catch (persistError) {
              body.snapshot_persist = "error:" + String(persistError?.name || "Error") + ":" + String(persistError?.message || persistError).replace(/[^\w .:-]/g, " ").slice(0, 80);
            }
          }
          try { body.financial_snapshot = await describeFinancialProofSnapshot(normalized); } catch (describeError) { body.financial_snapshot = { error: String(describeError?.message || describeError).slice(0, 80) }; }
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
    // Lista de espera (worker/waitlist.mjs): INERTE por padrão (WAITLIST_ENABLED !== "true" => 404 antes de banco/KV/rede).
    if (url.pathname === "/lista-de-espera" || url.pathname.startsWith("/lista-de-espera/")) {
      return handleWaitlist(request, normalized, { sqlFactory: whatsappProofDatabase, salesOpen: salesOpenNow });
    }
    if (url.hostname === "leads.internal" || url.pathname.startsWith("/material-gratuito/")) {
      const lead = await handleLeadMagnet(request, normalized, { sqlFactory: whatsappProofDatabase });
      if (lead) return lead;
    }
    // Chat do site (desligado por padrão; worker/site-chat.mjs). Só pelo service binding do Worker de vendas
    // (host chat.internal); a fila do proprietário exige autenticação de administrador.
    if (url.hostname === "chat.internal") {
      const chat = await handleSiteChat(request, normalized, {
        sqlFactory: whatsappProofDatabase,
        // Autoridade canônica de vendas (mesmo /api/sales/status público), consultada a cada resposta.
        salesOpen: async () => {
          const st = await handleSalesControl(new Request("https://zevanory.api.br/api/sales/status", { method: "GET" }), normalized, { sqlFactory: whatsappProofDatabase, worker, ctx });
          return (await st?.json?.())?.open === true;
        }
      });
      return chat || new Response("not_found", { status: 404 });
    }
    if (url.pathname.startsWith("/api/admin/site-chat/")) return handleSiteChatAdmin(request, normalized, { sqlFactory: whatsappProofDatabase, isAdminAuthorized });
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
    const whatsappRetired = whatsappChannelRetired(normalized);
    if (whatsappRetired) {
      // WhatsApp channel retired (Meta permanently disabled WABA 4019600665012911 on 2026-10-10):
      // no WhatsApp credential is loaded, no broker binding is exposed and no broker status is read,
      // on any route. Stale isolate globals are cleared so no legacy code path can pick them up.
      globalThis.__ZEVANORY_WHATSAPP_RUNTIME__ = {};
      globalThis.__ZEVANORY_WHATSAPP_BROKER__ = null;
      globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__ = null;
    }
    if (whatsappPath) {
      // Only the Gemini voice key may come from the old encrypted onboarding record (voice support);
      // the WhatsApp credentials stored next to it are never read.
      const [voiceGeminiKey, whatsappBrokerState] = await Promise.all([
        loadVoiceGeminiKey(normalized).catch(()=>""),
        whatsappRetired ? Promise.resolve(null) : loadWhatsappBrokerState(normalized.WHATSAPP_BROKER, normalized).catch(()=>null)
      ]);
      if (!whatsappRetired) globalThis.__ZEVANORY_WHATSAPP_RUNTIME__ = {};
      globalThis.__ZEVANORY_VOICE_GEMINI_FROM_RECORD__ = Boolean(voiceGeminiKey);
      const overrides = {};
      if (voiceGeminiKey) {
        Object.assign(overrides, {
          GEMINI_API_KEY: voiceGeminiKey,
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
      globalThis.__ZEVANORY_WHATSAPP_BROKER__ = whatsappRetired ? null : (normalized.WHATSAPP_BROKER || null);
      globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__ = whatsappRetired ? null : whatsappBrokerState;
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
      const rt = whatsappRetired ? {} : (globalThis.__ZEVANORY_WHATSAPP_RUNTIME__ || {});
      const candidates = [rt.verify_token, normalized.META_VERIFY_TOKEN, normalized.META_WEBHOOK_VERIFY_TOKEN].map((v) => String(v || "").trim()).filter(Boolean);
      const matched = mode === "subscribe" && Boolean(token) && candidates.includes(token);
      try {
        const kv = normalized.ZEVANORY_PRIVATE_ARTIFACTS;
        if (kv?.put) await kv.put("meta:webhook:last-verify", JSON.stringify({ at: new Date().toISOString(), layer: "edge", mode, token_present: Boolean(token), token_len: token.length, candidates: candidates.length, runtime_token_loaded: Boolean(rt.verify_token), matched, ua: String(request.headers.get("user-agent") || "").slice(0, 80) }), { expirationTtl: 86400 });
      } catch {}
      if (matched) return new Response(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      return new Response(JSON.stringify({ error: "webhook_verification_failed" }), { status: 403, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }

    // Meta webhook: classify the Meta PRODUCT first. Only a proven WhatsApp Business delivery
    // (object "whatsapp_business_account" with WhatsApp fields) gets the retirement acknowledgement:
    // 200 and nothing else (Meta retries non-2xx for days and flags failing subscriptions; 410 has no
    // special meaning for it): no signature check against stored secrets, no processing, no storage,
    // no reply. Instagram/Facebook Page, oversized or unclassifiable deliveries are never silently
    // acknowledged: they continue to the normal Meta handler (signature, size limit, product routing).
    // Legacy WhatsApp-only paths (/webhooks/whatsapp*, /api/whatsapp*) carry no other product.
    if (whatsappRetired && request.method === "POST" && (url.pathname.startsWith("/webhooks/whatsapp") || url.pathname.startsWith("/api/whatsapp"))) {
      return whatsappGoneResponse(url.pathname);
    }
    if (whatsappRetired && request.method === "POST" && (
      url.pathname === "/api/webhooks/meta" ||
      (url.pathname === "/api/webhooks" && String(url.searchParams.get("provider") || "") === "meta")
    )) {
      const declared = Number(request.headers.get("content-length") || 0);
      if (!(declared > META_WEBHOOK_CLASSIFY_MAX_BYTES)) {
        const raw = await request.text().catch(() => "");
        if (classifyMetaWebhookBody(raw) === "whatsapp") return whatsappWebhookAckResponse();
        request = new Request(request.url, { method: "POST", headers: request.headers, body: raw });
      }
    }

    const canonicalRedirect = canonicalizePublicPath(request, url);
    if (canonicalRedirect) return canonicalRedirect;

    const asaasAuthResponse = await handleAsaasPixRefundAuthorization(request, normalized);
    if (asaasAuthResponse) return asaasAuthResponse;

    // Former WhatsApp onboarding surface (Embedded Signup start/callback/complete, bootstrap,
    // finalize and its automatic retry, voice-key, status) and the synthetic "delivery proof"
    // endpoint that built app-secret-signed fake inbound webhooks: removed, 410 Gone for any
    // method and any credential.
    if (isWhatsappOnboardingPath(url.pathname)) return (await handleWhatsappOnboarding(request)) || whatsappGoneResponse(url.pathname);
    // Read-only voice audits (cache/encode/transcribe/encoder-key/source) moved off the retired
    // WhatsApp proof route. No message, no Meta call, no WhatsApp data.
    if (url.pathname === "/api/admin/voice/audit") {
      const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      const presented = String(request.headers.get("authorization") || "").replace(/^Bearer /, "");
      if (!verifyOperatorToken(normalized, presented, { minLength: 24, fallbackToken: normalized.OPERATOR_TOKEN })) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
      const raw = await request.text();
      if (raw.length > 4300000) return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413, headers });
      let input; try { input = JSON.parse(raw); } catch { return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers }); }
      if (!["audit-cache", "audit-encode", "audit-transcribe", "audit-encoder-key", "audit-source"].includes(input?.operation)) return new Response(JSON.stringify({ error: "invalid_operation" }), { status: 400, headers });
      return handleVoiceAudit(input, normalized);
    }

    if (url.pathname === "/api/support/instant-status" && request.method === "GET") {
      const opsStore = getWhatsappOpsStore(normalized, whatsappProofDatabase);
      let last = await latestWhatsappStage(opsStore);
      // Preserve the timestamp and facts of historical text-only records. Null means
      // the old runtime did not record that field; it is not new conversation evidence.
      if (last) last = { mode: null, model: null, text_sent: last.sent ?? false, voice_sent: false, voice_error: null, ...last };
      // Effective commercial state, identical to the public /api/sales/status
      // readback (owner switch + fresh preflight + financial proof + release
      // gates). The deploy var SALE_GLOBALLY_ENABLED is always "false" by design
      // (fail-closed default) and is not the sales state. Read-only.
      let salesEffective = false;
      try {
        const salesStatus = await handleSalesControl(new Request(new URL("/api/sales/status", url), { method: "GET" }), normalized, { sqlFactory: whatsappProofDatabase, worker, ctx });
        salesEffective = (await salesStatus?.json?.())?.open === true;
      } catch { salesEffective = false; }
      return new Response(JSON.stringify({ service: "zevanory-whatsapp-instant-reply", enabled: whatsappInstantReplyEnabled(normalized), whatsapp_channel: whatsappRetired ? retiredWhatsappStatus() : { state: "active" }, ai_binding_present: Boolean(normalized.AI?.run), broker_binding_present: !whatsappRetired && Boolean(normalized.WHATSAPP_BROKER?.fetch), voice_free_only: normalized.VOICE_TTS_FREE_ONLY === "true", gemini_voice_configured: Boolean(globalThis.__ZEVANORY_VOICE_GEMINI_FROM_RECORD__ || String(normalized.GEMINI_API_KEY || "").trim()), sales_globally_enabled: salesEffective, sales_state_source: "/api/sales/status", release_sha: normalized.ZEVANORY_RELEASE_SHA || null, last }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }

    if (url.pathname === "/api/support/knowledge") {
      return handleSupportKnowledge(request, normalized);
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

    if (url.pathname === "/api/public/brand/profiles-status") {
      if (request.method !== "GET") return new Response(null,{status:405});
      return new Response(JSON.stringify(await publicBrandProfileStatus(normalized)),{headers:{"content-type":"application/json","cache-control":"no-store","x-robots-tag":"noindex"}});
    }
    if (url.pathname === "/api/admin/brand/snapshot") {
      if (request.method !== "GET") return new Response(null,{status:405});
      if (!isAdminAuthorized(request, normalized))return new Response(JSON.stringify({error:"admin_auth_required"}),{status:401,headers:{"content-type":"application/json","cache-control":"no-store"}});
      return new Response(JSON.stringify(await brandProfileSnapshot(normalized)),{headers:{"content-type":"application/json","cache-control":"no-store"}});
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
      const provided = String(request.headers.get("x-certification-e2e-token") || "");
      const sandbox = String(normalized.CERTIFICATION_PILOT_ENV || "").toLowerCase() === "sandbox";
      const salesClosed = String(normalized.SALE_GLOBALLY_ENABLED || "").toLowerCase() !== "true" && globalThis.__ZEVANORY_SALES_SWITCH__ !== true;
      if (!sandbox || !salesClosed) {
        return new Response(JSON.stringify({ error: "certification_e2e_not_fail_closed" }), {
          status: 409,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
      }
      if (!verifyOperatorToken(normalized, provided)) {
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

    if (url.pathname === "/api/internal/backup/run") {
      // Runs the backup and restore drill; returns only counts and hashes (never data).
      const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      if (String(request.method || "GET").toUpperCase() !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
      if (!verifyOperatorToken(normalized, request.headers.get("x-backup-token"))) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
      const parts = Math.min(6, Math.max(1, Number(url.searchParams.get("parts") || 3) | 0));
      const report = url.searchParams.get("finalize") === "1"
        ? await finalizeBackup(normalized, { parts })
        : await runDataBackup(normalized, { sqlFactory: whatsappProofDatabase, part: Math.min(parts - 1, Math.max(0, Number(url.searchParams.get("part") || 0) | 0)), parts });
      return new Response(JSON.stringify(report), { status: report.ok ? 200 : 500, headers });
    }

    if (url.pathname === "/api/internal/funnel/run") {
      // Funnel consolidation in its own invocation (own subrequest budget). Aggregates only.
      const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      if (String(request.method || "GET").toUpperCase() !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
      if (!verifyOperatorToken(normalized, request.headers.get("x-backup-token"))) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
      const beat = { at: new Date().toISOString(), source: "http", tasks: {} };
      try {
        const salesOpenNow = applySalesSwitch(await readSalesSwitch(normalized).catch(() => null));
        const out = await publishFunnelSummary(normalized, { sqlFactory: whatsappProofDatabase, production: salesOpenNow, salesOpen: salesOpenNow });
        beat.tasks.funnel = out?.ok === true ? "ok" : "fail:" + String(out?.reason || "unknown").slice(0, 120);
      } catch (error) {
        beat.tasks.funnel = "fail:" + String(error instanceof Error ? error.message : error).replace(/postgres(ql)?:\/\/\S+/g, "[db]").slice(0, 120);
      }
      try { await putBeat(normalized.ZEVANORY_PRIVATE_ARTIFACTS, "zpc:cron:v1:funnel", beat); } catch {}
      return new Response(JSON.stringify(beat), { status: beat.tasks.funnel === "ok" ? 200 : 500, headers });
    }

    if (url.pathname === "/api/internal/voice-eval/run") {
      // End-to-end voice evaluation on the production models; returns and stores scores only.
      const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      if (String(request.method || "GET").toUpperCase() !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
      if (!verifyOperatorToken(normalized, request.headers.get("x-backup-token"))) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
      let apiKey = String(normalized.GEMINI_API_KEY || "").trim();
      // Presence flags only (never values): where the production voice key can come from.
      const diag = { geminiEnv: Boolean(apiKey), vaultRecord: false, vaultMaster: Boolean(normalized.AI_VAULT_ENCRYPTION_KEY || normalized.ELITE_INTERNAL_TOKEN), vaultDecrypted: false, freeOnly: String(normalized.VOICE_TTS_FREE_ONLY || "") === "true", router: null };
      try { diag.vaultRecord = Boolean(await normalized.ZEVANORY_PRIVATE_ARTIFACTS?.get?.("ai-vault:gemini")); } catch {}
      if (!apiKey) { apiKey = String((await loadAiVaultSecret("gemini", { kv: normalized.ZEVANORY_PRIVATE_ARTIFACTS, master: normalized.AI_VAULT_ENCRYPTION_KEY || normalized.ELITE_INTERNAL_TOKEN }).catch(() => null)) || "").trim(); diag.vaultDecrypted = Boolean(apiKey); }
      // Spreading the normalizeEnv proxy drops ZEVANORY_RUNTIME_CONFIG values (e.g.
      // GEMINI_FREE_TIER_CONFIRMED, VOICE_TTS_PROVIDER_CHAIN): delegate through it instead.
      const voiceEnv = new Proxy(normalized, { get: (t, p) => (p === "GEMINI_API_KEY" ? apiKey : t[p]) });
      try { const st = voiceProviderStatus(voiceEnv); diag.router = { chain: st.chain, available: st.providers.filter((x) => x.available).map((x) => x.provider) }; } catch {}
      // Uncached on purpose: a cache hit would hide a broken voice path.
      const synth = (text) => synthesizeVoice(text, { apiKey, env: normalized, kv: null });
      const fallbackSynth = (text) => ttsBytesWithFailover(text, voiceEnv, fetch);
      const report = { ...(await runVoiceEval({ ai: normalized.AI, synth, fallbackSynth })), keySources: diag };
      try { await normalized.ZEVANORY_PRIVATE_ARTIFACTS?.put?.(VOICE_EVAL_KEY, JSON.stringify(report)); } catch {}
      return new Response(JSON.stringify(report), { status: report.ok ? 200 : 500, headers });
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
        whatsappTransportOperational: !whatsappRetired && whatsappTransportIsOperational(normalized, globalThis.__ZEVANORY_WHATSAPP_RUNTIME__, globalThis.__ZEVANORY_WHATSAPP_BROKER_STATE__),
        whatsappRetired
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
        const inv = JSON.parse(String((await normalized.ZEVANORY_PRIVATE_ARTIFACTS?.get?.(PROOF_INVALIDATION_KV_KEY)) || "null"));
        if (inv && typeof inv.at === "string" && !Number.isNaN(Date.parse(inv.at)) && PROOF_INVALIDATION_REASONS.includes(inv.reason)) {
          projected.financial_proof = { ...(projected.financial_proof || {}), last_invalidation: { at: inv.at, reason: inv.reason } };
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
      body.trust_chain = body.trust_chain ? guardTrustChain(body.trust_chain) : legacyTrustProjection(body);
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

wrapped.scheduled = async (controller, rawEnv, ctx) => {
  const env = withMeteredKv(rawEnv, "cron:" + String(controller?.cron || "?"));
  const normalized = normalizeEnv(productionEnvView(env));
  if (controller?.cron === "5,35 * * * *") {
    // Workers Free allows 5 cron triggers per ACCOUNT (all used), so this isolated
    // invocation is shared by tick minute, each with its own subrequest budget:
    //  :05 -> brand profiles (GET readbacks; writes only on verified drift)
    //  :35 -> acquisition (blog 09:35, Telegram 12:35, Bluesky 19:35 Sao Paulo).
    // Acquisition used to run last in the hourly invocation, after nine
    // maintenance tasks had exhausted the 50-subrequest budget.
    const tickMinute = new Date(Number(controller?.scheduledTime) || Date.now()).getUTCMinutes();
    if (tickMinute >= 30) {
      try {
        const out=await runAcquisitionEngine(normalized,new Date());
        console.info("acquisition_cycle",JSON.stringify({ok:out.ok===true,day:out.day||null,channels:(out.outcomes||[]).map(x=>({channel:x.channel,status:x.status,code:x.code||null}))}));
      } catch {
        console.error("acquisition_cycle_failed");
      }
    } else {
    try {
      const brand=await syncBrandProfiles(normalized);
      console.info("brand_profile_cycle",JSON.stringify({statuses:(brand.profiles||[]).map(p=>({channel:p.channel,status:p.status,code:p.code||null}))}));
    } catch {
      console.error("brand_profile_cycle_unverified");
    }
    try {
      const cp=await retryPendingPackages(normalized);
      if(cp?.tried)console.info("content_service_retry",JSON.stringify(cp));
    } catch {
      console.error("content_service_retry_failed");
    }
    }
    const economia = await dbEconomySkip(normalized, controller);
    if (economia) { console.info("db_economy_skip", JSON.stringify({ cron: "5,35", reason: economia })); return; }
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
    } finally {
      // P1-4: deploy, sales switch, refunds, deliveries and downloads in the panel.
      try {
        resetSalesSwitchCache();
        const ops = await syncOperationalActivity(normalized, { sqlFactory: whatsappProofDatabase, salesSwitch: await readSalesSwitch(normalized) });
        console.info("operational_activity_sync", JSON.stringify({ ok: ops.ok === true, emitted: ops.emitted || 0, sections: ops.sections || {} }));
      } catch {
        console.error("operational_activity_sync_failed");
      }
    }
    return;
  }
  // Separate cron invocation: the financial proof must not share a Workers Free
  // subrequest/CPU budget with blog, email, orders and other hourly jobs.
  // The original hourly cron remains fully operational.
  if (controller?.cron === "15,45 * * * *") {
    // This invocation belongs to the financial proof alone (its MP verification uses up to 46 of
    // the 50 subrequests of Workers Free). The funnel moved here on 12/10 starved it: the proof
    // stopped renewing and sales/status went fail-closed. The funnel now runs in its own HTTP
    // invocation (/api/internal/funnel/run, called by the hourly Command Center snapshot).
    const iso = { at: new Date().toISOString(), cron: "15,45 * * * *", tasks: {} };
    const economiaProva = await dbEconomySkip(normalized, controller);
    if (economiaProva) {
      // Batimento continua sendo gravado: o painel distingue "pulado por economia" de "parado".
      iso.tasks.financial_proof = "skipped:" + economiaProva;
      try { await putBeat(normalized.ZEVANORY_PRIVATE_ARTIFACTS, "zpc:cron:v1:isolated", iso); } catch {}
      console.info("db_economy_skip", JSON.stringify({ cron: "15,45", reason: economiaProva }));
      return;
    }
    try {
      const proof = await refreshFinancialProofSnapshot(normalized, {
        sqlFactory: whatsappProofDatabase, force: true
      });
      console.info("commercial_metrics_proof_isolated", JSON.stringify({
        ok: proof.ok === true, reason: proof.reason || "unavailable",
        ambiguous: proof.ambiguous ?? null
      }));
      await normalized.ZEVANORY_PRIVATE_ARTIFACTS?.put?.("zpc:financial-proof:last-isolated-run:v1", JSON.stringify({at:new Date().toISOString(),ok:proof.ok===true}), {expirationTtl:7*86400});
      iso.tasks.financial_proof = proof.ok === true ? "ok" : "fail:" + String(proof.reason || "unavailable").slice(0, 80);
      try { await putBeat(normalized.ZEVANORY_PRIVATE_ARTIFACTS, "zpc:cron:v1:isolated", iso); } catch {}
      if (!proof.ok) {
        console.error("commercial_metrics_proof_isolated_failed", String(proof.reason || "unavailable"));
        throw new Error("financial_proof_not_renewed");
      }
    } catch (error) {
      // Only a fixed category, never raw SQL/HTTP errors or account details.
      console.error("commercial_metrics_proof_isolated_failed", "exception");
      if (!iso.tasks.financial_proof) { iso.tasks.financial_proof = "fail:" + String(error instanceof Error ? error.message : error).replace(/postgres(ql)?:\/\/\S+/g, "[db]").slice(0, 100); try { await putBeat(normalized.ZEVANORY_PRIVATE_ARTIFACTS, "zpc:cron:v1:isolated", iso); } catch {} }
      throw new Error("commercial_metrics_proof_isolated_failed");
    }
    return;
  }
  // suporte@: o dreno do outbox vai PRIMEIRO e numa invocação própria (SELF), antes das tarefas que
  // disputam as 50 subrequisições desta invocação (2026-10-24: retentativas não rodavam no cron).
  let supportOverdue = false;
  await dispatchSupportDrain(normalized, { sqlFactory: whatsappProofDatabase }).then((out) => { supportOverdue = out.result?.overdue === true; console.info("support_outbox", JSON.stringify({ via: out.via, status: out.status ?? null, checked: out.result?.checked ?? null, done: out.result?.done ?? null, pending: out.result?.pending ?? null, dead: out.result?.dead ?? null, backlog: out.result?.backlog ?? null, oldest_min: out.result?.oldest_min ?? null, overdue: supportOverdue })); }).catch(() => console.error("support_outbox_failed", "exception"));
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
  // Heartbeat of the hourly cycle (no data): when it ran and how each tracked task ended.
  const beat = { at: new Date().toISOString(), cron: String(controller?.cron || ""), tasks: {} };
  const mark = (name, ok, why = "") => { beat.tasks[name] = ok ? "ok" : "fail:" + String(why).replace(/postgres(ql)?:\/\/\S+/g, "[db]").slice(0, 120); };
  // The funnel consolidation runs in the isolated "15,45" invocation: in this hourly one it hit
  // "Too many subrequests by single Worker invocation" (Workers Free: 50 per invocation).
  tasks.push(runPaidDeliveryWatchdog(normalized).then((out) => { mark("delivery_watchdog", out?.ok !== false, out?.reason); console.info("paid_delivery_watchdog", JSON.stringify(out)); }).catch((error) => { mark("delivery_watchdog", false, error instanceof Error ? error.message : error); console.error("paid_delivery_watchdog_failed", error instanceof Error ? error.message : String(error)); }));
  tasks.push(runSupportEvalIfDue(normalized).then((out) => console.info("support_eval", JSON.stringify(out))).catch((error) => console.error("support_eval_failed", error instanceof Error ? error.message : String(error))));
  tasks.push(runLeadNurture(normalized, { sqlFactory: whatsappProofDatabase, salesOpen }).then((out) => { mark("nurture", out?.ok !== false, out?.reason); beat.nurture = { checked: Number(out?.checked) || 0, sent: Number(out?.sent) || 0, held: Number(out?.held) || 0 }; console.info("lead_nurture", JSON.stringify(out)); }).catch((error) => { mark("nurture", false, error instanceof Error ? error.message : error); console.error("lead_nurture_failed", error instanceof Error ? error.message : String(error)); }));
  // Aviso da lista de espera: só com WAITLIST_ENABLED=true E vendas abertas (interruptor global); senão nada sai.
  tasks.push(runWaitlistNotify(normalized, { sqlFactory: whatsappProofDatabase, salesOpen }).then((out) => { mark("waitlist", out?.ok !== false, out?.reason); console.info("waitlist_notify", JSON.stringify({ sent: out?.sent || 0, failed: out?.failed || 0, skipped: out?.skipped || out?.reason || null })); }).catch((error) => { mark("waitlist", false, error instanceof Error ? error.message : error); console.error("waitlist_notify_failed", error instanceof Error ? error.message : String(error)); }));
  tasks.push(runOwnerAlertDigest(normalized).then((out) => console.info("owner_alert_digest", JSON.stringify(out))).catch((error) => console.error("owner_alert_digest_failed", error instanceof Error ? error.message : String(error))));
  tasks.push(runRefundWatchdog(normalized, Date.now(), { sqlFactory: whatsappProofDatabase }).then((out) => console.info("refund_watchdog", JSON.stringify(out))).catch((error) => console.error("refund_watchdog_failed", error instanceof Error ? error.message : String(error))));
  // Retenção do chat do site (30 dias / 180 dias após encerramento / contadores 2 dias): uma vez por dia, às 06 UTC.
  if (new Date(Number(controller?.scheduledTime) || Date.now()).getUTCHours() === 6) tasks.push(runSiteChatRetention(normalized, { sqlFactory: whatsappProofDatabase }).then((out) => console.info("site_chat_retention", JSON.stringify(out))).catch(() => console.error("site_chat_retention_failed")));
  tasks.push(runPostSale(normalized, { sqlFactory: whatsappProofDatabase, production: true }).then((out) => console.info("post_sale_run", JSON.stringify(out))).catch((error) => console.error("post_sale_run_failed", error instanceof Error ? error.message : String(error))));
  if (typeof worker.scheduled === "function") tasks.push(worker.scheduled(controller, normalized, ctx));
  await Promise.all(tasks);
  try { await putBeat(normalized.ZEVANORY_PRIVATE_ARTIFACTS, "zpc:cron:v1:hourly", beat); } catch {}
  // Fila do suporte@ vencida: a execução horária termina VERMELHA (depois das demais tarefas).
  if (supportOverdue) { console.error("support_backlog_overdue"); throw new Error("support_backlog_overdue"); }
  // Acquisition (:35) and brand profiles (:05) run in the isolated "5,35" cron.
};
if (typeof worker.queue === "function") {
  wrapped.queue = async (batch, env, ctx) => worker.queue(batch, normalizeEnv(productionEnvView(env)), ctx);
}
wrapped.email = async (message, env, ctx) => {
  const normalized = normalizeEnv(productionEnvView(env));
  if (await handleSandboxInboundEmail(message, normalized)) return;
  if (typeof worker.email === "function") return worker.email(message, normalized, ctx);
  message.setReject?.("mailbox_unavailable");
};

export default wrapped;
