// P01 Fase A: regra de decisão pré-registrada (docs/p01/FASE_A_PROTOCOLO.md §5) e intervalo de Wilson.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { wilson, decide, RULE, normalizeContact, isEligibleTraffic } from "../../worker/waitlist.mjs";

const near = (a, b, eps = 5e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("Wilson 95%: valores de referência", () => {
  near(wilson(0, 10).low, 0); near(wilson(0, 10).high, 0.2775);
  near(wilson(5, 10).low, 0.2366); near(wilson(5, 10).high, 0.7634);
  near(wilson(24, 300).low, 0.0543); near(wilson(24, 300).high, 0.1163);
  assert.deepEqual(wilson(0, 0), { low: 0, high: 0 });
});

test("regra: <300 visitantes é INCONCLUSIVO (nunca NO-GO); GO exige conversão >= 8%, Wilson inferior >= 5% e >= 20 leads", () => {
  assert.deepEqual({ ...RULE }, { minVisitors: 300, minConversion: 0.08, minWilsonLow: 0.05, minLeads: 20 });
  assert.equal(decide({ visitors: 299, signups: 200 }), "INCONCLUSIVO");
  assert.equal(decide({ visitors: 0, signups: 0 }), "INCONCLUSIVO");
  assert.equal(decide({ visitors: 299, signups: 0, complianceViolation: true }), "INCONCLUSIVO");
  assert.equal(decide({ visitors: 300, signups: 24 }), "GO");
  assert.equal(decide({ visitors: 300, signups: 23 }), "NO-GO", "7,67% < 8%");
  assert.equal(decide({ visitors: 1000, signups: 80 }), "GO");
  assert.equal(decide({ visitors: 1000, signups: 79 }), "NO-GO");
  assert.equal(decide({ visitors: 300, signups: 30, complianceViolation: true }), "NO-GO", "violação de conformidade impede GO");
  // Wilson inferior < 5% com conversão >= 8% só ocorre com n pequeno, que já é INCONCLUSIVO (< 300);
  // com >= 300 visitantes e 8%, o limite inferior é >= 5,4%: os critérios são coerentes.
  assert.ok(wilson(24, 300).low >= RULE.minWilsonLow);
});

test("protocolo registrado contém exatamente os limiares implementados", () => {
  const doc = fs.readFileSync(new URL("../../docs/p01/FASE_A_PROTOCOLO.md", import.meta.url), "utf8");
  for (const s of ["300 visitantes elegíveis", "≥ 8%", "≥ 5%", "≥ 20", "INCONCLUSIVO", "R$ 27", "R$ 47", "Wilson"]) assert.ok(doc.includes(s), s);
});

test("contato: e-mail e WhatsApp brasileiro normalizados; outros formatos recusados", () => {
  assert.deepEqual(normalizeContact(" Ana@Exemplo.COM "), { kind: "email", value: "ana@exemplo.com" });
  assert.deepEqual(normalizeContact("(88) 99254-0000"), { kind: "whatsapp", value: "5588992540000" });
  assert.deepEqual(normalizeContact("+55 11 3333-4444"), { kind: "whatsapp", value: "551133334444" });
  for (const bad of ["", "abc", "123456", "+1 415 555 0100", "ana@", "<a>@x.com", "5500992540000", "x".repeat(300) + "@a.com"]) assert.equal(normalizeContact(bad), null, bad);
});

test("tráfego elegível = mesmo filtro do funil (UA de automação, ASN de datacenter, prefetch)", () => {
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  assert.equal(isEligibleTraffic({ userAgent: ua, asn: 26599 }), true);
  assert.equal(isEligibleTraffic({ userAgent: ua, asn: 16509 }), false);
  assert.equal(isEligibleTraffic({ userAgent: ua, purpose: "prefetch" }), false);
  assert.equal(isEligibleTraffic({ userAgent: "Mozilla/5.0 (compatible; bingbot/2.0)" }), false);
  assert.equal(isEligibleTraffic({ userAgent: "" }), false);
});
