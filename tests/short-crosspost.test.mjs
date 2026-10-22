import test from "node:test";
import assert from "node:assert/strict";
import { crosspost, captionFor, publishTikTok, publishInstagramReel } from "../scripts/channels/short-crosspost.mjs";
import { planShort } from "../scripts/channels/youtube-daily-short.mjs";
import { CLOSED_LABEL, SHORT_RULE, hasCheckoutCta, bannedPolicyHits } from "../worker/politica-unica.mjs";
const memKv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, putBinary: async (k, v) => { m.set(k, v); }, list: async () => ({ keys: [] }) }; };
const ok = j => ({ ok: true, status: 200, json: async () => j });

test("without connections every channel waits honestly and nothing is recorded as published", async () => {
  const kv = memKv();
  const fetchImpl = async url => url.includes("tiktok-access") ? ok({ connected: false }) : ok({});
  const r = await crosspost({ day: "2026-10-12", mp4: Buffer.from("mp4"), env: { TIKTOK_CLIENT_SECRET: "secret-123456789" }, kv, fetchImpl, sleep: async () => {} });
  assert.equal(r.tiktok, "waiting:tiktok_not_connected");
  assert.equal(r.instagram, "waiting:meta_credentials");
  assert.equal(r.facebook, "waiting:meta_credentials");
  assert.ok(kv.m.has("zpc:media:short:2026-10-12"));
  assert.ok(![...kv.m.keys()].some(k => /daily:2026-10-12:(tiktok|instagram|facebook)/.test(k)));
});

test("TikTok direct post uses the most private allowed level until the audit, waits for completion", async () => {
  const make = expected => { const calls = []; return async (url, o = {}) => {
    calls.push(url);
    if (url.includes("creator_info")) return ok({ data: { privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] }, error: { code: "ok" } });
    if (url.includes("video/init")) { const b = JSON.parse(o.body); assert.equal(b.post_info.privacy_level, expected); assert.equal(b.source_info.source, "FILE_UPLOAD"); return ok({ data: { publish_id: "p1", upload_url: "https://upload.example/x" }, error: { code: "ok" } }); }
    if (url === "https://upload.example/x") return { ok: true, status: 201 };
    if (url.includes("status/fetch")) return ok({ data: { status: calls.filter(c => c.includes("status")).length > 1 ? "PUBLISH_COMPLETE" : "PROCESSING_UPLOAD", publicaly_available_post_id: ["777"] }, error: { code: "ok" } });
  }; };
  const r = await publishTikTok(planShort("2026-10-12"), Buffer.alloc(1000), { token: "t", fetchImpl: make("SELF_ONLY"), sleep: async () => {} });
  assert.equal(r.privacy, "SELF_ONLY"); assert.equal(r.provider_post_id, "777");
  const pub = await publishTikTok(planShort("2026-10-12"), Buffer.alloc(10), { token: "t", audited: true, fetchImpl: make("PUBLIC_TO_EVERYONE"), sleep: async () => {} });
  assert.equal(pub.privacy, "PUBLIC_TO_EVERYONE");
});

test("Instagram Reel publishes only after the container is FINISHED", async () => {
  let polls = 0;
  const fetchImpl = async (url, o = {}) => {
    if (url.endsWith("/media") && o.method === "POST") { const b = JSON.parse(o.body); assert.equal(b.media_type, "REELS"); assert.match(b.video_url, /\/media\/short\/2026-10-12\.mp4$/); return ok({ id: "c1" }); }
    if (url.includes("/c1?fields=status_code")) return ok({ status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" });
    if (url.endsWith("/media_publish")) return ok({ id: "ig9" });
    if (url.includes("/ig9?fields=permalink")) return ok({ permalink: "https://www.instagram.com/reel/abc/" });
  };
  const r = await publishInstagramReel(planShort("2026-10-12"), "https://zevanory.api.br/media/short/2026-10-12.mp4", { token: "t", igId: "17", fetchImpl, sleep: async () => {} });
  assert.equal(r.provider_post_id, "ig9"); assert.equal(polls, 3);
});

test("captions carry the product, the single 7-day rule (open) and channel UTM; TikTok avoids dead links", () => {
  const p = planShort("2026-10-12", { salesOpen: true });
  assert.match(captionFor(p, "instagram", { salesOpen: true }), /utm_source=instagram/);
  assert.match(captionFor(p, "tiktok", { salesOpen: true }), /vendas\.zevanory\.api\.br/);
  assert.doesNotMatch(captionFor(p, "tiktok", { salesOpen: true }), /utm_source/);
  assert.ok(captionFor(p, "facebook", { salesOpen: true }).includes(SHORT_RULE), "regra curta da política única");
  for (const ch of ["instagram", "facebook", "telegram", "tiktok"]) assert.deepEqual(bannedPolicyHits(captionFor(p, ch, { salesOpen: true })), [], ch);
});

test("P13c: com vendas fechadas (padrão) legenda e descrição não têm /comprar/, preço nem regra como chamada", () => {
  const p = planShort("2026-10-12");
  assert.doesNotMatch(p.link + p.description, /\/comprar\//, "link vai para a página do produto");
  assert.ok(p.description.includes(CLOSED_LABEL));
  for (const ch of ["instagram", "facebook", "telegram", "tiktok"]) {
    const c = captionFor(p, ch);
    assert.equal(hasCheckoutCta(c), false, ch);
    assert.ok(c.includes(CLOSED_LABEL), ch);
    assert.doesNotMatch(c, /R\$/, ch);
  }
  // Plano aberto com legenda fechada (mutante: link /comprar/ vazando com vendas fechadas) é barrado.
  assert.throws(() => captionFor(planShort("2026-10-12", { salesOpen: true }), "instagram"), /caption_checkout_cta_while_closed/);
});

test("pack renders the tip and the offer for each day with ready captions", async () => {
  const { buildPack } = await import("../scripts/channels/short-pack.mjs");
  const { readFile, rm } = await import("node:fs/promises");
  const out = "/tmp/zevanory-pack-test";
  await rm(out, { recursive: true, force: true });
  const n = await buildPack({ start: "2026-10-12", days: 3, out, render: async (plan, base) => ({ duration: 14.2, voice: "test", file: base + ".mp4" }) });
  assert.equal(n, 6);
  const txt = await readFile(out + "/legendas.txt", "utf8");
  for (const d of ["2026-10-12", "2026-10-13", "2026-10-14"]) { assert.match(txt, new RegExp(d + "\\.mp4")); assert.match(txt, new RegExp(d + "-dica\\.mp4")); }
  assert.ok(txt.includes(CLOSED_LABEL)); assert.equal(hasCheckoutCta(txt), false); assert.match(txt, /Guia gratuito/);
});
test("Telegram channel receives the day's video once, with caption and a provider-confirmed message id", async () => {
  const kv = memKv(); let sent = 0;
  const fetchImpl = async (url, o = {}) => {
    if (url.includes("tiktok-access")) return ok({ connected: false });
    if (url.includes("/sendVideo")) { sent++; assert.ok(o.body instanceof FormData); assert.ok(o.body.get("caption").includes(CLOSED_LABEL)); assert.equal(hasCheckoutCta(o.body.get("caption")), false); return ok({ ok: true, result: { message_id: 42, chat: { username: "zevanory" } } }); }
    return ok({});
  };
  const env = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHANNEL_ID: "@zevanory" };
  const r1 = await crosspost({ day: "2026-10-12", mp4: Buffer.from("mp4"), env, kv, fetchImpl, sleep: async () => {} });
  assert.equal(r1.telegram_video, "published");
  const r2 = await crosspost({ day: "2026-10-12", mp4: Buffer.from("mp4"), env, kv, fetchImpl, sleep: async () => {} });
  assert.equal(r2.telegram_video, "already_published"); assert.equal(sent, 1);
  assert.match(kv.m.get("zpc:acquisition:daily:2026-10-12:telegram_video"), /t\.me\/zevanory\/42/);
});

test("pack produces the executor command ZEVANORY e-mails to the owner: 2 per day (tip 12:00, offer 19:00)", async () => {
  const { executorCommand } = await import("../scripts/channels/short-pack.mjs");
  const cmd = executorCommand("2026-10-22", 10);
  for (let d = 22; d <= 31; d++) { assert.match(cmd, new RegExp(`media/short/2026-10-${d}-dica\\.mp4`)); assert.match(cmd, new RegExp(`media/short/2026-10-${d}\\.mp4`)); assert.match(cmd, new RegExp(`--- ${d}/10 às 12:00`)); assert.match(cmd, new RegExp(`--- ${d}/10 às 19:00`)); }
  assert.match(cmd, /A tua marca/); assert.match(cmd, /Conteúdo gerado por IA/); assert.match(cmd, /Nunca publique na hora/);
});