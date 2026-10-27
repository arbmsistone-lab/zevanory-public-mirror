// P09 Nutrição: contrato do gate scripts/p09/nurture_gate.mjs e da política de envio scripts/p09/nurture-sequence.mjs
// (sem promessa de ganho; descadastro em 1 clique; nada sem consentimento; cliques e ações, nunca abertura).
// Sem rede, sem segredo, nada é enviado: cada caso do gate monta uma cópia mínima da árvore num diretório temporário,
// altera UMA coisa e roda o gate real. Marcadores [Nn.k] identificam a asserção para o classificador de mutantes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { canSend, renderEmail, prepareEmail, prepareEmailOnce, memoryLedger, idempotencyKey } from "../scripts/p09/nurture-sequence.mjs";
import { handleLeadMagnet, leadOptOutLink, runLeadNurture } from "../worker/lead-magnet.mjs";
import { fakeDb, kv, mailbox } from "./helpers/p09-lead-fakes.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEQ_DIR = "content/p09/checklist-v2";
const FILES = ["worker/lead-magnet.mjs", "worker/brand-email.mjs", "worker/activity-ledger.mjs", "worker/politica-unica.mjs", "data/politica-unica.json",
  "data/products.json", "checklist-15-minutos/index.html", "material-gratuito/index.html",
  ...["lucro-e-caixa", "vendas-na-pratica", "ia-na-pratica", "negocio-completo", "checklist-15-minutos", "material-gratuito"].map((s) => `sales-public/${s}.html`),
  ...readdirSync(join(REPO, "scripts/p09")).map((f) => `scripts/p09/${f}`), ...readdirSync(join(REPO, SEQ_DIR)).map((f) => `${SEQ_DIR}/${f}`)];

function gate(edits = {}) {
  const root = mkdtempSync(join(tmpdir(), "p09-"));
  try {
    for (const rel of FILES) { mkdirSync(dirname(join(root, rel)), { recursive: true }); copyFileSync(join(REPO, rel), join(root, rel)); }
    for (const [rel, fn] of Object.entries(edits)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      let cur = "";
      try { cur = readTextNormalized(join(root, rel)); } catch {}
      const next = fn(cur);
      assert.notEqual(next, cur, `fixture: edição sem efeito em ${rel}`);
      writeFileSync(join(root, rel), next);
    }
    const r = spawnSync(process.execPath, [join(root, "scripts/p09/nurture_gate.mjs"), "--root", root], { encoding: "utf8" });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const fails = (r, re, label) => { assert.equal(r.code, 1, `${label} esperado FAIL:\n${r.out}`); assert.match(r.out, re, `${label} motivo:\n${r.out}`); };
const seqJson = (fn) => ({ [`${SEQ_DIR}/sequence.json`]: (s) => JSON.stringify(fn(JSON.parse(s)), null, 2) });
const tpl = (file, fn) => ({ [`${SEQ_DIR}/${file}`]: fn });

const SEQ = JSON.parse(readTextNormalized(join(REPO, SEQ_DIR, "sequence.json")));
const TEMPLATES = Object.fromEntries(SEQ.emails.map((e) => [e.file, readTextNormalized(join(REPO, SEQ_DIR, e.file))]));
const PRODUCTS = JSON.parse(readTextNormalized(join(REPO, "data/products.json"))).products;
const V1 = "lead-magnet-v1-2026-10-07";
const ON = { P09_NURTURE_SEND: "checklist-v2" };
const LEAD = { status: "confirmed", consent_version: V1, consent_at: "2026-10-20T10:00:00Z", confirmed_at: "2026-10-20T10:05:00Z", unsubscribed_at: null };
const OPT = "https://zevanory.api.br/material-gratuito/sair?r=" + "a".repeat(64) + "&t=" + "b".repeat(32);

test("N1 sequência real e Worker passam; v1 libera só os passos 0-2", () => {
  const r = gate();
  assert.equal(r.code, 0, "[N1.1] " + r.out);
  assert.match(r.out, /P09_CONSENT sequence=checklist-v2 version=lead-magnet-v1-2026-10-07 followups=2 sendable_steps=0,1,2 blocked_steps=3,4/, "[N1.2]");
  assert.match(r.out, /version=lead-magnet-v2-2026-10-25 .*sendable_steps=0,1,2,3 blocked_steps=4/, "[N1.2a] vendas abertas não liberam oferta para a base gratuita");
  assert.match(r.out, /P09_SEQUENCE id=checklist-v2 .* emails=5 commercial=1 switch=P09_NURTURE_SEND:off-by-default metric=clicks\+actions/, "[N1.3]");
});
test("N2 promessa de ganho reprova", () => fails(gate(tpl("03-ia.txt", (s) => s.replace("Com o tempo,", "Com isso você vai faturar mais e,"))), /promessa de ganho/, "[N2.1]"));
test("N3 urgência artificial reprova", () => fails(gate(tpl("05-materiais.txt", (s) => s.replace("Se agora não é o momento", "Oferta por tempo limitado. Se agora não é o momento"))), /urgência/, "[N3.1]"));
test("N4 prova social inventada reprova", () => fails(gate(tpl("02-vendas.txt", (s) => s.replace("O checklist completo", "Veja o que nossos clientes dizem. O checklist completo"))), /prova social/, "[N4.1]"));
test("N5 promessa corrigida no #927 reprova", () => fails(gate(tpl("05-materiais.txt", (s) => s.replace("modelos de mensagens", "prospecção e modelos de mensagens"))), /promessa corrigida no #927/, "[N5.1]"));
test("N6 e-mail sem assinatura com descadastro reprova", () => fails(gate(tpl("03-ia.txt", (s) => s.replace("{{assinatura}}", "Equipe ZEVANORY"))), /exatamente um \{\{assinatura\}\}/, "[N6.1]"));
test("N7 renderização leva o descadastro no texto e os cabeçalhos de 1 clique", () => {
  for (const e of SEQ.emails) {
    const m = renderEmail({ sequence: SEQ, templates: TEMPLATES, step: e.step, optOutUrl: OPT, products: PRODUCTS });
    assert.ok(m.text.includes(OPT), "[N7.1] passo " + e.step);
    assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "[N7.2]");
    assert.ok(m.headers["List-Unsubscribe"].startsWith(`<${OPT}>`), "[N7.3]");
  }
  assert.throws(() => renderEmail({ sequence: SEQ, templates: TEMPLATES, step: 0, optOutUrl: "", products: PRODUCTS }), /optout_url_required/, "[N7.4]");
});
test("N8 interruptor desligado por padrão: só o id exato liga", () => {
  for (const env of [{}, { P09_NURTURE_SEND: "" }, { P09_NURTURE_SEND: "on" }, { P09_NURTURE_SEND: "true" }, { P09_NURTURE_SEND: "checklist-v1" }, { P09_NURTURE_SEND: "checklist-v2 " }]) {
    assert.equal(canSend({ env, sequence: SEQ, step: 0, lead: LEAD }).reason, "switch_off", "[N8.1] " + JSON.stringify(env));
  }
  assert.equal(canSend({ env: ON, sequence: SEQ, step: 0, lead: LEAD }).ok, true, "[N8.2]");
});
test("N9 nada sem consentimento confirmado e vigente", () => {
  for (const lead of [null, { ...LEAD, status: "pending" }, { ...LEAD, consent_at: null }, { ...LEAD, confirmed_at: null }, { ...LEAD, unsubscribed_at: "2026-10-21T00:00:00Z" }]) {
    assert.equal(canSend({ env: ON, sequence: SEQ, step: 0, lead }).reason, "no_confirmed_consent", "[N9.1] " + JSON.stringify(lead));
  }
});
test("N10 consentimento v1 (até 2 e-mails) limita a sequência", () => {
  assert.equal(canSend({ env: ON, sequence: SEQ, step: 2, lead: LEAD }).ok, true, "[N10.1]");
  assert.equal(canSend({ env: ON, sequence: SEQ, step: 3, lead: LEAD }).reason, "consent_cap", "[N10.2]");
  assert.equal(canSend({ env: ON, sequence: SEQ, step: 4, lead: LEAD, salesOpen: true }).reason, "consent_cap", "[N10.3]");
});
test("N11 versão de consentimento não aceita ou desconhecida bloqueia", () => {
  assert.equal(canSend({ env: ON, sequence: SEQ, step: 0, lead: { ...LEAD, consent_version: "outra" } }).reason, "consent_version_not_accepted", "[N11.1]");
  const seq = { ...SEQ, consent: { ...SEQ.consent, accepted_versions: [V1, "fantasma"] } };
  assert.equal(canSend({ env: ON, sequence: seq, step: 0, lead: { ...LEAD, consent_version: "fantasma" } }).reason, "consent_version_unknown", "[N11.2]");
});
test("N12 e-mail comercial não usa o consentimento do material gratuito, nem com vendas abertas", () => {
  const cf = { [V1]: 4 };
  assert.equal(canSend({ env: ON, sequence: SEQ, step: 4, lead: LEAD, consentFollowups: cf }).reason, "commercial_consent_not_implemented", "[N12.1]");
  assert.equal(canSend({ env: ON, sequence: SEQ, step: 4, lead: LEAD, consentFollowups: cf, salesOpen: true }).reason, "commercial_consent_not_implemented", "[N12.2] salesOpen não autoriza oferta");
});
test("N13 métrica por abertura reprova", () => {
  fails(gate(seqJson((s) => { s.emails[1].metric = "opens"; return s; })), /metric deve ser clicks ou actions/, "[N13.1]");
  fails(gate(seqJson((s) => { s.metrics.never = []; return s; })), /metrics.never deve conter opens/, "[N13.2]");
});
test("N14 número sem fonte reprova", () => {
  fails(gate(tpl("03-ia.txt", (s) => s.replace("Com o tempo,", "Em 10 dias,"))), /número 10 sem fonte declarada/, "[N14.1]");
  fails(gate(seqJson((s) => { s.emails[1].numbers[1].source.contains = "Faça 9 follow-ups"; return s; })), /trecho "Faça 9 follow-ups" não aparece/, "[N14.2]");
});
test("N15 conteúdo fora das Características essenciais reprova", () => fails(gate({ ...tpl("05-materiais.txt", (s) => s.replace("planilha de aplicação (XLSX)", "planilha de aplicação (XLSX) e mentoria ao vivo")), ...seqJson((s) => { s.emails[4].claims.push({ slug: "ia-na-pratica", text: "mentoria ao vivo" }); return s; }) }), /"mentoria ao vivo" não está nas Características essenciais de ia-na-pratica/, "[N15.1]"));
test("N16 comercial sem arrependimento ou sem identificação, ou preço sem flag comercial, reprova", () => {
  fails(gate(tpl("05-materiais.txt", (s) => s.replace("Você pode desistir em {{regra_7d}}, sem justificativa e com devolução integral.", ""))), /sem \{\{regra_7d\}\}/, "[N16.1]");
  fails(gate(tpl("05-materiais.txt", (s) => s.replace("{{identificacao}}", ""))), /sem \{\{identificacao\}\}/, "[N16.2]");
  fails(gate(seqJson((s) => { s.emails[4].commercial = false; return s; })), /precisa de commercial=true/, "[N16.3]");
});
test("N17 link de checkout reprova", () => fails(gate(seqJson((s) => { s.emails[4].links.lucro_e_caixa = "https://vendas.zevanory.api.br/comprar/ZEV-LCX-011"; return s; })), /link de checkout no e-mail/, "[N17.1]"));
test("N18 link cru ou pixel no texto reprova", () => {
  fails(gate(tpl("01-checklist.txt", (s) => s.replace("{{link:checklist}}", "https://vendas.zevanory.api.br/checklist-15-minutos"))), /link cru, imagem ou pixel/, "[N18.1]");
  fails(gate(tpl("03-ia.txt", (s) => s.replace("Com o tempo,", '<img src="x" width="1" height="1"> Com o tempo,'))), /link cru, imagem ou pixel/, "[N18.2]");
});
test("N19 consentimento publicado diferente do modelo do P08 reprova", () => fails(gate({ "material-gratuito/index.html": (s) => s.replace(/até 2 e-mails/, "até 4 e-mails") }), /consentimento publicado diz "até 4 e-mails"/, "[N19.1]"));
test("N20 versão de consentimento fora do modelo do P08 reprova", () => fails(gate(seqJson((s) => { s.consent.accepted_versions = ["lead-magnet-v2-proposta"]; return s; })), /não existe no modelo do P08/, "[N20.1]"));
test("N21 interruptor que não nasce desligado reprova", () => {
  fails(gate(seqJson((s) => { s.send_switch.default = "on"; return s; })), /desligado por padrão/, "[N21.1]");
  fails(gate(seqJson((s) => { s.send_switch.on_value = "on"; return s; })), /desligado por padrão/, "[N21.2]");
});
test("N22 workflow que liga o envio reprova (nada envia a partir do CI)", () => fails(gate({ ".github/workflows/x.yml": () => "env:\n  P09_NURTURE_SEND: checklist-v2\n" }), /define P09_NURTURE_SEND/, "[N22.1]"));
test("N23 acesso de rede no módulo do P09 reprova", () => fails(gate({ "scripts/p09/nurture-sequence.mjs": (s) => s + '\nexport const send = () => fetch("https://api.resend.com/emails");\n' }), /acesso de rede no código do P09/, "[N23.1]"));
test("N24 promessa de ganho na sequência viva do Worker reprova", () => fails(gate({ "worker/lead-magnet.mjs": (s) => s.replace("Esta mensagem é apenas uma dica prática; não contém oferta.", "Com isso você vai vender mais.") }), /Worker passo 1 .*promessa de ganho/, "[N24.1]"));
test("N25 salvaguarda do Worker removida reprova", () => fails(gate({ "worker/lead-magnet.mjs": (s) => s.replace("const cap = 1 + (CONSENT_FOLLOWUPS[lead.consent_version] ?? 0);", "const cap = 99;") }), /salvaguarda ausente.*limite do consentimento/, "[N25.1]"));
test("N26 prepareEmail só monta quando pode enviar", () => {
  const off = prepareEmail({ env: {}, sequence: SEQ, templates: TEMPLATES, step: 0, lead: LEAD, optOutUrl: OPT, products: PRODUCTS });
  assert.deepEqual(off, { send: false, reason: "switch_off" }, "[N26.1]");
  const on = prepareEmail({ env: ON, sequence: SEQ, templates: TEMPLATES, step: 1, lead: LEAD, optOutUrl: OPT, products: PRODUCTS, name: "Ana" });
  assert.equal(on.send, true, "[N26.2]");
  assert.match(on.message.text, /^Olá, Ana!/, "[N26.3]");
  assert.match(on.message.text, /utm_campaign=p09v2-e2-vendas/, "[N26.4]");
});

const REF = "c".repeat(64);
const LEADR = { ...LEAD, subject_ref: REF };
test("N27 descadastro ponta a ponta pelo código real: link -> consentimento revogado -> nenhuma mensagem preparada", async () => {
  const realFetch = globalThis.fetch;
  try {
    const db = fakeDb(); const sent = mailbox(); const store = kv();
    const env = { DATABASE_URL: "x", RESEND_API_KEY: "re_test_123456789", LEAD_PRIVACY_SECRET: "k".repeat(40), ZEVANORY_PRIVATE_ARTIFACTS: store };
    const opts = { sqlFactory: db.factory };
    const sub = await handleLeadMagnet(new Request("https://leads.internal/subscribe", { method: "POST", body: JSON.stringify({ email: "ana@exemplo.com", consent: true, page: "/checklist" }) }), env, opts);
    assert.equal(sub.status, 200, "[N27.1]");
    const token = /confirmar\?t=([0-9a-f]{64})/.exec(sent.at(-1).text)[1];
    const conf = await handleLeadMagnet(new Request("https://zevanory.api.br/material-gratuito/confirmar", { method: "POST", body: new URLSearchParams({ t: token }) }), env, opts);
    assert.equal(conf.status, 200, "[N27.2]");
    const row = db.rows.get("ana@exemplo.com");
    const lead = () => { const r = db.rows.get("ana@exemplo.com"); return r ? { ...r, confirmed_at: "x" } : null; };
    const optOutUrl = await leadOptOutLink(env, row.email, row.subject_ref);
    const ledger = memoryLedger();
    const before = await prepareEmailOnce({ env: ON, sequence: SEQ, templates: TEMPLATES, step: 1, lead: lead(), optOutUrl, products: PRODUCTS, ledger });
    assert.equal(before.send, true, "[N27.3] antes do descadastro o passo 1 é preparado");
    assert.ok(before.message.text.includes(optOutUrl) && before.message.headers["List-Unsubscribe"].includes(optOutUrl), "[N27.4] a mensagem leva o MESMO link exercido abaixo");
    const u = new URL(optOutUrl);
    const get = await handleLeadMagnet(new Request("https://zevanory.api.br" + u.pathname + u.search), env, opts);
    assert.equal(get.status, 200, "[N27.5] GET do link só mostra a confirmação (não apaga)");
    assert.ok(db.rows.has("ana@exemplo.com"), "[N27.5]");
    const post = await handleLeadMagnet(new Request("https://zevanory.api.br" + u.pathname + u.search, { method: "POST" }), env, opts);
    assert.equal(post.status, 200, "[N27.6]");
    assert.equal(db.rows.has("ana@exemplo.com"), false, "[N27.7] consentimento revogado: dados do lead apagados");
    assert.ok(db.events.some((e) => e.event === "revoked_and_erased" && e.subject_ref === row.subject_ref), "[N27.8] revogação registrada");
    for (let step = 0; step < SEQ.emails.length; step += 1) {
      const after = await prepareEmailOnce({ env: ON, sequence: SEQ, templates: TEMPLATES, step, lead: lead(), optOutUrl, products: PRODUCTS, ledger: memoryLedger(), salesOpen: true });
      assert.deepEqual(after, { send: false, reason: "no_confirmed_consent" }, "[N27.9] passo " + step);
    }
    const n = sent.length;
    await runLeadNurture(env, { sqlFactory: db.factory, salesOpen: true, now: Date.now() + 30 * 864e5 });
    assert.equal(sent.length, n, "[N27.10] a nutrição viva também não envia nada depois do descadastro");
  } finally { globalThis.fetch = realFetch; }
});
test("N28 preparação repetida e concorrente do mesmo contato+passo gera uma única mensagem", async () => {
  const ledger = memoryLedger();
  const args = { env: ON, sequence: SEQ, templates: TEMPLATES, step: 1, lead: LEADR, optOutUrl: OPT, products: PRODUCTS, ledger };
  const out = await Promise.all(Array.from({ length: 100 }, () => prepareEmailOnce(args)));
  assert.equal(out.filter((r) => r.send).length, 1, "[N28.1]");
  assert.ok(out.filter((r) => !r.send).every((r) => r.reason === "duplicate"), "[N28.2]");
  assert.equal(out.find((r) => r.send).idempotencyKey, `zevanory-p09-checklist-v2-${REF}-s1`, "[N28.3]");
  for (let i = 0; i < 10; i += 1) assert.equal((await prepareEmailOnce(args)).send, false, "[N28.4] repetição sequencial");
  assert.throws(() => idempotencyKey(SEQ, "ana@exemplo.com", 1), /contact_ref_required/, "[N28.5] a chave nunca usa o e-mail");
});
test("N29 o limite de mensagens por contato resiste a tentativas repetidas e concorrentes de todos os passos", async () => {
  const ledger = memoryLedger();
  const attempts = [];
  for (let k = 0; k < 20; k += 1) for (const e of SEQ.emails) attempts.push(prepareEmailOnce({ env: ON, sequence: SEQ, templates: TEMPLATES, step: e.step, lead: LEADR, optOutUrl: OPT, products: PRODUCTS, ledger, salesOpen: true }));
  const out = await Promise.all(attempts);
  const sentSteps = out.filter((r) => r.send).map((r) => Number(r.idempotencyKey.split("-s").at(-1))).sort();
  assert.deepEqual(sentSteps, [0, 1, 2], "[N29.1] consentimento v1: no máximo checklist + 2 e-mails, uma vez cada");
  assert.equal(ledger.perContact.get(REF), 3, "[N29.2]");
  assert.deepEqual(await ledger.reserve("outra-chave", REF, 3), { ok: false, reason: "contact_limit" }, "[N29.3] o registro recusa a 4ª mensagem do contato mesmo com chave nova");
  const other = await prepareEmailOnce({ env: ON, sequence: SEQ, templates: TEMPLATES, step: 0, lead: { ...LEADR, subject_ref: "d".repeat(64) }, optOutUrl: OPT, products: PRODUCTS, ledger });
  assert.equal(other.send, true, "[N29.4] outro contato não é afetado");
});
test("N30 nunca retroativo: só quem consentiu N mensagens recebe N", () => {
  const cf = { [V1]: 2, "lead-magnet-v2-hipotetica": 4 };
  const seq = { ...SEQ, consent: { ...SEQ.consent, accepted_versions: [V1, "lead-magnet-v2-hipotetica"] } };
  for (const step of [3, 4]) assert.equal(canSend({ env: ON, sequence: seq, step, lead: LEAD, salesOpen: true, consentFollowups: cf }).reason, "consent_cap", "[N30.1] contato antigo (v1) não recebe o passo " + step);
  assert.equal(canSend({ env: ON, sequence: seq, step: 4, lead: { ...LEAD, consent_version: "lead-magnet-v2-hipotetica" }, salesOpen: true, consentFollowups: cf }).reason, "commercial_consent_not_implemented", "[N30.2] consentimento informativo nunca vira consentimento comercial");
  assert.equal(canSend({ env: ON, sequence: { ...SEQ, retroactive: true }, step: 0, lead: LEAD }).reason, "retroactive_not_allowed", "[N30.3]");
  const noFlag = { ...SEQ }; delete noFlag.retroactive;
  assert.equal(canSend({ env: ON, sequence: noFlag, step: 0, lead: LEAD }).reason, "retroactive_not_allowed", "[N30.4] sem a declaração, fecha");
});
test("N31 sequência declarada retroativa reprova no gate", () => {
  fails(gate(seqJson((s) => { s.retroactive = true; return s; })), /retroactive deve ser false/, "[N31.1]");
  fails(gate(seqJson((s) => { delete s.consent.coverage_rule; return s; })), /coverage_rule deve declarar a regra 'nunca retroativo'/, "[N31.2]");
});
