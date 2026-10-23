// P01 Fase A: rotas públicas no Worker de vendas REAL (worker/sales-public-worker.mjs) com bindings
// falsos (CORE, ASSETS, BUY_LIMITER). Sem rede, sem banco. Bandeira, robôs, honeypot, limite por IP,
// consentimento repassado, mensagens fixas e contagem de visita só pelo binding privado.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pythonOk } from "../../scripts/fase_a/tools.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../../worker/sales-public-worker.mjs";
import { resetWaitlistLimiter, MESSAGES } from "../../worker/waitlist-public.mjs";
import { AVISO_VERSION } from "../../worker/waitlist.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "fase-a-pub-"));
pythonOk([path.join(ROOT, "scripts", "fase_a", "build_fase_a.py"), "--out", OUT, "--preview"]);
const HUMAN = "Mozilla/5.0 (Linux; Android 14; SM-A146M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const OPTOUT = "https://vendas.zevanory.api.br/lista-de-espera/sair?r=" + "a".repeat(64) + "&t=" + "b".repeat(32);

function setup({ flag = "on", reply = { status: 200, body: { ok: true, code: "inscrito", optout: OPTOUT } }, limiter } = {}) {
  const calls = [], waits = [];
  const env = {
    ...(flag ? { FASE_A_WAITLIST: flag } : {}),
    CORE: { async fetch(url, init = {}) { const body = init.body ? JSON.parse(init.body) : null; calls.push({ url: String(url), body }); const rp = typeof reply === "function" ? reply(String(url), body) : reply; return new Response(JSON.stringify(rp.body), { status: rp.status }); } },
    ASSETS: { async fetch(req) { const f = path.join(OUT, new URL(req.url).pathname.slice(1)); return fs.existsSync(f) ? new Response(fs.readFileSync(f, "utf8"), { status: 200 }) : new Response("nf", { status: 404 }); } },
    ...(limiter ? { BUY_LIMITER: limiter } : {}),
  };
  const ctx = { waitUntil: (p) => waits.push(p) };
  return { env, ctx, calls, waits };
}
const form = (o = {}) => new URLSearchParams({ nicho: "confeitaria", contato: "ana@exemplo.com", q1: "sim", q2: "nao", consentimento: "sim", website: "", origem: "youtube", ...o });
const post = (s, body, headers = {}) => worker.fetch(new Request("https://vendas.zevanory.api.br/lista-de-espera/inscrever", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": HUMAN, "cf-connecting-ip": "200.1.1.1", referer: "https://vendas.zevanory.api.br/lista-de-espera/confeitaria", ...headers } }), s.env, s.ctx);
const get = (s, p, headers = {}) => worker.fetch(new Request("https://vendas.zevanory.api.br" + p, { headers: { "user-agent": HUMAN, "cf-connecting-ip": "200.1.1.1", ...headers } }), s.env, s.ctx);
beforeEach(() => resetWaitlistLimiter());

test("bandeira ausente ou diferente de 'on': todas as rotas da lista dão 404 e o núcleo não é chamado", async () => {
  for (const flag of [null, "off", "1", "true"]) {
    const s = setup({ flag });
    for (const p of ["/lista-de-espera/confeitaria", "/lista-de-espera/sair", "/lista-de-espera", "/lista-de-espera-confeitaria.html".replace(".html", "")]) {
      const r = await get(s, p);
      assert.ok(r.status === 404, `${flag} ${p} -> ${r.status}`);
    }
    assert.equal((await post(s, form())).status, 404);
    assert.equal(s.calls.length, 0);
  }
});

const VID = "c".repeat(32) + "." + "d".repeat(32);
test("aviso antes da coleta (AVAL 101): abrir a página NÃO chama o núcleo nem emite cookie; origem classificada no campo oculto e repassada só à folha do aviso", async () => {
  const s = setup({ reply: { status: 200, body: { ok: true, cookie: { name: "zvfa", value: VID, maxAge: 864000 } } } });
  const r = await get(s, "/lista-de-espera/confeitaria?utm_source=WA_Status&utm_campaign=c1", { referer: "https://l.instagram.com/" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(r.headers.get("content-security-policy") || "", /form-action 'self'/);
  assert.equal(r.headers.get("set-cookie"), null, "abrir a página não emite identificador");
  assert.equal(s.calls.length, 0, "abrir a página não chama o núcleo (nada medido antes do aviso)");
  const html = await r.text();
  assert.match(html, /name="origem" value="wa_status"/, "rótulo classificado (lista fechada) no campo oculto");
  assert.ok(html.includes(`<link rel="stylesheet" href="/lista-de-espera/a/confeitaria.css?aviso=${AVISO_VERSION}&amp;utm=wa_status&amp;ref=1">`), "origem viaja na folha do aviso");
  assert.match(await (await get(s, "/lista-de-espera/confeitaria?utm_source=%3Cx%3E")).text(), /name="origem" value="invalido"/);
  const h = await worker.fetch(new Request("https://vendas.zevanory.api.br/lista-de-espera/loja-de-roupas", { method: "HEAD", headers: { "user-agent": HUMAN } }), s.env, s.ctx);
  assert.equal(h.status, 200); assert.equal(s.calls.length, 0);
  assert.equal((await get(s, "/lista-de-espera/academia")).status, 404);
});

test("folha do aviso: registra a visita (sem IP), emite o cookie com escopo/validade/flags e importa a confirmação; valor fora do padrão é recusado; cookie existente é repassado", async () => {
  const s = setup({ reply: { status: 200, body: { ok: true, cookie: { name: "zvfa", value: VID, maxAge: 86400 * 10 } } } });
  const r = await get(s, `/lista-de-espera/a/confeitaria.css?aviso=${AVISO_VERSION}&utm=wa_status&ref=1`, { "sec-purpose": "" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/css/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("set-cookie"), `zvfa=${VID}; Path=/lista-de-espera; Max-Age=864000; Secure; HttpOnly; SameSite=Lax`);
  assert.match(await r.text(), /@import url\("\/lista-de-espera\/c\/confeitaria\.css"\);/);
  assert.equal(s.calls[0].url, "https://waitlist.internal/visita");
  assert.deepEqual(Object.keys(s.calls[0].body).sort(), ["asn", "aviso", "method", "nicho", "purpose", "ref_ext", "ua", "utm", "vid"], "sem IP");
  assert.deepEqual([s.calls[0].body.aviso, s.calls[0].body.utm, s.calls[0].body.ref_ext], [AVISO_VERSION, "wa_status", true]);
  assert.ok(!JSON.stringify(s.calls[0].body).includes("200.1.1.1"), "IP nunca vai ao núcleo");
  for (const cookie of [{ name: "zvfa", value: "x; Domain=evil", maxAge: 10 }, { name: "outro", value: VID, maxAge: 10 }, { name: "zvfa", value: VID, maxAge: 61 * 86400 }]) {
    const b = setup({ reply: { status: 200, body: { ok: true, cookie } } });
    assert.equal((await get(b, `/lista-de-espera/a/confeitaria.css?aviso=${AVISO_VERSION}`)).headers.get("set-cookie"), null, JSON.stringify(cookie));
  }
  const back = setup({ reply: { status: 200, body: { ok: true, cookie: null } } });
  await get(back, `/lista-de-espera/a/confeitaria.css?aviso=${AVISO_VERSION}`, { cookie: `x=1; zvfa=${VID}` });
  assert.equal(back.calls[0].body.vid, VID);
  await get(back, "/lista-de-espera/a/confeitaria.css", { cookie: "zvfa=forjado" });
  assert.deepEqual([back.calls[1].body.vid, back.calls[1].body.aviso], ["", ""], "cookie fora do formato não é repassado; sem versão do aviso o núcleo recusa");
  assert.equal((await get(back, "/lista-de-espera/a/academia.css")).status, 404);
});

test("não participação (AVAL 101): zvfa_optout=1 ou Sec-GPC: 1 => nenhuma chamada de medição nem cookie (o identificador existente é apagado); botão grava o marcador até o fim da janela", async () => {
  for (const headers of [{ cookie: `zvfa_optout=1; zvfa=${VID}` }, { "sec-gpc": "1", cookie: `zvfa=${VID}` }]) {
    const s = setup({ reply: { status: 200, body: { ok: true, erased: 1, maxAge: 3600 } } });
    const page1 = await get(s, "/lista-de-espera/confeitaria", headers);
    assert.ok(!(await page1.text()).includes("/lista-de-espera/a/"), "página sem o gatilho de medição");
    const a = await get(s, `/lista-de-espera/a/confeitaria.css?aviso=${AVISO_VERSION}`, headers);
    assert.equal(a.headers.get("set-cookie"), "zvfa=; Path=/lista-de-espera; Max-Age=0; Secure; HttpOnly; SameSite=Lax", "apaga o cookie de medição");
    assert.doesNotMatch(await a.text(), /@import/);
    await get(s, "/lista-de-espera/c/confeitaria.css", headers);
    await Promise.all(s.waits);
    assert.deepEqual(s.calls.map((c) => c.url), ["https://waitlist.internal/nao-participar"], "só a exclusão; nenhuma visita/confirmação");
    assert.deepEqual(s.calls[0].body, { vid: VID });
    await post(s, form(), headers);
    assert.deepEqual([s.calls[1].body.optout, s.calls[1].body.vid], [true, ""], "inscrição sem vínculo de medição");
  }
  const s = setup({ reply: { status: 200, body: { ok: true, erased: 2, maxAge: 7200 } } });
  const g = await get(s, "/lista-de-espera/nao-participar");
  assert.equal(g.status, 200);
  assert.match(await g.text(), /<form method="post" action="\/lista-de-espera\/nao-participar"><button class="button primary" type="submit">Não participar da medição<\/button><\/form>/);
  assert.equal(s.calls.length, 0);
  const p = await worker.fetch(new Request("https://vendas.zevanory.api.br/lista-de-espera/nao-participar", { method: "POST", headers: { "user-agent": HUMAN, cookie: `zvfa=${VID}` } }), s.env, s.ctx);
  assert.equal(p.status, 200);
  const sc = p.headers.getSetCookie();
  assert.deepEqual(sc, ["zvfa_optout=1; Path=/lista-de-espera; Max-Age=7200; Secure; HttpOnly; SameSite=Lax", "zvfa=; Path=/lista-de-espera; Max-Age=0; Secure; HttpOnly; SameSite=Lax"]);
  assert.match(await p.text(), /registro de medição deste navegador foi apagado/);
  assert.deepEqual(s.calls[0], { url: "https://waitlist.internal/nao-participar", body: { vid: VID } });
  const down = setup({ reply: { status: 503, body: {} } });
  const p2 = await worker.fetch(new Request("https://vendas.zevanory.api.br/lista-de-espera/nao-participar", { method: "POST", headers: { "user-agent": HUMAN } }), down.env, down.ctx);
  assert.equal(p2.headers.getSetCookie()[0], "zvfa_optout=1; Path=/lista-de-espera; Max-Age=5184000; Secure; HttpOnly; SameSite=Lax", "núcleo fora: o marcador vale assim mesmo (teto do cookie)");
});

test("meus dados (ação local): mostra o registro e o código opaco de atendimento, nunca o cookie; sem cookie, nada é consultado", async () => {
  const TOKEN = "e".repeat(32);
  const s = setup({ reply: { status: 200, body: { ok: true, exists: true, rows: [{ niche: "confeitaria", first_day: "2026-11-02", last_day: "2026-11-03", days: 2 }, { niche: "<x>", first_day: "a", last_day: "b", days: 1 }], token: TOKEN } } });
  const r = await get(s, "/lista-de-espera/meus-dados", { cookie: `zvfa=${VID}` });
  const html = await r.text();
  assert.ok(html.includes("confeitaria: de 2026-11-02 a 2026-11-03 (2 dia(s))") && html.includes(TOKEN));
  assert.ok(!html.includes(VID) && !html.includes(VID.slice(0, 32)), "cookie bruto nunca exibido");
  assert.ok(!html.includes("&lt;x&gt;"), "nicho fora da lista ignorado");
  assert.deepEqual(s.calls[0], { url: "https://waitlist.internal/meus-dados", body: { vid: VID } });
  const none = setup();
  assert.match(await (await get(none, "/lista-de-espera/meus-dados")).text(), /Não há registro de medição deste navegador/);
  assert.equal(none.calls.length, 0);
});

test("confirmação: a folha importada pelo aviso repassa o cookie ao núcleo (sem cookie ou com não participação nada é chamado) e responde CSS sem cache", async () => {
  const s = setup({ reply: { status: 204, body: {} } });
  const r = await get(s, "/lista-de-espera/c/confeitaria.css", { cookie: `zvfa=${VID}` });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/css/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  await Promise.all(s.waits);
  assert.deepEqual(s.calls, [{ url: "https://waitlist.internal/confirmar", body: { nicho: "confeitaria", vid: VID } }]);
  const none = setup();
  assert.equal((await get(none, "/lista-de-espera/c/confeitaria.css")).status, 200);
  assert.equal(none.calls.length, 0);
  assert.equal((await get(none, "/lista-de-espera/c/academia.css")).status, 404);
  await get(none, "/lista-de-espera/c/confeitaria.css", { cookie: `zvfa=${VID}`, "sec-gpc": "1" });
  await Promise.all(none.waits);
  assert.equal(none.calls.length, 0, "Sec-GPC: nenhuma confirmação");
});

test("inscrição: robô recusado (403) e honeypot aceito em silêncio, ambos sem chamar o núcleo", async () => {
  const s = setup();
  assert.equal((await post(s, form(), { "user-agent": "python-requests/2.32" })).status, 403);
  assert.equal((await post(s, form(), { "user-agent": "" })).status, 403);
  const hp = await post(s, form({ website: "http://spam" }));
  assert.equal(hp.status, 200);
  assert.equal(s.calls.length, 0);
});

test("inscrição: consentimento repassado como booleano estrito, sem IP no payload, e confirmação com link de saída validado", async () => {
  const s = setup();
  const ok = await post(s, form());
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.ok(html.includes(MESSAGES.inscrito[1]));
  assert.ok(html.includes(OPTOUT.replace(/&/g, "&amp;")), "link de saída mostrado");
  assert.equal(s.calls[0].url, "https://waitlist.internal/inscrever");
  const b = s.calls[0].body;
  assert.equal(b.consent, true);
  assert.equal(b.interview, false, "convite para entrevista é opcional e separado");
  assert.equal(b.src, "youtube");
  assert.ok(!("ip" in b) && !JSON.stringify(b).includes("200.1.1.1"), "IP não vai ao núcleo na inscrição");
  await post(s, form({ entrevista: "sim" }), { cookie: `zvfa=${VID}` });
  assert.equal(s.calls[1].body.interview, true); assert.equal(s.calls[1].body.consent, true); assert.equal(s.calls[1].body.vid, VID);
  s.calls.splice(1, 1);
  await post(s, form({ consentimento: "" }));
  await post(s, form({ consentimento: "on" }));
  assert.equal(s.calls[1].body.consent, false); assert.equal(s.calls[2].body.consent, false);
});

test("mensagens fixas: código desconhecido vira 'indisponível' e link de saída fora do padrão não é exibido", async () => {
  const s = setup({ reply: { status: 200, body: { ok: true, code: "<script>x</script>", optout: "https://evil.example/sair" } } });
  const r = await post(s, form());
  const html = await r.text();
  assert.ok(!html.includes("<script>x") && !html.includes("evil.example"));
  assert.ok(html.includes(MESSAGES.indisponivel[1]));
  const s2 = setup({ reply: { status: 200, body: { ok: true, code: "inscrito", optout: "https://evil.example/x" } } });
  const h2 = await (await post(s2, form())).text();
  assert.ok(!h2.includes("evil.example"));
  const s3 = setup({ reply: { status: 400, body: { ok: false, code: "consentimento" } } });
  const r3 = await post(s3, form({ consentimento: "" }));
  assert.equal(r3.status, 400); assert.ok((await r3.text()).includes(MESSAGES.consentimento[1]));
});

test("limite por IP: 11ª tentativa no minuto -> 429 (memória) e BUY_LIMITER com chave própria quando existe", async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) assert.equal((await post(s, form({ contato: `p${i}@exemplo.com` }))).status, 200);
  assert.equal((await post(s, form())).status, 429);
  assert.equal(s.calls.length, 10);
  const other = await post(s, form(), { "cf-connecting-ip": "200.9.9.9" });
  assert.equal(other.status, 200, "outro IP não é afetado");
  const keys = [];
  const s2 = setup({ limiter: { async limit({ key }) { keys.push(key); return { success: false }; } } });
  assert.equal((await post(s2, form())).status, 429);
  assert.deepEqual(keys, ["buy:waitlist:200.1.1.1"]);
  assert.equal(s2.calls.length, 0);
});

test("saída: instruções sem parâmetros; com link verifica no núcleo e confirma por POST; link inválido recusado", async () => {
  const s = setup({ reply: { status: 200, body: { ok: true } } });
  const info = await get(s, "/lista-de-espera/sair");
  assert.equal(info.status, 200); assert.ok((await info.text()).includes("suporte@zevanory.api.br"));
  assert.equal(s.calls.length, 0);
  const q = "?r=" + "a".repeat(64) + "&t=" + "b".repeat(32);
  const confirm = await get(s, "/lista-de-espera/sair" + q);
  assert.equal(confirm.status, 200); assert.match(await confirm.text(), /<form method="post"/);
  assert.equal(s.calls[0].url, "https://waitlist.internal/sair/verificar");
  const done = await worker.fetch(new Request("https://vendas.zevanory.api.br/lista-de-espera/sair" + q, { method: "POST", headers: { "user-agent": HUMAN } }), s.env, s.ctx);
  assert.equal(done.status, 200); assert.equal(s.calls[1].url, "https://waitlist.internal/sair");
  assert.deepEqual(s.calls[1].body, { r: "a".repeat(64), t: "b".repeat(32) });
  const bad = setup({ reply: { status: 400, body: { ok: false } } });
  assert.equal((await get(bad, "/lista-de-espera/sair" + q)).status, 400);
});

test("trava da LIA (AVAL 099): núcleo recusa com 503 lia_nao_aprovada -> página sem cookie e inscrição 'indisponível', sem expor o motivo", async () => {
  const s = setup({ reply: { status: 503, body: { ok: false, code: "lia_nao_aprovada", reason: "lia_pendente_de_revisao" } } });
  const r = await get(s, `/lista-de-espera/a/confeitaria.css?aviso=${AVISO_VERSION}`, { cookie: `zvfa=${VID}` });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null, "nenhum identificador emitido");
  const html = await r.text();
  assert.doesNotMatch(html, /lia_|pendente_de_revisao/);
  const i = await post(s, form());
  assert.equal(i.status, 503);
  const body = await i.text();
  assert.match(body, new RegExp(MESSAGES.indisponivel[0]));
  assert.doesNotMatch(body, /lia_|pendente_de_revisao/);
});
