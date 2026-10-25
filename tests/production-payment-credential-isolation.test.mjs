// F2 item 9 (roteiro 3.1 seção 7): separação de credenciais sandbox x produção provada pelo COMPORTAMENTO do código
// real, não por busca de texto. A sonda tests/helpers/payment-credential-probe.mjs executa o Worker de produção
// (worker/cloudflare-worker.compat.mjs -> cloudflare-worker.recovered.mjs) e o Worker de certificação
// (certification-worker.mjs) com credenciais SINTÉTICAS e um Mercado Pago falso que registra QUAL credencial recebeu.
// Como o Worker escolhe a credencial (lido do código):
//   * /api/webhooks?provider=mercadopago      -> handler16: MERCADOPAGO_ACCESS_TOKEN + MERCADOPAGO_WEBHOOK_SECRET
//   * /api/webhooks?provider=mercadopago_test -> MERCADOPAGO_TEST_ACCESS_TOKEN + MERCADOPAGO_TEST_WEBHOOK_SECRET,
//                                                certificationOnly (x-test-token: true)
//   * checkout: readinessFor("mercadopago") exige MERCADOPAGO_ACCESS_TOKEN + MERCADOPAGO_WEBHOOK_SECRET; o compat recusa
//     piloto fora de MERCADOPAGO_ENV/CERTIFICATION_PILOT_ENV = sandbox
//   * certification-worker safe(): recusa tudo se houver MERCADOPAGO_ACCESS_TOKEN/WEBHOOK_SECRET/PUBLIC_KEY etc.
// Sem rede, sem segredo real, sem banco (as recusas acontecem antes do banco; os controles positivos param na
// reconciliação, depois de o Worker já ter escolhido e usado a credencial). Cada asserção leva um marcador [Pn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = spawnSync(process.execPath, ["--import", "./tests/t4_sim/register.mjs", "tests/helpers/payment-credential-probe.mjs"],
  { cwd: ROOT, encoding: "utf8", timeout: 120000, env: { ...process.env, NODE_OPTIONS: "" } });
const line = String(run.stdout || "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
const probe = line ? JSON.parse(line.slice("PROBE_RESULT ".length)) : null;
function scenario(name) {
  assert.ok(probe && !probe.timeout && !probe.out?.error, "[P0.1] sonda sem resultado: " + String(probe?.out?.error || run.stderr || "").slice(-400));
  assert.deepEqual(probe.blocked.filter((h) => h !== "api.local"), [], "[P0.2] chamada externa inesperada");
  const s = probe.out[name];
  assert.ok(s, "[P0.3] cenário ausente: " + name);
  return s;
}

test("P1 produção só com credenciais de TESTE recusa webhook de pagamento de produção", () => {
  const signedWithTest = scenario("prod_webhook_only_test_signed_test");
  assert.equal(signedWithTest.status, 401, "[P1.1] assinatura com o segredo de TESTE não autentica a rota de produção");
  assert.equal(signedWithTest.error, "webhook_auth_failed", "[P1.1] recusa de autenticação");
  const unsigned = scenario("prod_webhook_only_test_unsigned");
  assert.equal(unsigned.status, 401, "[P1.2] sem segredo de produção nada autentica");
  assert.deepEqual([...signedWithTest.mp, ...unsigned.mp], [], "[P1.3] nenhuma consulta ao Mercado Pago");
});

test("P2 produção só com credenciais de TESTE recusa checkout de produção", () => {
  const entry = scenario("prod_checkout_only_test");
  assert.equal(entry.status, 503, "[P2.1] entrada do Worker recusa o checkout piloto em produção");
  assert.equal(entry.error, "certification_checkout_not_isolated", "[P2.1] motivo: produção não é sandbox isolado");
  const handler = scenario("prod_checkout_handler_only_test");
  assert.equal(handler.status, 503, "[P2.2] handler sem credencial de produção não cria preferência");
  assert.equal(handler.error, "payment_capacity_unavailable", "[P2.2] Mercado Pago indisponível sem credencial de produção");
  assert.deepEqual([...entry.mp, ...handler.mp], [], "[P2.2] nenhuma chamada ao Mercado Pago com o token de teste");
  const control = scenario("prod_checkout_handler_only_prod");
  assert.equal(control.error, "checkout_storage_unavailable", "[P2.3] controle: com credencial de produção o handler passa do provedor e para no banco");
});

test("P3 só com credenciais de PRODUÇÃO a rota de teste recusa", () => {
  const s = scenario("test_webhook_only_prod_signed_prod");
  assert.equal(s.status, 401, "[P3.1] segredo de produção não autentica a rota mercadopago_test");
  assert.deepEqual(s.mp, [], "[P3.1] nenhuma consulta ao Mercado Pago");
});

test("P4 assinatura cruzada é recusada nos dois sentidos com as duas credenciais presentes", () => {
  const prodRoute = scenario("prod_webhook_both_signed_test");
  assert.equal(prodRoute.status, 401, "[P4.1] rota de produção recusa assinatura com segredo de teste");
  assert.deepEqual(prodRoute.mp, [], "[P4.1] sem consulta");
  const testRoute = scenario("test_webhook_both_signed_prod");
  assert.equal(testRoute.status, 401, "[P4.2] rota de teste recusa assinatura com segredo de produção");
  assert.deepEqual(testRoute.mp, [], "[P4.2] sem consulta");
});

test("P5 sem queda (fallback) para o token do outro ambiente", () => {
  const prod = scenario("prod_webhook_prod_secret_test_token");
  assert.equal(prod.error, "financial_provider_unavailable", "[P5.1] produção sem token de produção para, mesmo com token de teste presente");
  assert.deepEqual(prod.mp, [], "[P5.1] o token de teste nunca é usado pela rota de produção");
  const tst = scenario("test_webhook_test_secret_prod_token");
  assert.equal(tst.error, "financial_provider_unavailable", "[P5.2] rota de teste sem token de teste para, mesmo com token de produção presente");
  assert.deepEqual(tst.mp, [], "[P5.2] o token de produção nunca é usado pela rota de teste");
});

test("P6 controles positivos: cada rota usa só a própria credencial", () => {
  const prod = scenario("prod_webhook_both_signed_prod");
  assert.equal(prod.mp.length, 1, "[P6.1] rota de produção autenticada consulta o pagamento uma vez");
  assert.equal(prod.mp[0].credential, "production", "[P6.1] com o token de PRODUÇÃO");
  assert.equal(prod.mp[0].test_header, false, "[P6.1] sem x-test-token");
  const tst = scenario("test_webhook_both_signed_test");
  assert.equal(tst.mp.length, 1, "[P6.2] rota de teste autenticada consulta o pagamento uma vez");
  assert.equal(tst.mp[0].credential, "test", "[P6.2] com o token de TESTE");
  assert.equal(tst.mp[0].test_header, true, "[P6.2] marcada com x-test-token");
});

test("P7 Worker de certificação recusa credenciais e rota de produção", () => {
  const prodToken = scenario("cert_webhook_with_prod_token");
  assert.equal(prodToken.error, "certification_isolation_unavailable", "[P7.1] token de produção presente => Worker sandbox indisponível");
  assert.deepEqual(prodToken.mp, [], "[P7.1] sem consulta");
  const prodSecret = scenario("cert_webhook_with_prod_secret");
  assert.equal(prodSecret.error, "certification_isolation_unavailable", "[P7.2] segredo de webhook de produção presente => indisponível");
  const prodRoute = scenario("cert_webhook_production_provider");
  assert.equal(prodRoute.status, 404, "[P7.3] rota provider=mercadopago (produção) não existe no Worker sandbox");
  const ok = scenario("cert_webhook_only_test");
  assert.equal(ok.mp.length, 1, "[P7.4] controle: só com credenciais de teste o Worker sandbox processa");
  assert.equal(ok.mp[0].credential, "test", "[P7.4] com o token de TESTE");
  assert.equal(ok.mp[0].test_header, true, "[P7.4] marcado com x-test-token");
});
