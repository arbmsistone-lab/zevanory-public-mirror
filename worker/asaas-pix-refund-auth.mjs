export async function handleAsaasPixRefundAuthorization(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/asaas/withdraw-authorization") return null;
  if (String(request.method || "GET").toUpperCase() !== "POST") {
    return new Response(JSON.stringify({ status: "REFUSED", refuseReason: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  }

  const salesClosed = String(env.SALE_GLOBALLY_ENABLED || "").toLowerCase() !== "true";
  const sandbox = String(env.CERTIFICATION_PILOT_ENV || "").toLowerCase() === "sandbox";
  if (!salesClosed || !sandbox) {
    return new Response(JSON.stringify({ status: "REFUSED", refuseReason: "fail_closed_environment_required" }), {
      status: 409,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  }

  let body = null;
  try { body = await request.json(); } catch {}
  const refund = body?.pixRefund;
  const valid =
    body?.type === "PIX_REFUND" &&
    refund && typeof refund === "object" &&
    Number(refund.value) === 5 &&
    typeof refund.id === "string" && refund.id.length >= 8 &&
    typeof refund.payment === "string" && refund.payment.startsWith("pay_");

  if (!valid) {
    return new Response(JSON.stringify({ status: "REFUSED", refuseReason: "unrecognized_pix_refund" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  }

  return new Response(JSON.stringify({ status: "APPROVED" }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
