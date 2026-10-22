import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { handleLeadMagnet, runLeadNurture } from "../../worker/lead-magnet.mjs";
import salesPublicWorker from "../../worker/sales-public-worker.mjs";

const HOST = process.env.P08_PG_HOST;
const PORT = process.env.P08_PG_PORT || "5432";
const DB = "p08_leads";
if (!HOST) throw new Error("P08_PG_HOST precisa apontar para o PostgreSQL efêmero");

const lit = (value) => {
  if (value === null || value === undefined) return "NULL";
  if (Array.isArray(value)) return "'{" + value.map((item) => item === null ? "NULL" : '"' + String(item).replace(/["\\]/g, "\\$&") + '"').join(",") + "}'";
  return "'" + String(value).replace(/'/g, "''") + "'";
};
const args = (db) => ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "--csv", "-q", "-c"];
const parseCsv = (line) => {
  const cells = [];
  let value = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { cells.push(value); value = ""; }
    else value += char;
  }
  cells.push(value);
  return cells;
};
function psql(sql, db = DB) {
  const output = execFileSync("psql", [...args(db), sql], { encoding: "utf8" }).trim();
  const lines = output.split("\n").filter(Boolean);
  if (!lines.length || /^(INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE|DROP) /.test(lines[0])) return [];
  const columns = parseCsv(lines[0]);
  return lines.slice(1).filter((line) => !/^(INSERT|UPDATE|DELETE) /.test(line))
    .map((line) => Object.fromEntries(parseCsv(line).map((value, index) => [columns[index], value === "" ? null : value])));
}
const sqlFactory = () => ({ query: async (sql, params = []) => psql(sql.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]))) });
const kv = () => {
  const values = new Map();
  return { values, async get(key) { return values.get(key) ?? null; }, async put(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
};
const CONSENT_VERSION = "lead-magnet-v1-2026-10-07";
const CONSENT_TEXT = "Quero receber o checklist e até 2 e-mails com dicas e os produtos da ZEVANORY. Posso cancelar a qualquer momento. Li a Política de Privacidade.";
const mail = () => {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).href, "https://api.resend.com/emails", "toda chamada externa deve ser interceptada");
    sent.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  return sent;
};
const env = () => ({
  DATABASE_URL: "postgres://local-only",
  RESEND_API_KEY: "fake-p08-mail-key",
  LEAD_PRIVACY_SECRET: "p08-local-only-privacy-key-123456789",
  ZEVANORY_PRIVATE_ARTIFACTS: kv(),
});
const subscribe = async (environment, email, consent = true) => {
  const tasks = [];
  const form = new FormData();
  form.set("email", email);
  form.set("nome", "Pessoa de teste");
  form.set("consentimento", consent ? "sim" : "");
  const response = await salesPublicWorker.fetch(
    new Request("https://vendas.zevanory.api.br/material-gratuito/inscrever", {
      method: "POST",
      headers: {
        referer: "https://vendas.zevanory.api.br/material-gratuito",
        "cf-connecting-ip": email,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
      },
      body: form,
    }),
    {
      ...environment,
      BUY_LIMITER: { limit: async () => ({ success: true }) },
      CORE: {
        fetch: async (url, init) => {
          if (url === "https://leads.internal/subscribe") return handleLeadMagnet(new Request(url, init), environment, { sqlFactory });
          if (url === "https://funnel.internal/hit") return new Response("{}", { status: 200 });
          throw new Error("host externo inesperado no fake CORE: " + url);
        },
      },
    },
    { waitUntil: (promise) => tasks.push(promise) },
  );
  await Promise.all(tasks);
  return response;
};
const confirmationToken = (message) => {
  const match = message.match(/confirmar\?t=([0-9a-f]{64})/);
  assert.ok(match, "e-mail de confirmação contém token");
  return match[1];
};
const reset = () => psql("truncate zevanory_leads, zevanory_lead_events");

before(() => {
  try { psql("drop database if exists " + DB + " with (force)", "postgres"); } catch {}
  psql("create database " + DB, "postgres");
  const migrations = resolve("db/migrations");
  for (const filename of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    psql(readFileSync(resolve(migrations, filename), "utf8").replace(/^\uFEFF/, ""));
  }
});

test("registra data/hora, texto aceito, versão e origem do consentimento no PostgreSQL", async () => {
  const environment = env();
  const sent = mail();
  assert.equal((await subscribe(environment, "ana@exemplo.com")).status, 200);
  const lead = psql("select consent_at, consent_text, consent_version, source, status from zevanory_leads")[0];
  assert.ok(Number.isFinite(Date.parse(lead.consent_at)), "consentimento tem data/hora");
  assert.equal(lead.consent_text, CONSENT_TEXT);
  assert.equal(lead.consent_version, CONSENT_VERSION);
  assert.equal(lead.source, "material-gratuito");
  assert.equal(lead.status, "pending");
  assert.equal(sent.length, 1, "antes da confirmação só sai o pedido de double opt-in");
  assert.deepEqual(psql("select event, consent_version from zevanory_lead_events"), [{ event: "consent_given", consent_version: CONSENT_VERSION }]);
  assert.deepEqual(psql("select migration_id from schema_migrations where migration_id='030_lead_consent'"), [{ migration_id: "030_lead_consent" }]);
});

test("double opt-in inicia a sequência uma vez; GET não confirma e token não reutiliza", async () => {
  reset();
  const environment = env();
  const sent = mail();
  await subscribe(environment, "bia@exemplo.com");
  const token = confirmationToken(sent[0].text);
  const confirmationUrl = `https://zevanory.api.br/material-gratuito/confirmar?t=${token}`;

  const pending = await runLeadNurture(environment, { sqlFactory });
  assert.equal(pending.sent, 0);
  assert.equal(sent.length, 1, "lead pendente não recebe a sequência");
  assert.equal((await handleLeadMagnet(new Request(confirmationUrl), environment, { sqlFactory })).status, 200);
  assert.equal(psql("select status from zevanory_leads")[0].status, "pending", "GET de scanner não confirma");

  assert.equal((await handleLeadMagnet(new Request(confirmationUrl, { method: "POST" }), environment, { sqlFactory })).status, 200);
  assert.equal(psql("select status from zevanory_leads")[0].status, "confirmed");
  assert.equal(sent.length, 2, "a mensagem de conteúdo só sai após confirmação");
  assert.equal((await handleLeadMagnet(new Request(confirmationUrl, { method: "POST" }), environment, { sqlFactory })).status, 400);
  assert.equal(sent.length, 2, "reutilizar o token não dispara outro envio");
});

test("token expirado não confirma o lead nem envia conteúdo", async () => {
  reset();
  const environment = env();
  const sent = mail();
  await subscribe(environment, "caio@exemplo.com");
  const token = confirmationToken(sent[0].text);
  psql("update zevanory_leads set token_expires_at=now() - interval '1 second'");

  const result = await handleLeadMagnet(new Request(`https://zevanory.api.br/material-gratuito/confirmar?t=${token}`, { method: "POST" }), environment, { sqlFactory });
  assert.equal(result.status, 400);
  assert.equal(psql("select status from zevanory_leads")[0].status, "pending");
  assert.equal(sent.length, 1, "token expirado não gera e-mail de conteúdo");
});

test("opt-out de um clique é idempotente e impede qualquer envio posterior", async () => {
  reset();
  const environment = env();
  const sent = mail();
  await subscribe(environment, "dani@exemplo.com");
  const confirmationUrl = `https://zevanory.api.br/material-gratuito/confirmar?t=${confirmationToken(sent[0].text)}`;
  await handleLeadMagnet(new Request(confirmationUrl, { method: "POST" }), environment, { sqlFactory });
  const optOutMatch = sent[1].headers["List-Unsubscribe"].match(/<(https:\/\/[^>]+\/material-gratuito\/sair\?[^>]+)>/);
  assert.ok(optOutMatch, "e-mail confirmado oferece descadastro de um clique");
  const optOut = new Request(optOutMatch[1], { method: "POST" });

  assert.equal((await handleLeadMagnet(optOut, environment, { sqlFactory })).status, 200);
  assert.equal((await handleLeadMagnet(optOut, environment, { sqlFactory })).status, 200, "repetir opt-out mantém resposta idempotente");
  assert.equal(psql("select count(*)::int as count from zevanory_leads")[0].count, "0");
  const afterOptOut = await runLeadNurture(environment, { sqlFactory });
  assert.equal(afterOptOut.sent, 0);
  assert.equal(sent.length, 2, "nenhum envio ocorre depois do descadastro");
});

test("cadastro sem consentimento não persiste lead nem envia e-mail", async () => {
  reset();
  const environment = env();
  const sent = mail();
  assert.equal((await subscribe(environment, "eli@exemplo.com", false)).status, 400);
  assert.equal(psql("select count(*)::int as count from zevanory_leads")[0].count, "0");
  assert.equal(psql("select count(*)::int as count from zevanory_lead_events")[0].count, "0");
  assert.equal(sent.length, 0);
});
