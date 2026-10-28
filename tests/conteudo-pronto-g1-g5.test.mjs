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

// ---------- Auditoria independente do #953 (H1, H2, M1-M4 e mutantes sobreviventes) ----------
// KV com o limite documentado do Workers KV: 1 escrita por segundo na MESMA chave (429 acima disso), como a sonda P4.
function rateLimited(kv, { persistent = null, recent = false } = {}) {
  const last = new Map(), put = kv.put.bind(kv);
  if (recent) for (const k of kv.data.keys()) last.set(k, Date.now()); // como se cada chave tivesse acabado de ser gravada
  kv.put = async (k, v, o) => {
    const n = Date.now();
    if ((persistent && persistent.test(k)) || n - (last.get(k) || 0) < 1000) throw new Error("KV PUT failed: 429 Too Many Requests");
    last.set(k, n);
    return put(k, v, o);
  };
  return kv;
}
const subKey = (kv) => [...kv.data.keys()].find((k) => k.startsWith("zpc:cp:sub:"));
const alertsOf = (kv) => JSON.parse(kv.data.get("zpc:cp:alerts") || "[]");

test("[A-kv429] KV com 1 escrita/s por chave: a entrega conclui uma vez, sem reenvio a cada cron", async () => {
  const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  const t = await subscribe(e, f, "SUB-K", "k@example.invalid");
  f.status = 500; await brief(e, f, t); f.status = 200;
  rateLimited(kv, { recent: true });
  const out = await CS.retryPendingPackages(e, f, 2, { now: Date.now() + 3 * 3600e3 });
  assert.equal(out.delivered, 1, "[A-kv429] 429 na chave do assinante é repetido, a entrega conclui");
  assert.equal(subRecord(kv).deliveredCycle, 1, "[A-kv429] ciclo gravado");
  for (let i = 0; i < 3; i++) await CS.retryPendingPackages(e, f, 2, { now: Date.now() + (4 + i) * 3600e3 });
  assert.equal(deliveries(f, "k@example.invalid").length, 2, "[A-kv429] 1 tentativa com 500 + 1 envio aceito; nenhum reenvio depois");
});

test("[A-exception] exceção dentro da entrega: o cron não aborta, a tentativa conta, fica no log, alerta gravado e o e-mail não se repete", async () => {
  const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  const t1 = await subscribe(e, f, "SUB-X1", "x1@example.invalid");
  const t2 = await subscribe(e, f, "SUB-X2", "x2@example.invalid");
  f.status = 500; await brief(e, f, t1); await brief(e, f, t2); f.status = 200;
  const k1 = JSON.parse(kv.data.get("zpc:cp:pending"))[0];
  rateLimited(kv, { persistent: new RegExp("^" + k1 + "$") }); // a chave do 1º assinante recusa toda escrita (429 persistente)
  const out = await CS.retryPendingPackages(e, f, 2, { now: Date.now() + 3600e3 });
  assert.equal(out.delivered, 1, "[A-exception] o segundo assinante é entregue no mesmo cron");
  const meta = JSON.parse(kv.data.get("zpc:cp:pending-meta"));
  assert.equal(meta[k1].attempts, 2, "[A-exception] exceção conta como tentativa (1ª falha de envio + exceção)");
  assert.match(meta[k1].lastReason, /^exception:/, "[A-exception] motivo registrado");
  assert.ok(JSON.parse(kv.data.get("zpc:cp:pending-log")).some((x) => x.event === "exception"), "[A-exception] log");
  assert.ok(alertsOf(kv).some((a) => a.kind === "erro_entrega"), "[A-exception] alerta gravado");
  const sentBefore = deliveries(f, "x1@example.invalid").length;
  kv.put = MapKV.prototype.put.bind(kv); // KV volta ao normal
  await new Promise((r) => setTimeout(r, 1100));
  await CS.retryPendingPackages(e, f, 2, { now: Date.now() + 2 * 3600e3 });
  assert.equal(deliveries(f, "x1@example.invalid").length, sentBefore, "[A-exception] envio já aceito não é repetido");
  assert.equal(JSON.parse(kv.data.get(k1)).deliveredCycle, 1, "[A-exception] registro concluído sem novo envio");
  assert.deepEqual(JSON.parse(kv.data.get("zpc:cp:pending")), [], "[A-exception] fila vazia");
});

test("[A-welcome] e-mail de boas-vindas que falha: não marca processado, fica na fila, alerta gravado, cron reenvia o mesmo link", async () => {
  const f = resend({ status: 500 }), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  const r = await (await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-W", "SUB-W", "w@example.invalid"), e, null, f)).json();
  assert.equal(r.status, "briefing_email_pending", "[A-welcome] status explícito");
  const outbox = JSON.parse(kv.data.get("zpc:cp:welcome-outbox"));
  assert.equal(Object.keys(outbox).length, 1, "[A-welcome] na fila de boas-vindas");
  assert.ok(alertsOf(kv).some((a) => a.kind === "boas_vindas_falhou" && a.emailed === false), "[A-welcome] alerta gravado mesmo com o Resend fora");
  const again = await (await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-W", "SUB-W", "w@example.invalid"), e, null, f)).json();
  assert.notEqual(again.duplicate, true, "[A-welcome] reenvio da Hotmart não é tratado como duplicado");
  f.status = 200;
  const out = await CS.retryPendingPackages(e, f);
  assert.equal(out.welcome.sent, 1, "[A-welcome] cron envia");
  const mails = f.sent.filter((m) => m.to[0] === "w@example.invalid");
  assert.ok(mails.length >= 2 && new Set(mails.map((m) => m.text)).size === 1 && new Set(mails.map((m) => m.idem)).size === 1, "[A-welcome] mesmo link e mesma Idempotency-Key");
  assert.deepEqual(JSON.parse(kv.data.get("zpc:cp:welcome-outbox")), {}, "[A-welcome] sai da fila");
  const third = await (await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-W", "SUB-W", "w@example.invalid"), e, null, f)).json();
  assert.equal(third.duplicate, true, "[A-welcome] processado só depois do envio");
  const t = tokenOf(mails[0].text, "briefing");
  assert.equal((await brief(e, f, t)).status, 200, "[A-welcome] o link funciona");
});

test("[A-welcome-dead] boas-vindas que nunca saem: limite, fila de falhas com alerta e reenvio pelo operador", async () => {
  const f = resend({ status: 500 }), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-WD", "SUB-WD", "wd@example.invalid"), e, null, f);
  for (let i = 0; i < CS.PENDING_MAX_ATTEMPTS + 1; i++) await CS.retryPendingPackages(e, f);
  const dead = JSON.parse(kv.data.get("zpc:cp:pending-dead"));
  const key = subKey(kv);
  assert.equal(dead[key]?.kind, "welcome", "[A-welcome-dead] na fila de falhas");
  assert.ok(alertsOf(kv).some((a) => a.kind === "sem_entrega_welcome"), "[A-welcome-dead] alerta");
  f.status = 200;
  assert.equal((await CS.requeueDeadPackage(e, key, { operator: "renan", reason: "Resend voltou, reenvio manual" })).ok, true);
  const out = await CS.retryPendingPackages(e, f);
  assert.equal(out.welcome.sent, 1, "[A-welcome-dead] reenvio do operador entrega");
});

test("[A-operator] rota de operador: status sem dados pessoais; reenvio exige operador e motivo", async () => {
  const f = resend(), e = env(ai({ mode: "fail" })), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await brief(e, f, await subscribe(e, f, "SUB-O", "o@example.invalid"));
  for (let i = 0; i < CS.PENDING_MAX_ATTEMPTS + 1; i++) await CS.retryPendingPackages(e, f);
  const st = await CS.handleContentOperator(new Request("https://zevanory.api.br/api/admin/conteudo-pronto/status"), e);
  const body = await st.json();
  assert.equal(st.status, 200);
  assert.equal(body.dead.length, 1, "[A-operator] fila de falhas visível");
  assert.ok(body.alerts.some((a) => a.kind === "sem_entrega_package"), "[A-operator] alertas visíveis");
  assert.doesNotMatch(JSON.stringify(body), /@example|Assinante/, "[A-operator] sem e-mail nem nome");
  const sub = body.dead[0].sub;
  const req = (b) => CS.handleContentOperator(new Request("https://zevanory.api.br/api/admin/conteudo-pronto/requeue", { method: "POST", body: JSON.stringify(b) }), e);
  assert.equal((await req({ sub, operator: "renan", reason: "" })).status, 400, "[A-operator] motivo vazio recusado");
  assert.equal((await CS.requeueDeadPackage(e, subKey(kv), { operator: "renan", reason: "" })).ok, false, "[A-operator] requeue sem motivo recusado");
  assert.equal((await req({ sub, operator: "", reason: "motivo suficiente" })).status, 400, "[A-operator] sem operador recusado");
  assert.equal((await req({ sub, operator: "renan", reason: "IA voltou, reenvio manual" })).status, 200, "[A-operator] reenvio registrado");
  assert.equal((await req({ sub, operator: "renan", reason: "IA voltou, reenvio manual" })).status, 400, "[A-operator] não reabre duas vezes");
  e.AI = ai();
  assert.equal((await CS.retryPendingPackages(e, f)).delivered, 1, "[A-operator] entregue depois do reenvio");
  // A rota está ligada ao Worker de produção atrás do token de operador.
  const compat = (await import("node:fs")).readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url), "utf8");
  const at = compat.indexOf('url.pathname.startsWith("/api/admin/conteudo-pronto/")');
  assert.ok(at > 0 && /verifyOperatorToken[\s\S]{0,300}handleContentOperator/.test(compat.slice(at, at + 700)), "[A-operator] rota autenticada no Worker");
});

test("[A-dead-history] um segundo dead-letter preserva o histórico de operações", async () => {
  const f = resend(), e = env(ai({ mode: "fail" })), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await brief(e, f, await subscribe(e, f, "SUB-H2", "h2@example.invalid"));
  for (let i = 0; i < CS.PENDING_MAX_ATTEMPTS + 1; i++) await CS.retryPendingPackages(e, f);
  const key = subKey(kv);
  await CS.requeueDeadPackage(e, key, { operator: "renan", reason: "primeira tentativa manual" });
  for (let i = 0; i < CS.PENDING_MAX_ATTEMPTS + 1; i++) await CS.retryPendingPackages(e, f);
  const d = JSON.parse(kv.data.get("zpc:cp:pending-dead"))[key];
  assert.equal(d.status, "dead");
  assert.equal(d.operations.length, 1, "[A-dead-history] operação anterior preservada");
  assert.equal(d.history.length, 1, "[A-dead-history] dead-letter anterior registrado");
});

test("[A-lease] lease maior que o pior caso da geração; reenvio do formulário durante a geração não abre outra", async (t0) => {
  assert.ok(CS.GEN_WORST_CASE_MS >= 3 * 2 * 2 * 60000, "[A-lease] pior caso: 3 chamadas x 2 modelos x 2 tentativas x 60 s");
  assert.ok(CS.GEN_LEASE_MS > CS.GEN_WORST_CASE_MS, "[A-lease] lease cobre o pior caso");
  const slow = ai({ mode: "hang" });
  t0.after(() => slow.release());
  const f = resend(), e = env(slow), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await brief(e, f, await subscribe(e, f, "SUB-LS", "ls@example.invalid"), { waitUntil: () => {} });
  const calls = slow.calls.length;
  const r = await CS.generateAndDeliver(e, subKey(kv), f, { now: Date.now() + 10 * 60000 }); // 10 min depois, ainda gerando
  assert.equal(r.reason, "in_progress", "[A-lease] segunda geração recusada durante o pior caso");
  assert.equal(slow.calls.length, calls, "[A-lease] nenhuma chamada de IA nova");
});

test("[A-low] mutantes sobreviventes: legenda curta, reprocessamento, fila cheia, falha de envio conta tentativa", async () => {
  assert.equal(CS.validatePosts([{ ...post(1), legenda: "x".repeat(150) }], 1), null, "[A-low] legenda de 150 caracteres recusada");
  // APPROVED e COMPLETE da mesma transação depois da entrega: um pacote só.
  { const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
    await brief(e, f, await subscribe(e, f, "SUB-RP", "rp@example.invalid", "HP-RP"));
    const before = subRecord(kv);
    await CS.handleHotmartWebhook(hook("PURCHASE_COMPLETE", "HP-RP", "SUB-RP", "rp@example.invalid"), e, null, f);
    await CS.retryPendingPackages(e, f);
    assert.equal(deliveries(f).length, 1, "[A-low] reprocessar a mesma transação não reenvia o pacote");
    const after = subRecord(kv);
    for (const k of ["deliveredCycle", "deliveredAt", "lastPackage", "briefedAt"]) assert.equal(after[k], before[k], "[A-low] reprocessamento preserva " + k);
    assert.equal(JSON.parse(kv.data.get("zpc:cp:pending-log")).filter((x) => x.event === "enqueued").length, 1, "[A-low] reprocessamento não abre nova geração"); }
  // Fila cheia: recusa o novo, nunca descarta o mais antigo.
  { const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
    const t = await subscribe(e, f, "SUB-FULL", "full@example.invalid");
    const fake = Array.from({ length: 200 }, (_, i) => "zpc:cp:sub:fake" + i);
    kv.data.set("zpc:cp:pending", JSON.stringify(fake));
    await brief(e, f, t).catch(() => null);
    const q = JSON.parse(kv.data.get("zpc:cp:pending"));
    assert.equal(q[0], fake[0], "[A-low] fila cheia mantém o mais antigo");
    assert.equal(q.length, 200, "[A-low] fila cheia não cresce nem descarta"); }
  // Falha de envio do pacote conta tentativa (Resend fora do ar chega à fila de falhas).
  { const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
    const t = await subscribe(e, f, "SUB-EF", "ef@example.invalid");
    f.status = 500; await brief(e, f, t);
    const meta = JSON.parse(kv.data.get("zpc:cp:pending-meta"));
    assert.equal(Object.values(meta)[0].attempts, 1, "[A-low] falha de envio conta tentativa");
    assert.equal(Object.values(meta)[0].lastReason, "email_failed"); }
});

test("[A-text] textos ao assinante sem prazo não medido e com o limite de tentativas", async () => {
  const f = resend(), e = env(ai());
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-TX", "SUB-TX", "tx@example.invalid"), e, null, f);
  const welcome = f.sent.find((m) => m.to[0] === "tx@example.invalid").text;
  const t = tokenOf(welcome, "briefing");
  const form = await (await CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + t), e, null, f)).text();
  const done = await (await brief(e, f, t)).text();
  for (const [where, text] of [["boas-vindas", welcome], ["formulário", form], ["recebido", done]]) {
    assert.doesNotMatch(text, /poucos minutos|em minutos/i, "[A-text] sem prazo não medido: " + where);
    assert.match(text, new RegExp("até " + CS.PENDING_MAX_ATTEMPTS + " vezes"), "[A-text] limite de tentativas: " + where);
  }
});
