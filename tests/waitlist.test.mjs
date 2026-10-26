// Lista de espera real (worker/waitlist.mjs) e consentimento v2 do checklist (worker/lead-magnet.mjs): testes sem banco.
// O comportamento com PostgreSQL REAL (inscrição, dupla confirmação, aviso único, retenção, separação do material
// gratuito) está em tests/integration/waitlist-postgres.test.mjs. Rótulos [Wn.k] são usados pelos mutantes
// (scripts/ci/mutants_waitlist.py, classificador compartilhado).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { handleWaitlist, runWaitlistNotify, waitlistEnabled, waitlistConsentText, WAITLIST_CONSENT_VERSION, WAITLIST_PRODUCTS, WAITLIST_HAS_DATA_KEY } from "../worker/waitlist.mjs";
import { CONSENT_FOLLOWUPS, CONSENT_V2_VERSION, CONSENT_V2_TEXT, signupConsentVersion, handleLeadMagnet, runLeadNurture, subjectRef } from "../worker/lead-magnet.mjs";
import { waitlistHref, WAITLIST_FORM } from "../worker/politica-unica.mjs";
import { fakeDb, kv, mailbox } from "./helpers/p09-lead-fakes.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => readTextNormalized(join(ROOT, f));
const POLICY = JSON.parse(read("data/politica-unica.json"));
const WL = JSON.parse(read("data/lista-de-espera.json"));
const V1 = "lead-magnet-v1-2026-10-07";
const SECRET = "s".repeat(40);
const boom = (what) => { throw new Error("acesso proibido com a lista desligada: " + what); };
const trap = () => ({
  sqlFactory: () => boom("banco"),
  fetchImpl: async () => boom("rede"),
  env: (extra = {}) => ({ DATABASE_URL: "postgres://x", RESEND_API_KEY: "re_x", LEAD_PRIVACY_SECRET: SECRET,
    ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => boom("kv"), put: async () => boom("kv"), delete: async () => boom("kv") }, ...extra }),
});
// Uma exceção (acesso proibido) vira resultado comparável: a falha aparece como asserção com rótulo, não como erro.
const settle = async (p) => { try { return await p; } catch (e) { return { status: "threw: " + (e?.message || e), sent: "threw" }; } };
const req = (path, method = "GET", body) => new Request("https://zevanory.api.br" + path, { method, ...(body ? { body, headers: { "content-type": "application/x-www-form-urlencoded" } } : {}) });

test("W1 desligada (padrão): toda rota /lista-de-espera responde 404 antes de banco, KV ou rede", async () => {
  const t = trap();
  for (const value of [undefined, "", "1", "TRUE", "True", "on", "yes", " true", "true ", "false"]) {
    const env = t.env(value === undefined ? {} : { WAITLIST_ENABLED: value });
    assert.equal(waitlistEnabled(env), false, `[W1.1] só "true" exato liga: ${JSON.stringify(value)}`);
    for (const [path, method] of [["/lista-de-espera?produto=lucro-e-caixa", "GET"], ["/lista-de-espera/", "GET"], ["/lista-de-espera/inscrever", "POST"],
      ["/lista-de-espera/confirmar?t=" + "a".repeat(64), "POST"], ["/lista-de-espera/sair?r=" + "a".repeat(64) + "&t=" + "b".repeat(32), "POST"], ["/lista-de-espera/qualquer", "GET"]]) {
      const res = await settle(handleWaitlist(req(path, method), env, { sqlFactory: t.sqlFactory, fetchImpl: t.fetchImpl, salesOpen: false }));
      assert.equal(res.status, 404, `[W1.2] ${method} ${path} com ${JSON.stringify(value)}`);
      assert.equal(res.headers.get("cache-control"), "no-store", "[W1.2] no-store");
    }
  }
  for (const path of ["/lista-de-esperas", "/listas", "/material-gratuito/inscrever", "/"]) assert.equal(await handleWaitlist(req(path), t.env({ WAITLIST_ENABLED: "true" }), {}), null, "[W1.3] fora do prefixo: " + path);
});

test("W2 job de aviso com a lista desligada: nada é enviado, nem com vendas abertas; sem dados guardados, nenhum acesso ao banco", async () => {
  const t = trap();
  const noData = { DATABASE_URL: "postgres://x", RESEND_API_KEY: "re_x", ZEVANORY_PRIVATE_ARTIFACTS: kv() };
  const out = await settle(runWaitlistNotify(noData, { sqlFactory: t.sqlFactory, fetchImpl: t.fetchImpl, salesOpen: true }));
  assert.deepEqual([out.ok, out.sent, out.skipped, out.retention], [true, 0, "waitlist_disabled", undefined], "[W2.1]");
  // Com dados de quando estava ligada: só a retenção roda (apaga), nunca seleciona confirmados nem envia.
  const store = kv(); await store.put(WAITLIST_HAS_DATA_KEY, "1");
  const queries = [];
  const sql = () => ({ query: async (q) => { queries.push(q.replace(/\s+/g, " ").trim()); return []; } });
  const out2 = await runWaitlistNotify({ ...noData, ZEVANORY_PRIVATE_ARTIFACTS: store }, { sqlFactory: sql, fetchImpl: t.fetchImpl, salesOpen: true });
  assert.equal(out2.sent, 0, "[W2.2]");
  assert.ok(queries.some((q) => /^delete from zevanory_waitlist w where/.test(q)), "[W2.3] retenção roda");
  assert.ok(!queries.some((q) => /status='notifying'|status='confirmed' group by/.test(q)), "[W2.4] nenhuma reserva nem seleção para aviso");
});

test("W3 regra da política: formulário só com waitlist_form.enabled=true; hoje (false) o CTA continua mailto", async () => {
  assert.equal(POLICY.contato_publico.waitlist_form.enabled, false, "[W3.1] desligado no repositório");
  assert.equal(WAITLIST_FORM.enabled, false);
  assert.equal(POLICY.contato_publico.waitlist_form.flag_env, WL.flag.env);
  for (const [name, slug] of Object.entries(POLICY.contato_publico.waitlist_form.produtos)) {
    assert.match(waitlistHref(name), /^mailto:suporte@zevanory\.api\.br\?subject=/, "[W3.2] mailto: " + name);
    assert.equal(WAITLIST_PRODUCTS[slug], name);
  }
  // Mesma árvore com enabled=true (cópia temporária): o CTA vira o formulário do produto, no Worker e no build (Python).
  const dir = mkdtempSync(join(tmpdir(), "wl-policy-"));
  try {
    for (const d of ["worker", "data", "scripts"]) mkdirSync(join(dir, d), { recursive: true });
    cpSync(join(ROOT, "worker/politica-unica.mjs"), join(dir, "worker/politica-unica.mjs"));
    cpSync(join(ROOT, "scripts/sales_policy.py"), join(dir, "scripts/sales_policy.py"));
    const P = JSON.parse(JSON.stringify(POLICY)); P.contato_publico.waitlist_form.enabled = true;
    writeFileSync(join(dir, "data/politica-unica.json"), JSON.stringify(P));
    const mod = await import(pathToFileURL(join(dir, "worker/politica-unica.mjs")).href);
    assert.equal(mod.waitlistHref("Lucro & Caixa"), "https://zevanory.api.br/lista-de-espera?produto=lucro-e-caixa", "[W3.3] Worker");
    assert.match(mod.waitlistHref("Produto que não está no mapa"), /^mailto:/, "[W3.4] fora do mapa continua mailto");
    const py = spawnSync(process.platform === "win32" ? "python" : "python3", ["-B", "-c", "import sys; sys.path.insert(0, 'scripts'); import sales_policy as p; print(p.waitlist_href('Conteúdo Pronto'))"], { cwd: dir, encoding: "utf8" });
    assert.equal(py.stdout.trim(), "https://zevanory.api.br/lista-de-espera?produto=conteudo-pronto", "[W3.5] build " + py.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W4 nunca ligada automaticamente: nenhum workflow, wrangler, gerador ou módulo define WAITLIST_ENABLED ou LEAD_CONSENT_V2", () => {
  const files = [];
  const walk = (d) => { if (!existsSync(join(ROOT, d))) return; for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r); else files.push(r); } };
  for (const d of [".github/workflows", "scripts", "worker"]) walk(d);
  for (const f of readdirSync(ROOT)) if (/^wrangler.*\.(toml|jsonc?)$/.test(f)) files.push(f);
  // Atribuição a um valor (YAML/TOML/JSON/Python/JS), fora de comentários; leitura e comparação (!==, ===) não contam.
  const setters = /\b(WAITLIST_ENABLED|LEAD_CONSENT_V2)["']?\s*\]?\s*(:|=(?!=))\s*["'`]?[A-Za-z0-9$]/;
  const code = (t) => t.split("\n").filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).map((l) => l.replace(/\s(#|\/\/)\s.*$/, "")).join("\n");
  const hits = files.filter((f) => /\.(ya?ml|toml|jsonc?|py|mjs|js|sh)$/.test(f)).filter((f) => setters.test(code(read(f))));
  assert.deepEqual(hits, [], "[W4.1] quem define a flag");
  assert.equal(WL.flag.default, "off"); assert.equal(WL.flag.on_value, "true");
  assert.match(read("worker/waitlist.mjs"), /String\(env\?\.\[WL\.flag\.env\] \?\? ""\) === WL\.flag\.on_value/, "[W4.2] flag lida só do ambiente");
});

test("W5 separação (A272-02): a lista de espera nunca toca o material gratuito, e vice-versa", () => {
  const wl = read("worker/waitlist.mjs").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(wl, /zevanory_lead|lead-magnet|leads\.internal|nurture/i, "[W5.1] waitlist.mjs não lê nem escreve leads");
  for (const f of ["worker/lead-magnet.mjs", "scripts/p09/nurture-sequence.mjs", "scripts/p09/nurture_gate.mjs"]) {
    assert.doesNotMatch(read(f), /zevanory_waitlist|waitlist\.mjs|lista-de-espera/i, "[W5.2] " + f + " não lê a lista de espera");
  }
  assert.match(wl, /select email from zevanory_waitlist where status='confirmed' group by email/, "[W5.3] destinatários do aviso só da lista confirmada");
  assert.notEqual(WAITLIST_CONSENT_VERSION, V1); assert.notEqual(WAITLIST_CONSENT_VERSION, CONSENT_V2_VERSION);
  assert.ok(!Object.prototype.hasOwnProperty.call(CONSENT_FOLLOWUPS, WAITLIST_CONSENT_VERSION), "[W5.4] o consentimento da lista nunca vale para a nutrição");
});

test("W6 consentimento próprio: finalidade única, retenção, saída, controladora e CNPJ; versão exigida no envio", async () => {
  const s = POLICY.resumo_oferta.fornecedor;
  for (const slug of Object.keys(WAITLIST_PRODUCTS)) {
    const t = waitlistConsentText(slug);
    assert.ok(t.includes(WAITLIST_PRODUCTS[slug]), slug);
    for (const must of ["um único e-mail", "avisando quando as vendas", "Finalidade: somente esse aviso", "não entro na lista do material gratuito",
      "apagados logo depois", "no máximo 30 dias depois de as vendas abrirem", "em até 12 meses", "Posso sair a qualquer momento",
      `Controladora: ${s.razao_social} (ZEVANORY), CNPJ ${s.cnpj}`, "suporte@zevanory.api.br"]) assert.ok(t.includes(must), `[W6.1] ${slug}: ${must}`);
    assert.doesNotMatch(t, /[{}]/, "[W6.2] sem marcador");
  }
  assert.match(WAITLIST_CONSENT_VERSION, /^lista-de-espera-v\d+-\d{4}-\d{2}-\d{2}$/);
  // Com a lista ligada: formulário com o texto, a versão e a caixa obrigatória; versão errada recusada ANTES do banco.
  const t = trap();
  const env = { DATABASE_URL: "postgres://x", RESEND_API_KEY: "re_x", LEAD_PRIVACY_SECRET: SECRET, WAITLIST_ENABLED: "true", ZEVANORY_PRIVATE_ARTIFACTS: kv() };
  const form = await (await handleWaitlist(req("/lista-de-espera?produto=lucro-e-caixa"), env, { sqlFactory: () => ({ query: async () => boom("banco no GET") }), fetchImpl: t.fetchImpl })).text();
  assert.ok(form.includes(waitlistConsentText("lucro-e-caixa").replace(/&/g, "&amp;")), "[W6.3] texto no formulário");
  assert.match(form, /name="consentimento" value="sim" required/);
  assert.ok(form.includes(`name="versao_consentimento" value="${WAITLIST_CONSENT_VERSION}"`));
  for (const body of [`email=a%40b.com&produto=lucro-e-caixa&consentimento=sim&versao_consentimento=outra`, `email=a%40b.com&produto=lucro-e-caixa&versao_consentimento=${WAITLIST_CONSENT_VERSION}`]) {
    const r = await settle(handleWaitlist(req("/lista-de-espera/inscrever", "POST", body), env, { sqlFactory: () => ({ query: async () => boom("banco sem consentimento") }), fetchImpl: t.fetchImpl }));
    assert.equal(r.status, 400, "[W6.4] sem consentimento válido: " + body);
  }
  // Vendas abertas: não guarda nada.
  const open = await settle(handleWaitlist(req("/lista-de-espera/inscrever", "POST", `email=a%40b.com&produto=lucro-e-caixa&consentimento=sim&versao_consentimento=${WAITLIST_CONSENT_VERSION}`), env, { sqlFactory: () => ({ query: async () => boom("banco com vendas abertas") }), fetchImpl: t.fetchImpl, salesOpen: true }));
  assert.equal(open.status, 200, "[W6.5]");
  assert.match(await open.text(), /As vendas estão abertas/, "[W6.5] texto");
});

test("W7 consentimento v2 do checklist: até 5 e-mails, só com a trava LEAD_CONSENT_V2 e o texto v2 mostrado; nunca retroativo", async () => {
  assert.equal(CONSENT_FOLLOWUPS[V1], 2, "[W7.1] v1 continua no limite (checklist + 2)");
  assert.equal(CONSENT_FOLLOWUPS[CONSENT_V2_VERSION], 4, "[W7.2] v2: checklist + 4 = 5 e-mails");
  assert.match(CONSENT_V2_TEXT, /até 5 e-mails/);
  for (const [env, posted, want] of [[{}, CONSENT_V2_VERSION, V1], [{ LEAD_CONSENT_V2: "true" }, CONSENT_V2_VERSION, V1], [{ LEAD_CONSENT_V2: CONSENT_V2_VERSION }, "", V1],
    [{ LEAD_CONSENT_V2: CONSENT_V2_VERSION }, V1, V1], [{ LEAD_CONSENT_V2: CONSENT_V2_VERSION }, CONSENT_V2_VERSION, CONSENT_V2_VERSION]]) {
    assert.equal(signupConsentVersion(env, posted), want, `[W7.3] trava ${JSON.stringify(env)} + versão enviada ${posted}`);
  }
  const sub = (env, body) => handleLeadMagnet(new Request("https://leads.internal/subscribe", { method: "POST", body: JSON.stringify(body) }), env, { sqlFactory: db.factory });
  const db = fakeDb(); const store = kv(); const sent = mailbox();
  const base = { DATABASE_URL: "postgres://x", RESEND_API_KEY: "re_x", LEAD_PRIVACY_SECRET: SECRET, ZEVANORY_PRIVATE_ARTIFACTS: store };
  await sub(base, { email: "off@x.com", consent: true, consent_version: CONSENT_V2_VERSION });
  await sub({ ...base, LEAD_CONSENT_V2: CONSENT_V2_VERSION }, { email: "on@x.com", consent: true, consent_version: CONSENT_V2_VERSION });
  assert.equal(db.rows.get("off@x.com").consent_version, V1, "[W7.4] trava desligada: registra v1");
  assert.equal(db.rows.get("on@x.com").consent_version, CONSENT_V2_VERSION, "[W7.5] trava ligada + texto v2: registra v2");
  // Contato antigo (v1, confirmado) que se inscreve de novo com o texto v2: continua v1 (nunca retroativo).
  db.rows.set("old@x.com", { email: "old@x.com", email_hash: "", subject_ref: await subjectRef(base, "old@x.com"), name: null, consent_version: V1, status: "confirmed", nurture_step: 3, nurture_at: new Date(Date.now() - 20 * 86400e3).toISOString() });
  await sub({ ...base, LEAD_CONSENT_V2: CONSENT_V2_VERSION }, { email: "old@x.com", consent: true, consent_version: CONSENT_V2_VERSION });
  assert.equal(db.rows.get("old@x.com").consent_version, V1, "[W7.6] confirmado v1 não muda de versão");
  // Nutrição: v1 para no 3º e-mail (passo 3 = limite), v2 recebe os passos 3 e 4.
  const old = new Date(Date.now() - 20 * 86400e3).toISOString();
  db.rows.set("v2@x.com", { email: "v2@x.com", email_hash: "", subject_ref: await subjectRef(base, "v2@x.com"), name: null, consent_version: CONSENT_V2_VERSION, status: "confirmed", nurture_step: 3, nurture_at: old });
  sent.length = 0;
  await runLeadNurture(base, { sqlFactory: db.factory, salesOpen: true });
  assert.equal(db.rows.get("old@x.com").nurture_step, 5, "[W7.7] v1 encerrado no limite");
  assert.ok(!sent.some((m) => m.to[0] === "old@x.com"), "[W7.8] v1 não recebe o 4º e-mail");
  assert.equal(sent.filter((m) => m.to[0] === "v2@x.com").length, 1, "[W7.9] v2 recebe o passo 3");
  assert.equal(db.rows.get("v2@x.com").nurture_step, 4);
  // A sequência P09 aceita a v2 e continua desligada (P09_NURTURE_SEND).
  const seq = JSON.parse(read("content/p09/checklist-v2/sequence.json"));
  assert.deepEqual(seq.consent.accepted_versions, [V1, CONSENT_V2_VERSION], "[W7.10]");
  assert.equal(seq.send_switch.default, "off"); assert.equal(seq.retroactive, false);
});
