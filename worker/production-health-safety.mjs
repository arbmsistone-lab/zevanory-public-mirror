// Health readiness for a production-configured but owner-closed sales launch.
// This is a readiness classification only. It never authorizes a checkout.
const on = value => String(value ?? "").toLowerCase() === "true";
export function safeClosedCommercialStaging(env = {}, ownerSalesOpen = false, switches = {}) {
  return ownerSalesOpen !== true &&
    switches.SALE_GLOBALLY_ENABLED === false &&
    switches.PRE_SALE_GATES_APPROVED === true &&
    switches.CHECKOUT_ENABLED === true &&
    switches.FINANCIAL_EVENTS_ENABLED === true &&
    (switches.WHATSAPP_SALES_ENABLED === false || switches.WHATSAPP_SALES_ENABLED === true) &&
    on(env.ABSOLUTE_RELEASE_APPROVED) &&
    String(env.MERCADOPAGO_ENV || "").toLowerCase() === "production" &&
    String(env.PAYMENT_PROVIDER || "").toLowerCase() === "mercadopago";
}
