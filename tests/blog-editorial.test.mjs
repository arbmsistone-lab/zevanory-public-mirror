import test from "node:test";
import assert from "node:assert/strict";
import { dailyEditorialArticle, editorialCalendar, trigramSimilarity, slugify } from "../worker/blog-editorial.mjs";
import { calendarEntry, validateDraft } from "../worker/acquisition-engine.mjs";
const DAY = 86400000;
const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from + "T00:00:00Z") + i * DAY).toISOString().slice(0, 10));

test("editorial calendar matches the acquisition calendar (same theme every day)", () => {
  for (const d of days("2026-10-01", 80)) {
    const a = editorialCalendar(d), b = calendarEntry(d);
    assert.equal(a.product.sku, b.product.sku, d); assert.equal(a.niche, b.niche, d); assert.equal(a.angle, b.angle, d);
  }
});
test("any two articles within a 45-day window stay below 50% trigram similarity (180 days)", () => {
  const arts = days("2026-10-11", 180).map(d => dailyEditorialArticle(d));
  let max = 0;
  for (let i = 0; i < arts.length; i++) for (let j = Math.max(0, i - 45); j < i; j++) max = Math.max(max, trigramSimilarity(arts[i].body, arts[j].body));
  assert.ok(max < 0.5, "max similarity " + max);
  assert.ok(max < 0.45, "margin below gate: " + max);
});
test("each article has its own title/slug in a cycle, 6 sections, 400–900 words and no unsupported promise", () => {
  const forbidden = /\b(?:lucro garantido|renda garantida|faturamento garantido|ganhe dinheiro|resultado garantido|depoimento real|cliente comprovou)\b/i;
  const arts = days("2026-10-11", 50).map(d => dailyEditorialArticle(d));
  assert.equal(new Set(arts.map(a => a.title)).size, 50);
  assert.equal(new Set(arts.map(a => a.slug)).size, 50);
  for (const a of arts) {
    assert.ok(a.word_count >= 400 && a.word_count <= 900, a.word_count);
    assert.equal((a.body.match(/^## /gm) || []).length, 6);
    assert.doesNotMatch(a.body + a.title + a.description, forbidden);
    assert.match(a.slug, /^[a-z0-9-]+-\d{4}-\d{2}-\d{2}$/);
    assert.ok(a.slug.length <= 110);
    assert.match(a.cta_url, new RegExp("^https://vendas\\.zevanory\\.api\\.br/comprar/" + a.product + "\\?utm_source=blog"));
    assert.equal(a.faq.length, 2);
  }
});
test("article names the calendar product and niche (identity gate)", () => {
  const a = dailyEditorialArticle("2026-10-11"), e = calendarEntry("2026-10-11");
  assert.equal(a.product, e.product.sku);
  assert.ok(a.body.includes(e.product.name) && a.title.includes(e.product.name));
  assert.equal(a.theme_id, e.theme_id);
});
test("slugify normalizes accents and symbols and trims on a word boundary", () => {
  assert.equal(slugify("Lucro & Caixa + IA: ação"), "lucro-e-caixa-mais-ia-acao");
  const long = slugify("palavra ".repeat(40));
  assert.ok(long.length <= 96 && !long.endsWith("-"));
});
test("invalid day fails closed", () => { assert.throws(() => dailyEditorialArticle("11/10/2026")); });
