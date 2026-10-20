import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isCheckoutRoute } from "../worker/commercial-checkout-guard.mjs";

const root = new URL("../worker/", import.meta.url);
const recovered = readFileSync(new URL("cloudflare-worker.recovered.mjs", root), "utf8");
const compat = readFileSync(new URL("cloudflare-worker.compat.mjs", root), "utf8");
const guard = readFileSync(new URL("commercial-checkout-guard.mjs", root), "utf8");

const INVENTORY = Object.freeze([
  Object.freeze({ route: "/api/checkout", provider: "seleção Asaas/Mercado Pago/Stripe", preRouting: true, handlers: ["handler11", "handler12", "handleStripeCheckout"] }),
  Object.freeze({ route: "/api/checkout/asaas", provider: "Asaas", preRouting: true, handlers: ["handler11"] }),
  Object.freeze({ route: "/api/checkout/mercadopago", provider: "Mercado Pago", preRouting: true, handlers: ["handler12"] }),
  Object.freeze({ route: "/api/checkout/stripe", provider: "Stripe", preRouting: true, handlers: ["handleStripeCheckout"] }),
  Object.freeze({ route: "/api/subscriptions/arbm-contador", provider: "Mercado Pago (assinatura)", preRouting: false, handlers: ["handler14"] }),
  Object.freeze({ route: "checkout.internal/api/checkout/*", provider: "PSP conforme o caminho", preRouting: true, handlers: ["handler11", "handler12", "handleStripeCheckout"] })
]);

const HANDLER_GATES = Object.freeze({
  handler11: Object.freeze({ name: "salesGate", blocksClosedSales: true }),
  handler12: Object.freeze({ name: "publicCheckoutGate", blocksClosedSales: true }),
  handler14: Object.freeze({ name: "salesGate", blocksClosedSales: true }),
  handleStripeCheckout: Object.freeze({ name: "salesGate", blocksClosedSales: false })
});
const ROUTE_PREFIXES = Object.freeze(["/api/checkout", "/api/checkout/"]);

function findExplicitChargeRoutes(source) {
  const routes = new Set();
  const relevant = /\/(?:checkout|subscriptions?|payments?|comprar|billing)(?:\/|$)/i;
  for (const match of source.matchAll(/url\.pathname\s*===\s*["']([^"']+)["']/g)) {
    if (relevant.test(match[1])) routes.add(match[1]);
  }
  const directHandlers = source.match(/var directHandlers = [\s\S]*?\n\]\);/)?.[0] || "";
  for (const match of directHandlers.matchAll(/\[\s*["']([^"']+)["']\s*,\s*handler\w+\s*\]/g)) {
    if (relevant.test(match[1])) routes.add(match[1]);
  }
  return [...routes].sort();
}

function findChargeRoutePrefixes(source) {
  const prefixes = new Set();
  const relevant = /\/(?:checkout|subscriptions?|payments?|comprar|billing)(?:\/|$)/i;
  for (const match of source.matchAll(/url\.pathname\.startsWith\(["']([^"']+)["']\)/g)) {
    if (relevant.test(match[1])) prefixes.add(match[1]);
  }
  return [...prefixes].sort();
}

function functionBody(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:async )?function ${escapedName}\\([^\\n]*\\) \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `handler ${name} deve existir no worker`);
  return match[1];
}

test("inventário congelado cobre todas as rotas explícitas de cobrança encontradas no Worker", () => {
  const sources = [recovered, compat];
  const discovered = [...new Set(sources.flatMap(findExplicitChargeRoutes))].sort();
  assert.deepEqual(discovered, INVENTORY.filter(({ route }) => route.startsWith("/")).map(({ route }) => route).sort(),
    "nova rota de checkout/assinatura exige atualização explícita do inventário");
  const prefixes = [...new Set(sources.flatMap(findChargeRoutePrefixes))].sort();
  assert.deepEqual(prefixes, [...ROUTE_PREFIXES].sort(),
    "nova família de rotas de cobrança exige atualização explícita do inventário");
});

test("cada rota congelada tem trava pré-roteamento e/ou barreira comercial no handler", () => {
  assert.match(guard, /export function isCheckoutRoute\s*\(/);
  assert.match(guard, /export async function evaluateCheckout\s*\(/);
  assert.match(compat, /import \{\s*isCheckoutRoute,\s*evaluateCheckout/);

  const matcherStart = compat.indexOf("if (isCheckoutRoute(url.pathname))");
  const evaluateCall = compat.indexOf("await evaluateCheckout(normalized, await readSalesSwitch(normalized))", matcherStart);
  const internalDispatch = compat.indexOf('if (url.hostname === "checkout.internal")', matcherStart);
  assert.ok(matcherStart >= 0 && evaluateCall > matcherStart && internalDispatch > evaluateCall,
    "a trava pré-roteamento precisa executar antes da entrada checkout.internal");

  for (const entry of INVENTORY) {
    assert.ok(entry.preRouting || entry.handlers.length > 0,
      `${entry.route} precisa de trava pré-roteamento ou de handler`);
    if (entry.preRouting) {
      const pathname = entry.route.startsWith("checkout.internal/") ? "/api/checkout/" : entry.route;
      assert.equal(isCheckoutRoute(pathname), true, `${entry.route} não é reconhecida por isCheckoutRoute`);
    }
    for (const handler of entry.handlers) {
      const body = functionBody(recovered, handler);
      const gate = HANDLER_GATES[handler];
      assert.ok(gate, `${handler} precisa declarar sua trava no inventário`);
      assert.match(body, new RegExp(`${gate.name}\\(\\)`), `${entry.route} não consulta ${gate.name} em ${handler}`);
      if (gate.blocksClosedSales) {
        assert.match(body, /gate\.enabled/, `${entry.route} não bloqueia vendas fechadas em ${handler}`);
      } else {
        assert.match(body, /gate\.blockers/);
        assert.match(body, /if \(!pilot\.authorized\)/);
      }
    }
  }
});

test("checkout.internal restringe o destino à família /api/checkout protegida antes do despacho", () => {
  const internalStart = compat.indexOf('if (url.hostname === "checkout.internal")');
  assert.ok(internalStart >= 0);
  const internalBlock = compat.slice(internalStart, compat.indexOf("\n    }", internalStart));
  assert.match(internalBlock, /url\.pathname\.startsWith\("\/api\/checkout\/"\)/);
  assert.ok(compat.indexOf("if (isCheckoutRoute(url.pathname))") < internalStart);
});
