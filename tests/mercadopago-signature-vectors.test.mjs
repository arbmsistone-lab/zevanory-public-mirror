// Roteiro v4.4, seção 7 ("Vetores de teste reproduzíveis pelo auditor"): x-signature Mercado Pago.
// Cada vetor de data/test-vectors/mercadopago-signature-v1.json passa pela função REAL do Worker de produção:
// verifyMercadoPagoSignature (e normalizeMercadoPagoWebhook, safeText2) são EXTRAÍDAS do texto de
// worker/cloudflare-worker.recovered.mjs, como em tests/mercadopago-webhook-signature.test.mjs (sem cópia).
// O "now" é injetado pelo vetor (fixo), então o resultado é determinístico. Segredo FICTÍCIO, sem rede.
// Recálculo independente sem Node: scripts/ci/mp_vectors_openssl.sh (OpenSSL). Mutantes causais:
// scripts/ci/mutants_mp_signature_vectors.py (classificador compartilhado scripts/ci/mutant_classifier.py).
// Cada asserção carrega um marcador [Vnn.x] que os mutantes conferem dentro do bloco `not ok` do teste.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readTextNormalized } from "./helpers/text.mjs";

const SRC = readTextNormalized(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url));
const DOC = JSON.parse(readTextNormalized(new URL("../data/test-vectors/mercadopago-signature-v1.json", import.meta.url)));

function trecho(inicio, fim) {
  const a = SRC.indexOf(inicio);
  const b = SRC.indexOf(fim, a);
  assert.ok(a > 0 && b > a, `trecho não encontrado no Worker: ${inicio}`);
  assert.equal(SRC.indexOf(inicio, a + 1), -1, `trecho não único no Worker: ${inicio}`);
  return SRC.slice(a, b);
}
const CODIGO = [
  trecho("var safeText2 = ", "function buildMercadoPagoPreference("),
  trecho("function normalizeMercadoPagoWebhook(", "__name(normalizeMercadoPagoWebhook"),
  trecho("function verifyMercadoPagoSignature(", "__name(verifyMercadoPagoSignature"),
].join("\n");
const { verify, normalize } = new Function("crypto5", "Buffer", "__name",
  `${CODIGO}\nreturn { verify: verifyMercadoPagoSignature, normalize: normalizeMercadoPagoWebhook };`)(crypto, Buffer, (f) => f);

const hmac = (m) => crypto.createHmac("sha256", DOC.secret).update(m).digest("hex");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Modelo oficial: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;", par ausente removido, data.id em minúsculas.
const specManifest = (id, rid, ts) => `${id ? `id:${String(id).toLowerCase()};` : ""}${rid ? `request-id:${rid};` : ""}${ts ? `ts:${ts};` : ""}`;

// Mesmo caminho do handleMercadoPagoWebhook: normaliza corpo+URL, lê os headers e chama a verificação real.
function runVector(v, nowMs) {
  const webhook = normalize(v.request.body, v.request.url);
  assert.ok(webhook, `[${v.id}.normalize] corpo/URL do vetor precisam ser aceitos pelo normalizador real`);
  const h = v.request.headers;
  return verify({ signature: String(h["x-signature"] || ""), requestId: String(h["x-request-id"] || ""),
    dataId: webhook.paymentId, secret: DOC.secret, now: nowMs });
}
const byId = Object.fromEntries(DOC.vectors.map((v) => [v.id, v]));

test("V00 arquivo de vetores: segredo FICTÍCIO, campos recalculáveis e cobertura mínima", () => {
  assert.equal(DOC.schema, "zevanory.test-vectors.mercadopago-signature.v1", "[V00.schema]");
  assert.match(DOC.secret, /FICTITIOUS/, "[V00.fictitious]");
  assert.equal(DOC.secret_is_fictitious, true, "[V00.fictitious]");
  assert.equal(DOC.window_ms, 10 * 60 * 1000, "[V00.window]");
  const ids = DOC.vectors.map((v) => v.id);
  assert.deepEqual(ids, [...new Set(ids)], "[V00.unique]");
  const names = new Set(DOC.vectors.map((v) => v.name));
  for (const req of ["valid", "v1_altered_one_char", "data_id_altered", "x_request_id_altered", "x_request_id_missing",
    "ts_out_of_window_past", "x_signature_missing", "header_space_around_equals", "replay_same_request_twice"]) {
    assert.ok(names.has(req), `[V00.coverage] vetor obrigatório ausente: ${req}`);
  }
  for (const v of DOC.vectors) {
    const id = v.request.query["data.id"];
    assert.equal(v.request.body.data.id, id, `[V00.body] ${v.id}`);
    assert.equal(v.manifest, specManifest(id, v.request.headers["x-request-id"], v.parsed_per_spec.ts), `[V00.manifest] ${v.id}`);
    assert.equal(v.expected_v1, hmac(v.manifest), `[V00.hmac] ${v.id}`);
    assert.equal(v.sha256_manifest, sha(v.manifest), `[V00.sha] ${v.id}`);
    assert.equal(v.sha256_expected_v1, sha(v.expected_v1), `[V00.sha] ${v.id}`);
    if (v.signed_manifest !== null) assert.equal(v.presented_v1, hmac(v.signed_manifest), `[V00.presented] ${v.id}`);
    assert.equal(v.hmac_matches, v.presented_v1 !== null && v.presented_v1.toLowerCase() === v.expected_v1, `[V00.matches] ${v.id}`);
    assert.ok(["accept", "refuse"].includes(v.expected), `[V00.expected] ${v.id}`);
  }
});

const ONE_SHOT = {
  V01: "assinatura válida é aceita",
  V02: "v1 alterado em 1 caractere é recusado",
  V03: "data.id alterado é recusado",
  V04: "x-request-id alterado é recusado",
  V05: "x-request-id ausente é recusado mesmo com HMAC oficial sem request-id (D1)",
  V06: "x-request-id ausente é recusado mesmo com HMAC de 'request-id:;'",
  V07: "ts 601 s no passado é recusado (now injetado)",
  V08: "ts 601 s no futuro é recusado (now injetado)",
  V09: "ts exatamente 600 s no passado é aceito (borda inclusiva)",
  V10: "x-signature ausente é recusado",
  V11: "partes invertidas com espaços ao redor das vírgulas são aceitas",
  V12: "espaço ao redor de '=' é recusado (D2)",
  V13: "separador ';' no lugar de ',' é recusado",
  V14: "assinatura que não cobre o x-request-id presente é recusada",
};
for (const [id, title] of Object.entries(ONE_SHOT)) {
  test(`${id} ${title}`, () => {
    const v = byId[id];
    assert.ok(v, `[${id}.present] vetor ausente no JSON`);
    assert.ok(!v.calls, `[${id}.present] vetor de chamada única`);
    assert.equal(runVector(v, v.now_ms) ? "accept" : "refuse", v.expected, `[${id}.verdict] ${v.name}: ${v.why}`);
  });
}

test("V15 replay: a mesma notificação entregue duas vezes dentro da janela (lacuna registrada, não fingida)", () => {
  const v = byId.V15;
  assert.ok(v && Array.isArray(v.calls) && v.calls.length === 2, "[V15.present]");
  const got = v.calls.map((c) => (runVector(v, c.now_ms) ? "accept" : "refuse"));
  assert.equal(got[0], v.calls[0].expected, "[V15.first] 1ª entrega");
  assert.equal(got[1], v.calls[1].expected, "[V15.second] 2ª entrega idêntica (mesmo ts, mesmo x-request-id)");
  // A verificação é pura e sem estado: se um dia passar a recusar a repetição, este vetor TEM de ser revisto
  // (gap fechado) — por isso a lacuna precisa estar declarada enquanto a repetição for aceita.
  if (got[1] === "accept") {
    assert.equal(v.gap?.id, "GAP-MP-SIG-REPLAY", "[V15.gap] repetição aceita exige a lacuna declarada no vetor");
    assert.equal(v.gap?.status, "open", "[V15.gap]");
  }
});
