// 13/10: every blog article linked the free material to a 404 and dropped utm_campaign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBlogArticle, blogCampaign } from "../worker/multichannel-autonomy.mjs";
import { dailyEditorialArticle } from "../worker/blog-editorial.mjs";
import { attribution } from "../worker/sales-public-worker.mjs";

const kvWith = (a) => ({ ZEVANORY_PRIVATE_ARTIFACTS: { get: async (k) => (k === "zpc:blog:article:" + a.slug ? JSON.stringify(a) : null) } });
const html = async (a) => { const r = await renderBlogArticle(kvWith(a), a.slug); return typeof r === "string" ? r : await r.text(); };
const hrefs = (h) => [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));

test("free material link is absolute on the sales domain (the apex path 404s)", async () => {
  const a = dailyEditorialArticle("2026-10-12");
  const links = hrefs(await html(a));
  const free = links.filter((u) => u.includes("material-gratuito"));
  assert.equal(free.length, 1);
  assert.match(free[0], /^https:\/\/vendas\.zevanory\.api\.br\/material-gratuito\?/);
  assert.ok(!links.some((u) => u.startsWith("/material-gratuito")));
});

test("every funnel link keeps a campaign the sales counter accepts (<=48 chars, [a-z0-9_-])", async () => {
  for (const a of [dailyEditorialArticle("2026-10-12"), dailyEditorialArticle("2026-11-30"), { slug: "ia-pratica-pequenos-negocios", title: "t", description: "d", body: "x", url: "https://zevanory.api.br/blog/ia-pratica-pequenos-negocios", product: "ZEV-IA-011" }]) {
    const funnel = hrefs(await html(a)).filter((u) => u.startsWith("https://vendas.zevanory.api.br/"));
    assert.ok(funnel.length >= 4, a.slug);
    for (const u of funnel) {
      const url = new URL(u);
      const { src, camp } = attribution(new Request(u), url);
      assert.equal(src, "blog", u);
      assert.ok(camp.length > 0, "campaign dropped: " + u);
      assert.equal(camp, blogCampaign(a));
    }
  }
  assert.equal(blogCampaign({ day: "2026-10-12", slug: "x" }), "blog_20261012");
});
