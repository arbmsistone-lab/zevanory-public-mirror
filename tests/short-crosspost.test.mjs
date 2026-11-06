import test from "node:test";
import assert from "node:assert/strict";
import { crosspost, captionFor, publishTikTok, publishInstagramReel } from "../scripts/channels/short-crosspost.mjs";
import { planShort } from "../scripts/channels/youtube-daily-short.mjs";
import { CLOSED_LABEL, SHORT_RULE, hasCheckoutCta, bannedPolicyHits } from "../worker/politica-unica.mjs";
const memKv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, putBinary: async (k, v) => { m.set(k, v); }, list: async () => ({ keys: [] }) }; };
const ok = j => ({ ok: true, status: 200, json: async () => j });

test("without connections every channel waits honestly and nothing is recorded as published", async()=>{
 const kv={get:async()=>null,put:async()=>{}},calls=[];const out=await crosspost({day:"2026-10-12",mp4:Buffer.from("x"),env:{TELEGRAM_BOT_TOKEN:"x",TELEGRAM_CHANNEL_ID:"@zevanory",META_ACCESS_TOKEN:"x",META_PAGE_ID:"1",INSTAGRAM_BUSINESS_ACCOUNT_ID:"2"},kv,salesOpen:false,fetchImpl:async url=>{calls.push(url);throw Error("network forbidden")}});assert.deepEqual(calls,[]);for(const ch of ["tiktok","telegram_video","instagram","facebook"])assert.equal(out[ch],"draft_only_dec22");
});

test("TikTok direct post uses the most private allowed level until the audit, waits for completion", async()=>{
 const calls=[];await assert.rejects(publishTikTok({},Buffer.from("x"),{token:"x",fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("Instagram Reel publishes only after the container is FINISHED", async()=>{
 const calls=[];await assert.rejects(publishInstagramReel({},"https://example.test/video",{token:"x",igId:"x",fetchImpl:async url=>{calls.push(url)}}),/dec22_draft_only/);assert.deepEqual(calls,[]);
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

test("pack renders the tip and the offer for each day with ready captions", async (t) => {
  const { buildPack } = await import("../scripts/channels/short-pack.mjs");
  const { readFile, rm, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  // Diretório único por processo sob os.tmpdir() (antes caminho fixo em /tmp: EPERM ou inexistente no Windows).
  const out = await mkdtemp(join(tmpdir(), "zevanory-pack-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const n = await buildPack({ start: "2026-10-12", days: 3, out, render: async (plan, base) => ({ duration: 14.2, voice: "test", file: base + ".mp4" }) });
  assert.equal(n, 6);
  const txt = await readFile(join(out, "legendas.txt"), "utf8");
  for (const d of ["2026-10-12", "2026-10-13", "2026-10-14"]) { assert.match(txt, new RegExp(d + "\\.mp4")); assert.match(txt, new RegExp(d + "-dica\\.mp4")); }
  assert.ok(txt.includes(CLOSED_LABEL)); assert.equal(hasCheckoutCta(txt), false); assert.match(txt, /Guia gratuito/);
});
test("Telegram channel receives the day's video once, with caption and a provider-confirmed message id", async()=>{
 const kv={get:async()=>null,put:async()=>{}},calls=[];const out=await crosspost({day:"2026-10-12",mp4:Buffer.from("x"),env:{TELEGRAM_BOT_TOKEN:"x",TELEGRAM_CHANNEL_ID:"@zevanory",META_ACCESS_TOKEN:"x",META_PAGE_ID:"1",INSTAGRAM_BUSINESS_ACCOUNT_ID:"2"},kv,salesOpen:false,fetchImpl:async url=>{calls.push(url);throw Error("network forbidden")}});assert.deepEqual(calls,[]);for(const ch of ["tiktok","telegram_video","instagram","facebook"])assert.equal(out[ch],"draft_only_dec22");
});

test("pack produces the executor command ZEVANORY e-mails to the owner: 2 per day (tip 12:00, offer 19:00)", async () => {
  const { executorCommand } = await import("../scripts/channels/short-pack.mjs");
  const cmd = executorCommand("2026-10-22", 10);
  for (let d = 22; d <= 31; d++) { assert.match(cmd, new RegExp(`media/short/2026-10-${d}-dica\\.mp4`)); assert.match(cmd, new RegExp(`media/short/2026-10-${d}\\.mp4`)); assert.match(cmd, new RegExp(`--- ${d}/10 às 12:00`)); assert.match(cmd, new RegExp(`--- ${d}/10 às 19:00`)); }
  assert.match(cmd, /A tua marca/); assert.match(cmd, /Conteúdo gerado por IA/); assert.match(cmd, /Nunca publique na hora/);
});