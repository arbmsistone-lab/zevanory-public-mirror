// R9 B / auditoria Sol 174: a conciliação somente leitura de pagamentos de PRODUÇÃO (mercadopago-prod-payments-readonly
// -> scripts/mercadopago_readonly_payments_audit.py) não pode depender do piloto sandbox de certificação.
// Causa raiz: o script lia pedidos em /api/internal/certification/e2e/status, rota do piloto que exige
// CERTIFICATION_PILOT_ENV=sandbox; sem o piloto na produção (R9 B) ela recusa com 409 e tudo virava ORDER_LOOKUP_FAILED.
// Correção: GET /api/internal/audit/order-lookup (credencial de operador, uma transação Postgres READ ONLY com um único
// SELECT, nenhuma chamada a provedor, nenhum dado simulado) e o script passa a usá-la.
//   L1 Worker REAL de produção SEM nenhum binding do piloto: a leitura funciona (sonda tests/helpers/order-lookup-probe.mjs).
//   L2 só leitura: exatamente uma transação READ ONLY com um SELECT de pedidos; nenhum Mercado Pago; nada além do SELECT.
//   L3 o piloto não muda nada: com CERTIFICATION_PILOT_* ligado o resultado é idêntico.
//   L4 controle de acesso: sem credencial/credencial errada 401, escrita 405, id inválido/lote grande 400, sem tocar o banco.
//   L5 a simulação do piloto continua recusada (409 fail-closed) com e sem piloto; controle: só passava com o piloto cru.
//   L6 o script REAL (harness tests/helpers/mp_readonly_audit_harness.py, urlopen simulado) usa só a rota de produção.
//   L7 contrato do módulo: sem transação READ ONLY disponível, recusa (503); rota fora da assinatura sem query (HMAC).
// Sem rede, sem segredo real, sem banco real. Cada asserção leva um marcador [Ln.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireTool } from "./helpers/toolchain.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = spawnSync(process.execPath, ["--import", "./tests/t4_sim/register.mjs", "tests/helpers/order-lookup-probe.mjs"],
  { cwd: ROOT, encoding: "utf8", timeout: 150000, env: { ...process.env, NODE_OPTIONS: "" } });
const line = String(run.stdout || "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
const probe = line ? JSON.parse(line.slice("PROBE_RESULT ".length)) : null;
function probed() {
  assert.ok(probe && !probe.timeout && !probe.out?.error, "[L0.1] sonda sem resultado: " + String(probe?.out?.error || run.stderr || "").slice(-400));
  assert.deepEqual(probe.blocked, [], "[L0.2] chamada externa inesperada");
  return probe.out;
}
const PRESENT = "1b2c3d4e-0000-4000-8000-00000000a001";
const PILOT_ORDER = "1b2c3d4e-0000-4000-8000-00000000a002";
const MISSING = "1b2c3d4e-0000-4000-8000-00000000a0ff";
// Esperado por raciocínio a partir do fixture da sonda (não copiado de uma execução).
const EXPECTED_BODY = {
  schema: "zevanory.audit.order-lookup/v1", read_only: true, requested: 3,
  orders: [
    { order_id: PRESENT, amount: 197, currency: "BRL", status: "paid", provider: "mercadopago", certification_pilot: false },
    { order_id: PILOT_ORDER, amount: 5, currency: "BRL", status: "refunded", provider: "mercadopago", certification_pilot: true },
  ],
  missing: [MISSING],
};

test("L1 produção sem nenhum binding do piloto: leitura de pedidos somente leitura funciona", () => {
  const r = probed().no_pilot.lookup_ok;
  assert.equal(r.status, 200, "[L1.1] status 200 sem piloto (obtido " + r.status + " " + r.error + ")");
  assert.deepEqual(r.body, EXPECTED_BODY, "[L1.2] pedidos de produção lidos do banco, faltante listado");
});

test("L2 só leitura: uma transação READ ONLY com um único SELECT de pedidos, nenhum provedor", () => {
  const r = probed().no_pilot.lookup_ok;
  assert.equal(r.sql.length, 1, "[L2.1] exatamente uma ida ao banco");
  const [call] = r.sql;
  assert.equal(call.batch, true, "[L2.2] consulta enviada como transação");
  assert.equal(call.read_only, "true", "[L2.2] transação marcada Neon-Batch-Read-Only=true");
  assert.equal(call.queries.length, 1, "[L2.3] um único comando na transação");
  const q = call.queries[0].query;
  assert.match(q, /^select\s/i, "[L2.3] o comando é SELECT");
  assert.match(q, /\bfrom orders\b/i, "[L2.3] lê só a tabela de pedidos");
  assert.doesNotMatch(q, /\b(insert|update|delete|merge|upsert|alter|drop|truncate|create|grant|call|do)\b|;/i, "[L2.3] nenhuma escrita/DDL");
  assert.deepEqual(call.queries[0].params, [[PRESENT, PILOT_ORDER, MISSING].join(",")], "[L2.4] parâmetro só com os ids pedidos");
  assert.equal(r.mp_calls, 0, "[L2.5] nenhuma chamada ao Mercado Pago");
});

test("L3 com CERTIFICATION_PILOT_* ligado o resultado é idêntico (não depende do piloto)", () => {
  const out = probed();
  assert.equal(out.with_pilot.lookup_ok.status, 200, "[L3.1] status 200 com piloto no env");
  assert.deepEqual(out.with_pilot.lookup_ok.body, out.no_pilot.lookup_ok.body, "[L3.1] corpo idêntico com e sem piloto");
  assert.deepEqual(out.with_pilot.lookup_ok.sql, out.no_pilot.lookup_ok.sql, "[L3.2] mesma consulta com e sem piloto");
});

test("L4 controle de acesso e validação antes de tocar o banco", () => {
  const out = probed();
  const EXPECT = { lookup_bad_token: [401, "unauthorized"], lookup_no_token: [401, "unauthorized"], lookup_post: [405, "method_not_allowed"],
    lookup_invalid_id: [400, "order_id_invalid"], lookup_too_many: [400, "order_lookup_limit_exceeded"] };
  for (const variant of ["no_pilot", "with_pilot"]) {
    for (const [name, [status, error]] of Object.entries(EXPECT)) {
      const r = out[variant][name];
      const marker = status === 401 ? "[L4.1]" : status === 405 ? "[L4.2]" : "[L4.3]";
      assert.deepEqual([r.status, r.error], [status, error], `${marker} ${variant}/${name} (obtido ${r.status} ${r.error})`);
      assert.deepEqual(r.sql, [], `[L4.4] ${variant}/${name}: banco não consultado`);
    }
  }
});

test("L5 a simulação do piloto continua recusada (fail-closed) na produção", () => {
  const out = probed();
  for (const variant of ["no_pilot", "with_pilot"]) {
    const r = out[variant].pilot_status;
    assert.deepEqual([r.status, r.error], [409, "certification_e2e_not_fail_closed"], `[L5.1] ${variant}: rota do piloto recusa (obtido ${r.status} ${r.error})`);
    assert.deepEqual(r.sql, [], `[L5.1] ${variant}: rota do piloto não lê o banco`);
  }
  assert.notEqual(out.control_old_path_raw_pilot?.error, "certification_e2e_not_fail_closed",
    "[L5.2] controle: só com o piloto cru a rota antiga passava da trava (era a dependência)");
});

let harness = null;
function harnessed() {
  if (harness) return harness;
  requireTool("python3");
  const r = spawnSync("python3", ["-I", "-B", "tests/helpers/mp_readonly_audit_harness.py", ROOT], { cwd: ROOT, encoding: "utf8",
    timeout: 60000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const l = String(r.stdout || "").split("\n").find((x) => x.startsWith("HARNESS_RESULT "));
  assert.ok(l, "[L6.0] harness sem resultado: " + String(r.stderr || "").slice(-400));
  harness = JSON.parse(l.slice("HARNESS_RESULT ".length));
  return harness;
}

test("L6 script real de conciliação usa só a rota de produção somente leitura", () => {
  const h = harnessed();
  assert.equal(h.exit, 0, "[L6.1] script termina sem erro: " + String(h.log_tail).slice(-300));
  assert.deepEqual(h.calls.filter((c) => c.path.startsWith("/api/internal/certification/")), [], "[L6.2] nenhuma chamada à rota do piloto");
  assert.deepEqual(h.calls.filter((c) => c.method !== "GET" || c.has_body), [], "[L6.3] toda requisição é GET sem corpo");
  const app = h.calls.filter((c) => c.host === "zevanory.api.br");
  assert.deepEqual(app.map((c) => c.path), ["/api/internal/audit/order-lookup"], "[L6.4] um único lote na rota de produção");
  assert.equal(app[0].operator_header, true, "[L6.4] autenticada com a credencial de operador");
  assert.deepEqual(app[0].query.order_id, ["2a3b4c5d-0000-4000-8000-00000000b001", "2a3b4c5d-0000-4000-8000-00000000b002", "2a3b4c5d-0000-4000-8000-00000000b0ff"],
    "[L6.4] só referências UUID, ordenadas, sem repetição");
  assert.deepEqual(h.reasons, {
    9001: ["ORDER_AMOUNT_MATCH", true], 9002: ["ORDER_MISSING_OR_AMOUNT_MISMATCH", false],
    9003: ["ORDER_MISSING_OR_AMOUNT_MISMATCH", false], 9004: ["NO_VALID_ORDER_REFERENCE", false],
  }, "[L6.5] conciliação por pedido e valor; nenhum ORDER_LOOKUP_FAILED");
  assert.equal(h.unreconciled, 3, "[L6.5] aprovados sem conciliação contados");
  assert.deepEqual(h.row_keys, ["concilia_mesmo_valor", "data", "external_reference", "motivo", "payment_id", "status", "valor"], "[L6.6] relatório sem campo interno");
});

test("L7 contrato do módulo: transação READ ONLY obrigatória; rota fora da assinatura HMAC sem query", async () => {
  const { handleInternalFinancialAudit, ORDER_LOOKUP_PATH } = await import("../worker/internal-financial-audit.mjs");
  const { AUDIT_READ_PATHS } = await import("../worker/signed-audit-probe.mjs");
  const OP = "synthetic-production-operator-token-0123456789ab";
  const req = (ip) => new Request("https://zevanory.api.br" + ORDER_LOOKUP_PATH + "?order_id=" + PRESENT, { headers: { "x-certification-e2e-token": OP, "cf-connecting-ip": ip } });
  const env = { ZEVANORY_OPERATOR_TOKEN: OP, DATABASE_URL: "postgresql://synthetic:synthetic@db.invalid/zevanory" };
  const queried = [];
  const noTx = () => ({ query: async (q) => { queried.push(q); return []; } });
  const r1 = await handleInternalFinancialAudit(req("10.77.0.1"), env, { sqlFactory: noTx });
  assert.ok(r1, "[L7.1] rota reconhecida pelo módulo de auditoria");
  assert.deepEqual([r1.status, (await r1.json()).error, queried.length], [503, "read_only_transaction_unavailable", 0], "[L7.1] sem transação READ ONLY: recusa sem consultar");
  const seen = [];
  const tx = () => ({ query: (q, p) => ({ q, p }), transaction: async (list, opts) => { seen.push({ n: list.length, opts }); return [[]]; } });
  const r2 = await handleInternalFinancialAudit(req("10.77.0.2"), env, { sqlFactory: tx });
  assert.deepEqual([r2.status, seen], [200, [{ n: 1, opts: { readOnly: true } }]], "[L7.2] transação única com readOnly=true");
  assert.equal(AUDIT_READ_PATHS.has(ORDER_LOOKUP_PATH), false, "[L7.3] sonda HMAC (assina só o caminho) não vale para a leitura por id");
});
