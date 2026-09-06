export const ARBM_COMMERCIAL_MODEL = Object.freeze({
  zero: Object.freeze({ id:'ARBM_ZERO', price_brl:0, billing:'free', label:'ARBM ZERO', includes:'free_engine' }),
  pro: Object.freeze({ id:'ARBM_PRO', price_brl:1197, billing:'perpetual_license', label:'ARBM PRO', continuity_included_months:12 }),
  continuity: Object.freeze({ id:'ARBM_CONTINUITY', price_brl:79.90, billing:'monthly_from_month_13', label:'Continuity & Intelligence' }),
  boost: Object.freeze({ id:'ARBM_BOOST', price_brl:19.90, billing:'monthly_optional', label:'ARBM BOOST', optional:true }),
  byok: Object.freeze({ id:'BYOK', customer_managed_budget:true, optional:true }),
  zero_cost_firewall:true,
  provider_independence:true,
  sovereign_fallback:'V10',
});

export const PROJECT = Object.freeze({
  name: "ZEVANORY",
  offerId: "ZEV-NGC-011",
  experimentId: "EXP-0001",
  experimentalPriceBrl: 347,
  offerName: "ZEVANORY Negócio Completo",
  offerVersion: "1.1",
  offerType: "digital_product",
  officialWhatsappE164: "558892340423",
});

export function normalizeWhatsappNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!/^55[1-9][0-9]{9,10}$/.test(digits)) return "";
  return digits;
}

export function isOfficialWhatsapp(value) {
  return normalizeWhatsappNumber(value) === PROJECT.officialWhatsappE164;
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}
