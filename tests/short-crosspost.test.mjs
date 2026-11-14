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
  const r = await crosspost({ day: "2026-10-12", mp4: Buffer.from("mp4"), env: { TIKTOK_CLIENT_SECRET: ["secret", "123456789"].join("-") }, kv, fetchImpl, sleep: async () => {}, metaProva: { teste_permissao_ok: null, prova_instagram_media_id: null, prova_facebook_post_id: null, aprovado_por: null, aprovado_em: null } });
  assert.equal(r.tiktok, "waiting:tiktok_not_connected");
  // DEC-23: sem prova aprovada registrada, IG/FB ficam bloqueados antes de olhar credenciais.
  assert.equal(r.instagram, "bloqueado:dec23_sem_prova");
  assert.equal(r.facebook, "bloqueado:dec23_sem_prova");
  const prova = { teste_permissao_ok: true, prova_instagram_media_id: "1789", prova_facebook_video_id: "1234", aprovado_por: "proprietario", aprovado_em: "2026-11-11" };
  const r2 = await crosspost({ day: "2026-10-12", mp4: Buffer.from("mp4"), env: {}, kv, fetchImpl, sleep: async () => {}, metaProva: prova });
  assert.equal(r2.instagram, "waiting:meta_credentials");
  assert.equal(r2.facebook, "waiting:meta_credentials");
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
  assert.ok(txt.includes(CLOSED_LABEL)); assert.equal(hasCheckoutCta(txt), false); assert.match(txt, /Calculadora gratuita/); assert.doesNotMatch(txt, /whats\s*app|lista de espera/i);
});
test("Telegram DESLIGADO por decisão do proprietário (F0 nº 7): com credenciais presentes, 0 chamadas à API do Telegram; código preservado", async () => {
  const { OWNER_DISABLED_CHANNELS, CHANNEL_DISABLED_CODE, publishTelegramVideo } = await import("../scripts/channels/short-crosspost.mjs");
  assert.deepEqual([...OWNER_DISABLED_CHANNELS], ["telegram"]); assert.ok(Object.isFrozen(OWNER_DISABLED_CHANNELS));
  const kv = memKv(); const telegramCalls = [];
  const fetchImpl = async (url, o = {}) => {
    if (String(url).includes("api.telegram.org")) { telegramCalls.push(String(url)); return ok({ ok: true, result: { message_id: 42, chat: { username: "zevanory" } } }); }
    if (String(url).includes("tiktok-access")) return ok({ connected: false });
    return ok({});
  };
  const env = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHANNEL_ID: "@zevanory" };
  for (const [slot, mode] of [["oferta", {}], ["oferta", { salesOpen: false, hotmartOpen: true }], ["dica", {}], ["calc", {}]]) {
    const r = await crosspost({ day: "2026-10-12", slot, mp4: Buffer.from("mp4"), env, kv, fetchImpl, sleep: async () => {}, ...mode });
    assert.equal(r.telegram_video, "desligado:" + CHANNEL_DISABLED_CODE, slot);
  }
  assert.equal(CHANNEL_DISABLED_CODE, "canal_desligado_decisao_proprietario");
  assert.deepEqual(telegramCalls, [], "nenhuma chamada à API do Telegram");
  assert.equal([...kv.m.keys()].some((k) => k.includes("telegram")), false, "nada gravado no KV pelo canal desligado");
  // O código de publicação continua no arquivo (só não é chamado pelo crosspost).
  const direct = await publishTelegramVideo(planShort("2026-10-12"), Buffer.from("mp4"), { token: "123:abc", chatId: "@zevanory", fetchImpl });
  assert.equal(direct.provider_post_id, "42"); assert.equal(telegramCalls.length, 1);
});

test("pack produces the executor command ZEVANORY e-mails to the owner: 2 per day (tip 12:00, offer 19:00)", async () => {
  const { executorCommand } = await import("../scripts/channels/short-pack.mjs");
  const cmd = executorCommand("2026-10-22", 10);
  for (let d = 22; d <= 31; d++) { assert.match(cmd, new RegExp(`media/short/2026-10-${d}-dica\\.mp4`)); assert.match(cmd, new RegExp(`media/short/2026-10-${d}\\.mp4`)); assert.match(cmd, new RegExp(`--- ${d}/10 às 12:00`)); assert.match(cmd, new RegExp(`--- ${d}/10 às 19:00`)); }
  assert.match(cmd, /A tua marca/); assert.match(cmd, /Conteúdo gerado por IA/); assert.match(cmd, /Nunca publique na hora/);
});
test("NC-01 DEC-23: com META_* presentes e registro sem prova, 0 chamadas à Graph API e nada no KV; com prova aprovada, publica", async () => {
  const { META_PROVA, metaLiberada } = await import("../scripts/channels/short-crosspost.mjs");
  // Registro aprovado pelo proprietário em 14/11/2026 (prova run 43598913328, conferida por ele no IG e no FB).
  assert.equal(metaLiberada(), true);
  assert.deepEqual([META_PROVA.prova_instagram_media_id, META_PROVA.prova_facebook_post_id, META_PROVA.aprovado_por, META_PROVA.aprovado_em], ["18143811337714194", "61593970292684_122134496505465676", "proprietario", "2026-11-14"]);
  const SEM_PROVA = { teste_permissao_ok: null, prova_instagram_media_id: null, prova_facebook_post_id: null, aprovado_por: null, aprovado_em: null };
  assert.equal(metaLiberada(SEM_PROVA), false);
  const env = { META_ACCESS_TOKEN: "tok", INSTAGRAM_BUSINESS_ACCOUNT_ID: "17", META_PAGE_ID: "99" };
  const graph = [];
  const fetchImpl = async (url, o = {}) => {
    const u = String(url);
    if (/graph(-video)?\.facebook\.com/.test(u)) {
      graph.push(u);
      if (u.endsWith("/media") && o.method === "POST") return ok({ id: "c1" });
      if (u.includes("/c1?fields=status_code")) return ok({ status_code: "FINISHED" });
      if (u.endsWith("/media_publish")) return ok({ id: "ig9" });
      if (u.includes("/ig9?fields=permalink")) return ok({ permalink: "https://www.instagram.com/reel/abc/" });
      if (u.includes("/videos")) return ok({ id: "fb7" });
      return ok({});
    }
    return u.includes("tiktok-access") ? ok({ connected: false }) : ok({});
  };
  const kv = memKv();
  const r = await crosspost({ day: "2026-10-12", mp4: Buffer.from("mp4"), env, kv, fetchImpl, sleep: async () => {}, metaProva: SEM_PROVA });
  assert.equal(r.instagram, "bloqueado:dec23_sem_prova"); assert.equal(r.facebook, "bloqueado:dec23_sem_prova");
  assert.deepEqual(graph, [], "nenhuma chamada a graph.facebook.com nem graph-video.facebook.com");
  assert.equal([...kv.m.keys()].some((k) => /instagram|facebook/.test(k)), false);
  for (const bad of [{}, { teste_permissao_ok: true, prova_instagram_media_id: "1", prova_facebook_video_id: "2", aprovado_por: "claude", aprovado_em: "2026-11-11" },
    { teste_permissao_ok: "true", prova_instagram_media_id: "1", prova_facebook_video_id: "2", aprovado_por: "proprietario", aprovado_em: "2026-11-11" },
    { teste_permissao_ok: true, prova_instagram_media_id: "abc", prova_facebook_video_id: "2", aprovado_por: "proprietario", aprovado_em: "2026-11-11" },
    { teste_permissao_ok: true, prova_instagram_media_id: "1", prova_facebook_video_id: "2", aprovado_por: "proprietario", aprovado_em: "11/11/2026" }]) assert.equal(metaLiberada(bad), false, JSON.stringify(bad));
  const prova = { teste_permissao_ok: true, prova_instagram_media_id: "1789", prova_facebook_video_id: "1234", aprovado_por: "proprietario", aprovado_em: "2026-11-11" };
  const kv2 = memKv();
  const ok2 = await crosspost({ day: "2026-10-12", mp4: Buffer.from("mp4"), env, kv: kv2, fetchImpl, sleep: async () => {}, metaProva: prova });
  assert.equal(ok2.instagram, "published"); assert.equal(ok2.facebook, "published"); assert.ok(graph.length > 0);
});

test("NC-02: o cross-post só roda com o Short do slot PÚBLICO no YouTube e o canal não congelado (formato real do recordPublication)", async () => {
  const { youtubePublicoENaoCongelado } = await import("../scripts/channels/short-crosspost.mjs");
  const { recordPublication, planSlot } = await import("../scripts/channels/youtube-daily-short.mjs");
  const day = "2026-11-12";
  for (const slot of ["dica", "calc", "oferta"]) {
    const kv = memKv();
    assert.equal((await youtubePublicoENaoCongelado({ kv, day, slot })).motivo, "youtube_nao_publico", "upload falho: sem registro");
    await recordPublication(kv, planSlot(day, slot), { video_id: "V1", url: "https://www.youtube.com/shorts/V1", privacy_status: "private" }, { now: Date.parse(day + "T20:00:00Z") });
    assert.equal((await youtubePublicoENaoCongelado({ kv, day, slot })).ok, false, "privado não libera");
    const kvp = memKv();
    await recordPublication(kvp, planSlot(day, slot), { video_id: "V2", url: "https://www.youtube.com/shorts/V2", privacy_status: "public" }, { now: Date.parse(day + "T20:00:00Z") });
    assert.deepEqual(await youtubePublicoENaoCongelado({ kv: kvp, day, slot }), { ok: true, motivo: "youtube_publico" }, slot);
    kvp.m.set("zpc:shorts:congelado:v1", JSON.stringify({ episodio_id: "2026-11-12T13:00:00.000Z|x", desde: "2026-11-12", motivos: ["x"] }));
    assert.equal((await youtubePublicoENaoCongelado({ kv: kvp, day, slot })).motivo, "canal_congelado");
    assert.equal((await youtubePublicoENaoCongelado({ kv: kvp, day, slot, config: { canal: { congelamento_liberado_id: "2026-11-12T13:00:00.000Z|x" } } })).ok, true);
    assert.equal((await youtubePublicoENaoCongelado({ kv: kvp, day, slot, config: { canal: { congelamento_liberado_id: "2026-11-12T12:00:00.000Z|y" } } })).ok, false, "liberar outro episódio não vale");
    kvp.m.set("zpc:shorts:congelado:v1", "{ilegivel");
    assert.equal((await youtubePublicoENaoCongelado({ kv: kvp, day, slot })).motivo, "canal_congelado", "registro ilegível = congelado");
  }
  assert.equal((await youtubePublicoENaoCongelado({ kv: { get: async () => { throw new Error("kv"); } }, day, slot: "dica" })).ok, false);
  // O main do cross-post consulta a condição antes de ler o MP4 e chamar crosspost().
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/channels/short-crosspost.mjs", import.meta.url), "utf8").split("\r\n").join("\n");
  const main = src.slice(src.indexOf("if (isMain)"));
  assert.ok(main.indexOf("youtubePublicoENaoCongelado") > 0 && main.indexOf("youtubePublicoENaoCongelado") < main.indexOf("await crosspost("));
  assert.ok(main.includes("if (!yt.ok) { console.log(`::notice title=SHORT_CROSSPOST::${slot}=skipped_youtube_nao_publico_ou_congelado (${yt.motivo})`); continue; }"));
});
