export const PROJECT = Object.freeze({
  name: "ZEVANORY",
  offerId: "OFFER-0001",
  experimentId: "EXP-0001",
  experimentalPriceBrl: 497,
  officialWhatsappE164: "5588992340423",
});

export function normalizeWhatsappNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!/^55[1-9][0-9]{10}$/.test(digits)) return "";
  return digits;
}

export function isOfficialWhatsapp(value) {
  return normalizeWhatsappNumber(value) === PROJECT.officialWhatsappE164;
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}