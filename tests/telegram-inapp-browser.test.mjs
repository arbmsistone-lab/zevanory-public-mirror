// Telegram's Android in-app browser must not be treated as a bot; Telegram's link-preview robot and
// every other automation must stay blocked. Synthetic UAs only: no orders, no provider calls, no PII.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { isAutomationUA as salesIsAutomation } from "../worker/sales-public-worker.mjs";
import { isAutomationUA as funnelIsAutomation, isCountableView } from "../worker/funnel.mjs";

// Real-world format (user-agents.net catalogue): Chrome WebView UA + "Telegram-Android/<ver> (<device>)".
const TG_ANDROID = "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.135 Mobile Safari/537.36 Telegram-Android/11.9.0 (Samsung SM-A155M; Android 14; SDK 34; AVERAGE)";
const TG_ANDROID_WV = "Mozilla/5.0 (Linux; Android 13; 2201117TG Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Telegram-Android/11.2.0 (Xiaomi 2201117TG; Android 13; SDK 33; HIGH)";
// iOS: Telegram opens links in Safari / SFSafariViewController, i.e. a plain Safari UA.
const TG_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
const HUMANS = { TG_ANDROID, TG_ANDROID_WV, TG_IOS,
  CHROME_ANDROID: "Mozilla/5.0 (Linux; Android 14; SM-A145M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  INSTAGRAM: "Mozilla/5.0 (Linux; Android 13; moto g54) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0 Android",
  DESKTOP: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36" };
const ROBOTS = {
  TELEGRAM_PREVIEW: "TelegramBot (like TwitterBot)",
  WHATSAPP_PREVIEW: "WhatsApp/2.24.20.79 A",
  FACEBOOK_PREVIEW: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  GOOGLEBOT: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  // Spoofing attempts: the Telegram token never launders an automation marker.
  CURL_WITH_TOKEN: "curl/8.5.0 Telegram-Android/11.9.0",
  PYTHON_WITH_TOKEN: "python-requests/2.32 Telegram-Android/11.9.0 (x; Android 14; SDK 34; AVERAGE)",
  DESKTOP_WITH_TOKEN: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36 Telegram-Android/11.9.0",
  HEADLESS_WITH_TOKEN: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/134.0 Mobile Safari/537.36 Telegram-Android/11.9.0 (x; Android 14; SDK 34; AVERAGE)",
  TOKEN_PLUS_BOT: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134 Mobile Safari/537.36 Telegram-Android/11.9.0 (x; Android 14; SDK 34; AVERAGE) TelegramBot",
  INTERNAL_MONITOR: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134 Mobile Safari/537.36 Telegram-Android/11.9.0 ZEVANORY-Monitor/1.0",
  EMPTY: "",
};

test("before/after matrix: humans pass, robots and spoofs stay blocked, same verdict in both Workers", () => {
  for (const [name, ua] of Object.entries(HUMANS)) {
    assert.equal(salesIsAutomation(ua), false, "sales " + name);
    assert.equal(funnelIsAutomation(ua), false, "funnel " + name);
  }
  for (const [name, ua] of Object.entries(ROBOTS)) {
    assert.equal(salesIsAutomation(ua), true, "sales " + name);
    assert.equal(funnelIsAutomation(ua), true, "funnel " + name);
  }
});

test("Telegram Android visitor is counted as a view; Telegram preview robot is not", () => {
  assert.equal(isCountableView({ method: "GET", page: "material-gratuito", userAgent: TG_ANDROID, asn: 28573 }), true);
  assert.equal(isCountableView({ method: "GET", page: "material-gratuito", userAgent: ROBOTS.TELEGRAM_PREVIEW, asn: 28573 }), false);
  // The datacenter-ASN filter still applies to a Telegram UA.
  assert.equal(isCountableView({ method: "GET", page: "material-gratuito", userAgent: TG_ANDROID, asn: 16509 }), false);
});

function core() {
  const calls = [];
  return { calls, env: { CORE: { async fetch(input, init) {
    const url = String(input?.url || input); calls.push(url);
    if (url.endsWith("/api/sales/status")) return Response.json({ open: true });
    if (url.startsWith("https://checkout.internal/")) return Response.json({ checkout_url: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=synthetic" }, { status: 201 });
    if (url.startsWith("https://leads.internal/")) return Response.json({ ok: true, message: "Quase lá! Enviamos um link de confirmação para o seu e-mail." });
    return new Response(null, { status: 204 });
  } } } };
}
const ctx = { waitUntil() {} };
let ip = 10;
const req = (path, ua, form) => new Request("https://vendas.zevanory.api.br" + path, { method: "POST", headers: { "user-agent": ua, "cf-connecting-ip": "198.51.100." + (ip++) }, body: form });
const leadForm = () => { const f = new FormData(); f.set("email", "teste@example.test"); f.set("consentimento", "sim"); return f; };

test("Telegram Android visitor can request the free material and start a purchase (synthetic core, no provider)", async () => {
  let { env, calls } = core();
  let r = await worker.fetch(req("/material-gratuito/inscrever", TG_ANDROID, leadForm()), env, ctx);
  assert.equal(r.status, 200);
  assert.ok(calls.some((u) => u.startsWith("https://leads.internal/")));
  ({ env, calls } = core());
  r = await worker.fetch(req("/comprar/ZEV-IA-011", TG_ANDROID), env, ctx);
  assert.equal(r.status, 303);
  assert.equal(calls.filter((u) => u.startsWith("https://checkout.internal/")).length, 1);
});

test("robots and spoofs still get 403 at purchase and lead form and never reach the core", async () => {
  for (const [name, ua] of Object.entries(ROBOTS)) {
    for (const [path, body] of [["/comprar/ZEV-IA-011", undefined], ["/material-gratuito/inscrever", leadForm()]]) {
      const { env, calls } = core();
      const r = await worker.fetch(req(path, ua, body), env, ctx);
      assert.equal(r.status, 403, name + " " + path);
      assert.ok(!calls.some((u) => u.startsWith("https://checkout.internal/") || u.startsWith("https://leads.internal/")), name);
    }
  }
});
