// Conteúdo Pronto: defeitos G1–G5 da prova local (harness scratchpad/conteudo-pronto-prova/harness/run.mjs,
// cenários A, B, C, E, F e H). Offline: KV em memória, IA e Resend simulados; nenhuma rede.
import test from "node:test";
import assert from "node:assert/strict";
import * as CS from "../worker/content-service.mjs";

globalThis.fetch = async (u) => { throw new Error("rede bloqueada no teste: " + u); };
class MapKV {
  data = new Map();
  async get(k) { return this.data.get(k) ?? null; }
  async put(k, v) { this.data.set(k, String(v)); }
  async delete(k) { this.data.delete(k); }
  async list({ prefix = "" } = {}) { return { keys: [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; }
}
const HOTTOK = "hottok-local-g1g5-000000000000";
const BRIEF = { negocio: "Ateliê Linha Viva", ramo: "ateliê de costura", publico: "mulheres de 25 a 60 anos", produtos: "ajustes e sob medida", diferencial: "prova com hora marcada", tom: "próximo", contato: "e-mail e Instagram Direct" };
const legenda = (i) => `Tema ${i}: cada peça passa por uma prova com hora marcada, para você não esperar e sair sabendo o que será ajustado. Combinamos o prazo por escrito e fazemos o acabamento à mão, porque é ele que faz a roupa durar e vestir bem.`;
const post = (i, mode) => ({ tema: "Tema " + i, legenda: legenda(i), cta: "Agende sua prova pelo Direct", hashtags: mode === "sem" ? [] : ["#costura", "#sobmedida"], imagem: mode === "sem" ? "" : "mãos fazendo o acabamento de uma bainha" });
const roteiro = (o) => ({ objetivo_id: o.id, curta: "Olá! Aqui é do Ateliê Linha Viva. Posso te passar os detalhes e reservar um horário de prova? Se preferir, respondo por aqui.", email: { assunto: o.titulo + " · Ateliê", corpo: "Olá! Obrigada pelo contato com o Ateliê Linha Viva. ".repeat(5) + "Se fizer sentido, responda com o melhor dia para a prova." } });
function ai({ mode = "ok" } = {}) {
  const calls = [], hung = [];
  // release(): solta as chamadas penduradas (como se o runtime tivesse matado o isolate) para o teste terminar.
  return { calls, release: () => { mode = "fail"; hung.splice(0).forEach((r) => r({ response: "sem json" })); }, run: async (_m, input) => {
    const u = input.messages[1].content;
    calls.push(u);
    if (mode === "fail") return { response: "sem json" };
    if (mode === "hang") return new Promise((r) => hung.push(r));
    if (u.includes("roteiros multicanal")) return { response: JSON.stringify({ roteiros: CS.ROTEIRO_OBJETIVOS.map(roteiro) }) };
    const from = Number(/posts (\d+) a/.exec(u)[1]);
    return { response: JSON.stringify({ posts: [0, 1, 2, 3, 4, 5].map((k) => post(from + k, mode)) }) };
  } };
}
function resend({ status = 200 } = {}) {
  const sent = [];
  const f = async (url, init) => {
    if (!String(url).startsWith("https://api.resend.com/")) throw new Error("fetch inesperado: " + url);
    sent.push({ ...JSON.parse(init.body), idem: init.headers["idempotency-key"] || null });
    return new Response(JSON.stringify({ id: "stub-" + sent.length }), { status: f.status ?? status });
  };
  f.sent = sent;
  return f;
}
const env = (a) => ({ ZEVANORY_PRIVATE_ARTIFACTS: new MapKV(), HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "stub", AI: a, OWNER_ALERT_EMAIL: "alertas@example.invalid" });
const hook = (event, txn, sub, email) => new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": HOTTOK },
  body: JSON.stringify({ event, data: { product: { id: 8704905, name: CS.SERVICE_PRODUCT_NAME }, buyer: { email, name: "Assinante" }, purchase: { transaction: txn }, subscription: { subscriber: { code: sub } } } }) });
const tokenOf = (text, p) => new RegExp(p + "\\?t=([A-Za-z0-9_-]+)").exec(text)?.[1];
const brief = (e, f, t, ctx = null) => CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + t, { method: "POST", body: new URLSearchParams(BRIEF) }), e, ctx, f);
const view = (e, t) => CS.handlePackageView(new Request("https://zevanory.api.br/conteudo-pronto/pacote?t=" + t), e);
const deliveries = (f, to) => f.sent.filter((m) => /chegou/.test(m.subject) && (!to || m.to[0] === to));
const subRecord = (kv) => JSON.parse(kv.data.get([...kv.data.keys()].find((k) => k.startsWith("zpc:cp:sub:"))));
async function subscribe(e, f, sub, email, txn = "HP-" + sub) {
  const before = f.sent.length;
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", txn, sub, email), e, null, f);
  return tokenOf(f.sent.slice(before).find((m) => m.to[0] === email).text, "briefing");
}

test("[G1] waitUntil cortado (IA lenta): o assinante já está na fila e o cron entrega depois que o lease vence", async (t0) => {
  const slow = ai({ mode: "hang" });
  const f = resend(), e = env(slow), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  t0.after(() => slow.release());
  const t = await subscribe(e, f, "SUB-E", "e@example.invalid");
  const dropped = [];
  const page = await brief(e, f, t, { waitUntil: (p) => dropped.push(p) }); // a promessa nunca termina: o runtime cortou
  assert.equal(page.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dropped.length, 1, "[G1] geração foi para o waitUntil");
  assert.match(String(kv.data.get("zpc:cp:pending")), /zpc:cp:sub:/, "[G1] pendente registrado antes do waitUntil");
  e.AI = ai();
  const during = await CS.retryPendingPackages(e, f);
  assert.equal(during.delivered, 0, "[G1] cron não começa outra geração enquanto o lease vale");
  const out = await CS.retryPendingPackages(e, f, 2, { now: Date.now() + CS.GEN_LEASE_MS + 1000 });
  assert.equal(out.delivered, 1, "[G1] cron entrega o primeiro pacote");
  assert.equal(deliveries(f, "e@example.invalid").length, 1, "[G1] um e-mail de pacote");
  const rec = subRecord(kv);
  assert.equal(rec.deliveredCycle, 1);
  assert.equal(rec.genLeaseUntil, undefined, "[G1] lease limpo na entrega");
  assert.deepEqual(JSON.parse(kv.data.get("zpc:cp:pending")), [], "[G1] fila vazia");
});

test("[G2] fila de pendentes: cancelados e entregues na frente não bloqueiam o terceiro assinante", async () => {
  const f = resend(), e = env(ai({ mode: "fail" })), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  for (const s of ["SUB-F1", "SUB-F2", "SUB-F3"]) await brief(e, f, await subscribe(e, f, s, s.toLowerCase() + "@example.invalid"));
  assert.equal(JSON.parse(kv.data.get("zpc:cp:pending")).length, 3);
  await CS.handleHotmartWebhook(hook("SUBSCRIPTION_CANCELLATION", "X1", "SUB-F1", "sub-f1@example.invalid"), e, null, f);
  await CS.handleHotmartWebhook(hook("SUBSCRIPTION_CANCELLATION", "X2", "SUB-F2", "sub-f2@example.invalid"), e, null, f);
  e.AI = ai();
  const r1 = await CS.retryPendingPackages(e, f);
  assert.equal(r1.delivered, 1, "[G2] o terceiro é entregue no primeiro cron");
  assert.equal(deliveries(f, "sub-f3@example.invalid").length, 1, "[G2] sub-f3 recebeu");
  assert.deepEqual(JSON.parse(kv.data.get("zpc:cp:pending")), [], "[G2] cancelados saem da fila");
  // Já entregue que volta à fila (ex.: corrida) também sai sem gastar o limite.
  const k3 = [...kv.data.keys()].find((k) => k.startsWith("zpc:cp:sub:") && JSON.parse(kv.data.get(k)).email === "sub-f3@example.invalid");
  kv.data.set("zpc:cp:pending", JSON.stringify([k3]));
  const r2 = await CS.retryPendingPackages(e, f);
  assert.equal(r2.tried, 0, "[G2] entregue não gasta tentativa");
  assert.deepEqual(JSON.parse(kv.data.get("zpc:cp:pending")), [], "[G2] entregue sai da fila");
});

test("[G2] falha persistente vai para o fim da fila (rodízio)", async () => {
  const f = resend(), e = env(ai({ mode: "fail" })), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  for (const s of ["SUB-R1", "SUB-R2", "SUB-R3"]) await brief(e, f, await subscribe(e, f, s, s.toLowerCase() + "@example.invalid"));
  const q0 = JSON.parse(kv.data.get("zpc:cp:pending"));
  await CS.retryPendingPackages(e, f, 1); // IA ainda falha
  assert.deepEqual(JSON.parse(kv.data.get("zpc:cp:pending")), [q0[1], q0[2], q0[0]], "[G2] quem falhou foi para o fim");
});

test("[G3] validador: post sem hashtag, sem imagem, com legenda curta ou tema repetido é recusado", () => {
  assert.equal(CS.validatePosts([post(1)], 1).length, 1);
  assert.equal(CS.validatePosts([{ ...post(1), hashtags: [] }], 1), null, "[G3] sem hashtag");
  assert.equal(CS.validatePosts([{ ...post(1), hashtags: ["#", "# "] }], 1), null, "[G3] hashtag vazia");
  assert.equal(CS.validatePosts([{ ...post(1), imagem: "" }], 1), null, "[G3] sem imagem");
  assert.equal(CS.validatePosts([{ ...post(1), imagem: "foto" }], 1), null, "[G3] imagem vaga");
  assert.equal(CS.validatePosts([{ ...post(1), legenda: "x".repeat(CS.LEGENDA_MIN - 1) }], 1), null, "[G3] legenda curta");
  assert.equal(CS.validatePosts([post(1), { ...post(2), tema: "tema 1" }], 2), null, "[G3] tema repetido");
});

test("[G3] IA devolve posts sem hashtags e sem imagem: nada é enviado, o pacote fica pendente", async () => {
  const f = resend(), e = env(ai({ mode: "sem" })), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await brief(e, f, await subscribe(e, f, "SUB-C", "c@example.invalid"));
  assert.equal(deliveries(f).length, 0, "[G3] pacote incompleto não sai");
  assert.match(String(kv.data.get("zpc:cp:pending")), /zpc:cp:sub:/, "[G3] pendente");
});

test("[G4] falha do Resend: o retry reenvia o MESMO pacote, sem chamar a IA de novo, com o mesmo link e a mesma chave de idempotência", async () => {
  const a = ai(), f = resend(), e = env(a), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  const t = await subscribe(e, f, "SUB-H", "h@example.invalid");
  f.status = 500;
  await brief(e, f, t);
  const calls = a.calls.length;
  assert.equal(calls, 3, "[G4] uma geração");
  const failed = deliveries(f, "h@example.invalid");
  assert.equal(failed.length, 1, "[G4] tentativa de envio registrada");
  f.status = 200;
  const out = await CS.retryPendingPackages(e, f);
  assert.equal(out.delivered, 1);
  assert.equal(a.calls.length, calls, "[G4] o retry não gera o pacote de novo");
  const ok = deliveries(f, "h@example.invalid");
  assert.equal(ok[1].text, ok[0].text, "[G4] mesmo texto, mesmo link");
  assert.ok(ok[0].idem && ok[1].idem === ok[0].idem, "[G4] mesma Idempotency-Key");
  assert.equal([...kv.data.keys()].filter((k) => k.startsWith("zpc:cp:pkg:")).length, 1, "[G4] um pacote gravado");
});

test("[G5] o link de cada mês abre aquele mês; o token do formulário não abre pacote", async () => {
  const f = resend(), e = env(ai());
  const bt = await subscribe(e, f, "SUB-A", "a@example.invalid");
  await brief(e, f, bt);
  const pt1 = tokenOf(deliveries(f)[0].text, "pacote");
  assert.equal((await view(e, bt)).status, 404, "[G5] token do formulário não abre o pacote");
  assert.match(await (await view(e, pt1)).text(), /mês 1/, "[G5] link do mês 1");
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-A-2", "SUB-A", "a@example.invalid"), e, null, f);
  const pt2 = tokenOf(deliveries(f).at(-1).text, "pacote");
  assert.notEqual(pt2, pt1);
  const v1 = await (await view(e, pt1)).text();
  assert.match(v1, /Conteúdo Pronto · mês 1/, "[G5] link do mês 1 continua no mês 1");
  assert.doesNotMatch(v1, /mês 2/, "[G5] link do mês 1 não mostra o mês 2");
  assert.match(await (await view(e, pt2)).text(), /Conteúdo Pronto · mês 2/, "[G5] link do mês 2");
  // O token de pacote também não abre o formulário.
  const form = await CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + pt1), e, null, f);
  assert.equal(form.status, 404, "[G5] token do pacote não abre o formulário");
});

test("[G5] token antigo (valor = chave do assinante) continua abrindo formulário e último pacote", async () => {
  const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await brief(e, f, await subscribe(e, f, "SUB-L", "l@example.invalid"));
  const sub = [...kv.data.keys()].find((k) => k.startsWith("zpc:cp:sub:"));
  const legacy = "L".repeat(43);
  kv.data.set("zpc:cp:token:" + legacy, sub);
  assert.equal((await view(e, legacy)).status, 200, "[G5-legacy] pacote");
  assert.equal((await CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + legacy), e, null, f)).status, 200, "[G5-legacy] formulário");
});

// ---------- ORDEM 301 (Sol): intenção durável, fila com limite, falha explícita, nada some em silêncio ----------
class CrashKV extends MapKV { // derruba o isolate na primeira gravação cujo nome casa com o padrão
  constructor(pattern) { super(); this.pattern = pattern; }
  async put(k, v) { if (this.pattern && this.pattern.test(k)) { this.pattern = null; throw new Error("isolate killed"); } return super.put(k, v); }
}
test("[G1-intent] queda antes de marcar o postback como processado: a Hotmart reenvia, o ciclo não dobra e o pacote sai uma vez", async () => {
  const f = resend(), e = env(ai());
  const t = await subscribe(e, f, "SUB-I", "i@example.invalid", "HP-I-1");
  await brief(e, f, t);
  const kv0 = e.ZEVANORY_PRIVATE_ARTIFACTS;
  const crash = new CrashKV(/^zpc:cp:txn:/);
  for (const [k, v] of kv0.data) crash.data.set(k, v);
  e.ZEVANORY_PRIVATE_ARTIFACTS = crash;
  const renewal = () => CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-I-2", "SUB-I", "i@example.invalid"), e, { waitUntil: () => {} }, f);
  await assert.rejects(renewal(), /isolate killed/, "[G1-intent] queda simulada no marcador de processado");
  assert.match(String(crash.data.get("zpc:cp:pending")), /zpc:cp:sub:/, "[G1-intent] intenção de geração já gravada antes do marcador");
  const again = await (await renewal()).json();
  assert.equal(again.status, "generation_started", "[G1-intent] reenvio da Hotmart processa de novo (não é 'duplicate')");
  assert.equal(subRecord(crash).cycles, 2, "[G1-intent] o ciclo sobe uma vez só");
  assert.equal((await (await renewal()).json()).duplicate, true, "[G1-intent] terceiro reenvio é duplicado");
  await new Promise((r) => setTimeout(r, 20));
  await CS.retryPendingPackages(e, f);
  assert.equal(deliveries(f, "i@example.invalid").filter((m) => /mês 2/.test(m.subject)).length, 1, "[G1-intent] pacote do mês 2 sai uma vez");
});

test("[G2-poison] item que falha sempre: limite de tentativas, fila de falhas com alerta e registro; reenvio só com operador e motivo", async () => {
  const f = resend(), e = env(ai({ mode: "fail" })), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await brief(e, f, await subscribe(e, f, "SUB-P", "p@example.invalid"));
  await brief(e, f, await subscribe(e, f, "SUB-Q", "q@example.invalid"));
  for (let i = 0; i < CS.PENDING_MAX_ATTEMPTS + 2; i++) await CS.retryPendingPackages(e, f);
  const dead = JSON.parse(kv.data.get("zpc:cp:pending-dead"));
  assert.equal(Object.keys(dead).length, 2, "[G2-poison] os dois vão para a fila de falhas");
  assert.deepEqual(JSON.parse(kv.data.get("zpc:cp:pending")), [], "[G2-poison] a fila não fica travada");
  assert.ok(Object.values(dead).every((d) => d.attempts >= CS.PENDING_MAX_ATTEMPTS), "[G2-poison] limite respeitado");
  assert.equal(f.sent.filter((m) => /sem entrega/.test(m.subject) && m.to[0] === "alertas@example.invalid").length, 2, "[G2-poison] um alerta por item");
  const log = JSON.parse(kv.data.get("zpc:cp:pending-log"));
  assert.equal(log.filter((x) => x.event === "dead").length, 2, "[G2-poison] registro explícito");
  const key = Object.keys(dead)[0];
  assert.equal((await CS.requeueDeadPackage(e, key, { operator: "", reason: "x" })).ok, false, "[G2-poison] sem operador não reabre");
  e.AI = ai();
  assert.equal((await CS.requeueDeadPackage(e, key, { operator: "renan", reason: "IA voltou, reenvio manual" })).ok, true);
  const out = await CS.retryPendingPackages(e, f);
  assert.equal(out.delivered, 1, "[G2-poison] reenvio controlado entrega");
});

test("[G2-stall] fila parada há mais de 6 h gera alerta (no máximo um por dia)", async () => {
  const f = resend(), e = env(ai({ mode: "fail" }));
  await brief(e, f, await subscribe(e, f, "SUB-S", "s@example.invalid"));
  const later = Date.now() + (CS.PENDING_STALL_HOURS + 1) * 3600000;
  await CS.retryPendingPackages(e, f, 2, { now: later });
  await CS.retryPendingPackages(e, f, 2, { now: later + 3600000 });
  assert.equal(f.sent.filter((m) => /fila do Conteúdo Pronto parada/.test(m.subject)).length, 1, "[G2-stall] um alerta");
});

test("[no-silent] em todos os cenários, cada ciclo pago termina entregue, pendente ou na fila de falhas com alerta", async () => {
  const scenarios = [["ok", 200], ["fail", 200], ["ok", 500], ["sem", 200]];
  for (const [mode, status] of scenarios) {
    const f = resend({ status }), e = env(ai({ mode })), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
    await brief(e, f, await subscribe(e, f, "SUB-N-" + mode + status, "n@example.invalid"));
    for (let i = 0; i < CS.PENDING_MAX_ATTEMPTS + 1; i++) await CS.retryPendingPackages(e, f);
    const rec = subRecord(kv);
    const key = [...kv.data.keys()].find((k) => k.startsWith("zpc:cp:sub:"));
    const pending = JSON.parse(kv.data.get("zpc:cp:pending") || "[]");
    const dead = JSON.parse(kv.data.get("zpc:cp:pending-dead") || "{}");
    const delivered = rec.deliveredCycle === rec.cycles;
    assert.ok(delivered || pending.includes(key) || dead[key], `[no-silent] ${mode}/${status}: entregue, pendente ou falha registrada`);
    if (dead[key]) assert.ok(f.sent.some((m) => /sem entrega/.test(m.subject)), `[no-silent] ${mode}/${status}: falha alertada`);
  }
});
