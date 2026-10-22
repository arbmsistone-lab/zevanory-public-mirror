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
test("página servida só com a bandeira: 200, noindex, CSP, origem no campo oculto, visita registrada ANTES da resposta pelo binding", async () => {
  const s = setup({ reply: { status: 200, body: { ok: true, cookie: null } } });
  const r = await get(s, "/lista-de-espera/confeitaria?utm_source=youtube&utm_campaign=c1");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(r.headers.get("content-security-policy") || "", /form-action 'self'/);
  assert.equal(r.headers.get("set-cookie"), null, "núcleo não emitiu identificador");
  const html = await r.text();
  assert.match(html, /name="origem" value="youtube"/);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, "https://waitlist.internal/visita");
  assert.deepEqual(Object.keys(s.calls[0].body).sort(), ["asn", "ip", "method", "nicho", "purpose", "ua", "vid"]);
  assert.equal(s.calls[0].body.vid, "");
  const h = await worker.fetch(new Request("https://vendas.zevanory.api.br/lista-de-espera/loja-de-roupas", { method: "HEAD", headers: { "user-agent": HUMAN } }), s.env, s.ctx);
  assert.equal(h.status, 200); assert.equal(s.calls.length, 1, "HEAD não conta visita");
  assert.equal((await get(s, "/lista-de-espera/academia")).status, 404);
});

test("identificador da pessoa: cookie próprio emitido pelo núcleo com escopo, validade e flags; valor fora do padrão é recusado; cookie existente é repassado", async () => {
  const s = setup({ reply: { status: 200, body: { ok: true, cookie: { name: "zvfa", value: VID, maxAge: 86400 * 10 } } } });
  const r = await get(s, "/lista-de-espera/confeitaria");
  assert.equal(r.headers.get("set-cookie"), `zvfa=${VID}; Path=/lista-de-espera; Max-Age=864000; Secure; HttpOnly; SameSite=Lax`);
  for (const cookie of [{ name: "zvfa", value: "x; Domain=evil", maxAge: 10 }, { name: "outro", value: VID, maxAge: 10 }, { name: "zvfa", value: VID, maxAge: 61 * 86400 }]) {
    const b = setup({ reply: { status: 200, body: { ok: true, cookie } } });
    assert.equal((await get(b, "/lista-de-espera/confeitaria")).headers.get("set-cookie"), null, JSON.stringify(cookie));
  }
  const back = setup({ reply: { status: 200, body: { ok: true, cookie: null } } });
  await get(back, "/lista-de-espera/confeitaria", { cookie: `x=1; zvfa=${VID}` });
  assert.equal(back.calls[0].body.vid, VID);
  await get(back, "/lista-de-espera/confeitaria", { cookie: "zvfa=forjado" });
  assert.equal(back.calls[1].body.vid, "", "cookie fora do formato não é repassado");
});

test("confirmação: a folha de estilo do nicho repassa o cookie ao núcleo (sem cookie nada é chamado) e responde CSS sem cache", async () => {
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
