// Our own automation must never become a commercial signal: no order, no checkout intent, no lead.
// Regression guard for PR #789 (the live-buy smoke's POST /comprar created real Mercado Pago orders).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import worker, { BOT_UA } from "../worker/sales-public-worker.mjs";
import { isCountableView } from "../worker/funnel.mjs";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const INTERNAL_UAS = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 ZEVANORY-Monitor/1.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36 zevanory-command-center",
  "Mozilla/5.0 zevanory-audit",
];

function coreEnv() {
  const calls = [];
  return {
    calls,
    env: {
      CORE: {
        async fetch(input, init) {
          const url = String(input && input.url ? input.url : input);
          calls.push(url);
          if (url.endsWith("/api/sales/status")) return Response.json({ open: true });
          if (url.startsWith("https://checkout.internal/")) return Response.json({ checkout_url: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=x" }, { status: 201 });
          if (url.startsWith("https://leads.internal/")) return Response.json({ ok: true, message: "Quase lá! Enviamos um link de confirmação para o seu e-mail." });
          if (url.startsWith("https://funnel.internal/")) return new Response(null, { status: 204 });
          return new Response("{}", { status: 404 });
        },
      },
    },
  };
}
const ctx = { waitUntil() {} };
const post = (path, ua, body) => new Request("https://vendas.zevanory.api.br" + path, { method: "POST", headers: { "user-agent": ua, "cf-connecting-ip": "203.0.113." + Math.floor(Math.random() * 200), ...(body ? { "content-type": "application/x-www-form-urlencoded", referer: "https://vendas.zevanory.api.br/material-gratuito" } : {}) }, body });

test("internal monitors are refused at POST /comprar and never reach checkout creation", async () => {
  for (const ua of INTERNAL_UAS) {
    assert.ok(BOT_UA.test(ua), ua);
    const { env, calls } = coreEnv();
    const res = await worker.fetch(post("/comprar/ZEV-IA-011", ua), env, ctx);
    assert.equal(res.status, 403, ua);
    assert.ok(!calls.some((u) => u.startsWith("https://checkout.internal/")), "checkout created for " + ua);
  }
});

test("a real browser POST still opens the Mercado Pago checkout (303)", async () => {
  const { env, calls } = coreEnv();
  const res = await worker.fetch(post("/comprar/ZEV-IA-011", CHROME), env, ctx);
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /^https:\/\/www\.mercadopago\.com\.br\//);
  assert.equal(calls.filter((u) => u.startsWith("https://checkout.internal/")).length, 1);
  assert.ok(!BOT_UA.test(CHROME));
});

test("internal probes never count as views or checkout intent, even from a residential ASN", () => {
  for (const ua of INTERNAL_UAS) {
    assert.equal(isCountableView({ method: "GET", page: "ia-na-pratica", userAgent: ua, purpose: "", asn: 28573 }), false, ua);
  }
  assert.equal(isCountableView({ method: "GET", page: "ia-na-pratica", userAgent: CHROME, purpose: "", asn: 28573 }), true);
});

test("no workflow sends a POST to the production buy endpoint", () => {
  const dir = ".github/workflows";
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const src = readFileSync(dir + "/" + f, "utf8");
    for (const line of src.split("\n")) {
      if (/vendas\.zevanory\.api\.br\/comprar/.test(line)) assert.doesNotMatch(line, /-X\s*POST|--data|\s-d\s|method:\s*["']?POST/i, f + ": " + line.trim());
    }
  }
});

test("lead thank-you page delivers the checklist right away; internal tools cannot subscribe", async () => {
  const { env, calls } = coreEnv();
  const ok = await worker.fetch(post("/material-gratuito/inscrever", CHROME, "email=pessoa%40example.com&consentimento=sim"), env, ctx);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /href="\/checklist-15-minutos"/);
  assert.equal(calls.filter((u) => u.startsWith("https://leads.internal/")).length, 1);
  const { env: env2, calls: calls2 } = coreEnv();
  const bot = await worker.fetch(post("/material-gratuito/inscrever", INTERNAL_UAS[0], "email=x%40example.com&consentimento=sim"), env2, ctx);
  assert.equal(bot.status, 403);
  assert.ok(!calls2.some((u) => u.startsWith("https://leads.internal/")));
});
