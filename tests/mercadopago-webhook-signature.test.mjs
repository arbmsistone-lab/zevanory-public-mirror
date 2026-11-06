// B05 / G9 (D7): assinatura do webhook Mercado Pago provada com o código REAL do Worker de produção.
// As funções verifyMercadoPagoSignature, normalizeMercadoPagoWebhook e safeText2 são EXTRAÍDAS do texto de
// worker/cloudflare-worker.recovered.mjs (não há cópia): qualquer mudança no Worker é testada aqui.
// Sem rede, sem segredo real (segredo sintético), sem operação financeira.
//
// Referência oficial (consultada em 21/10/2026):
//   https://omega.mercadopago.com.br/developers/es/docs/qr-code/notifications  (aba "sem SDK")
//   https://mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks
// Regras citadas: x-signature "ts=...,v1=..." separado por vírgula; manifesto
// "id:[data.id_url];request-id:[x-request-id_header];ts:[ts_header];"; HMAC SHA256 em hexadecimal;
// data.id alfanumérico deve ir em minúsculas; valor ausente deve ser removido do manifesto; tolerância de
// atraso a critério do integrador (o Worker usa 10 min, simétrica).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";
import { extractMpSignatureRegion } from "./helpers/mp-signature-region.mjs";

const SRC = readTextNormalized(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url));
function trecho(inicio, fim) {
  const a = SRC.indexOf(inicio);
  const b = SRC.indexOf(fim, a);
  assert.ok(a > 0 && b > a, `trecho não encontrado no Worker: ${inicio}`);
  return SRC.slice(a, b);
}
// Roteiro seção 7: o código executado aqui é a "região de assinatura" (tests/helpers/mp-signature-region.mjs, definição
// em scripts/deploy/mp-signature-region.json). Seu SHA-256 é o mp_signature_region_sha256 do build-info (S12, S13).
const REGIAO = extractMpSignatureRegion(SRC);
const CODIGO = REGIAO.code;
const { verify, normalize } = new Function("crypto5", "Buffer", "__name",
  `${CODIGO}\nreturn { verify: verifyMercadoPagoSignature, normalize: normalizeMercadoPagoWebhook };`)(crypto, Buffer, (f) => f);

const SECRET = "b05-segredo-sintetico-nao-real";
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const TS = String(Math.floor(NOW / 1000));
const hmac = (manifest, secret = SECRET) => crypto.createHmac("sha256", secret).update(manifest).digest("hex");
const manifesto = (id, req, ts) => `id:${id};request-id:${req};ts:${ts};`;
const assinar = ({ id = "123456789", req = "req-b05-1", ts = TS, secret = SECRET } = {}) => `ts=${ts},v1=${hmac(manifesto(id, req, ts), secret)}`;
const ok = (o = {}) => verify({ signature: assinar(), requestId: "req-b05-1", dataId: "123456789", secret: SECRET, now: NOW, ...o });

test("S1 assinatura válida é aceita (ts em segundos e em milissegundos, como no exemplo oficial)", () => {
  assert.equal(ok(), true);
  const tsMs = String(NOW - 1234);
  assert.equal(ok({ signature: assinar({ ts: tsMs }) }), true, "ts de 13 dígitos (milissegundos) entra no manifesto como recebido");
});

test("S2 segredo errado e segredo ausente são recusados", () => {
  assert.equal(ok({ signature: assinar({ secret: "outro-segredo-sintetico" }) }), false);
  assert.equal(ok({ secret: "" }), false);
  assert.equal(ok({ secret: undefined }), false);
});

test("S3 adulteração de data.id, x-request-id ou ts invalida a assinatura", () => {
  assert.equal(ok({ dataId: "123456780" }), false, "data.id trocado");
  assert.equal(ok({ requestId: "req-b05-2" }), false, "x-request-id trocado");
  const v1 = assinar().split("v1=")[1];
  assert.equal(ok({ signature: `ts=${Number(TS) + 1},v1=${v1}` }), false, "ts do header trocado sem nova assinatura");
  const ultimo = v1.at(-1) === "0" ? "1" : "0";
  assert.equal(ok({ signature: `ts=${TS},v1=${v1.slice(0, -1)}${ultimo}` }), false, "um único dígito hexadecimal diferente");
  assert.equal(ok({ signature: `ts=${TS},v1=${hmac(`id:123456789;request-id:req-b05-1;ts:${TS}`)}` }), false, "manifesto sem o ';' final");
});

test("S4 janela de 10 min: dentro aceita; fora (passado ou futuro) recusa", () => {
  const em = (deltaMs) => { const ts = String(Math.floor((NOW + deltaMs) / 1000)); return ok({ signature: assinar({ ts }) }); };
  assert.equal(em(-10 * 60 * 1000), true, "exatamente 10 min atrás");
  assert.equal(em(+10 * 60 * 1000), true, "exatamente 10 min à frente");
  assert.equal(em(-(10 * 60 + 1) * 1000), false, "10 min + 1 s atrás");
  assert.equal(em(+(10 * 60 + 1) * 1000), false, "10 min + 1 s à frente");
  assert.equal(em(-3600 * 1000), false, "1 h atrás (replay)");
  assert.equal(em(+3600 * 1000), false, "1 h à frente");
});

test("S5 cabeçalhos ausentes ou incompletos são recusados (inclusive com HMAC correto do resto)", () => {
  assert.equal(ok({ signature: "" }), false, "x-signature ausente");
  assert.equal(ok({ signature: undefined }), false);
  assert.equal(ok({ requestId: "" }), false, "x-request-id ausente");
  assert.equal(ok({ requestId: "", signature: assinar({ req: "" }) }), false, "x-request-id ausente mesmo com HMAC de 'request-id:;'");
  assert.equal(ok({ signature: `v1=${hmac(manifesto("123456789", "req-b05-1", ""))}` }), false, "sem ts (manifesto com ts vazio)");
  assert.equal(ok({ signature: `v1=${hmac("id:123456789;request-id:req-b05-1;")}` }), false, "sem ts (manifesto sem a parte ts)");
  assert.equal(ok({ signature: `ts=${TS}` }), false, "sem v1");
  assert.equal(ok({ signature: `ts=${TS},v1=` }), false, "v1 vazio");
  assert.equal(ok({ signature: `ts=${TS},v1=${"a".repeat(63)}` }), false, "v1 com tamanho errado (não lança exceção)");
  assert.equal(ok({ signature: `ts=abc,v1=${hmac(manifesto("123456789", "req-b05-1", "abc"))}` }), false, "ts não numérico");
  assert.equal(ok({ requestId: "req\u0000b05" , signature: assinar({ req: "req\u0000b05" }) }), false, "x-request-id com caractere de controle");
});

test("S6 formato do header: espaço após vírgula, ordem invertida, v1 maiúsculo e parte desconhecida são aceitos", () => {
  const v1 = assinar().split("v1=")[1];
  assert.equal(ok({ signature: `ts=${TS}, v1=${v1}` }), true, "espaço após a vírgula");
  assert.equal(ok({ signature: ` v1=${v1} ,  ts=${TS} ` }), true, "ordem invertida com espaços nas bordas");
  assert.equal(ok({ signature: `ts=${TS},v1=${v1.toUpperCase()}` }), true, "hexadecimal maiúsculo");
  assert.equal(ok({ signature: `ts=${TS},v2=xyz,v1=${v1}` }), true, "parte extra ignorada");
});

test("S7 divergência D2 (fail-closed): espaço ao redor de '=' é recusado (o exemplo oficial em Node aplica trim em chave e valor)", () => {
  const v1 = assinar().split("v1=")[1];
  assert.equal(ok({ signature: `ts = ${TS}, v1 = ${v1}` }), false);
});

test("S8 divergência D1 (fail-closed): sem x-request-id, manifesto oficial sem a parte request-id é recusado", () => {
  // Documentação: valor ausente deve ser REMOVIDO do manifesto. O Worker exige x-request-id e recusa;
  // o caminho 401 enfileira a reconciliação pelo provedor (provado no teste PostgreSQL M20).
  const sig = `ts=${TS},v1=${hmac(`id:123456789;ts:${TS};`)}`;
  assert.equal(ok({ signature: sig, requestId: "" }), false);
});

test("S9 data.id: pagamento é numérico; alfanumérico (maiúsculo ou minúsculo) é recusado antes e na assinatura", () => {
  const upper = "ORD01JQ4S4KY8HWQ6NA5PXB65B3D3";
  assert.equal(normalize({ type: "payment", data: { id: upper } }, `/api/webhooks?data.id=${upper}`), null, "tipo payment com id alfanumérico");
  assert.equal(normalize({ type: "order", data: { id: upper } }, ""), null, "tópico order não é tratado");
  const lower = upper.toLowerCase();
  assert.equal(ok({ dataId: upper, signature: assinar({ id: lower }) }), false, "mesmo assinado com o id em minúsculas (regra oficial)");
  assert.equal(ok({ dataId: lower, signature: assinar({ id: lower }) }), false);
  // Para pagamentos (id só com dígitos) a regra de minúsculas não altera o manifesto.
  assert.deepEqual({ ...normalize({ type: "payment", data: { id: "123456789" } }, "/api/webhooks?data.id=123456789") }, { paymentId: "123456789" });
});

test("S10 data.id da query e do corpo precisam coincidir (o manifesto usa o id da URL)", () => {
  assert.equal(normalize({ type: "payment", data: { id: "123456789" } }, "/api/webhooks?data.id=987654321"), null);
  assert.equal(normalize({ type: "payment", data: { id: "12" } }, ""), null, "id curto demais");
});

test("S11 comparação em tempo constante (timingSafeEqual) sobre o HMAC SHA256 do manifesto oficial", () => {
  const fn = trecho("function verifyMercadoPagoSignature(", "__name(verifyMercadoPagoSignature");
  assert.match(fn, /createHmac\("sha256"/);
  assert.match(fn, /`id:\$\{dataId\};request-id:\$\{requestId\};ts:\$\{ts2\};`/);
  assert.match(fn, /timingSafeEqual\(a2, b2\)/);
  assert.doesNotMatch(fn, /expected\s*===?\s*v1|v1[^;]*===?\s*expected/);
});

test("S12 a região executada é a extração literal do teste (mesmas três fatias, unidas por \\n)", () => {
  const literal = [
    trecho("var safeText2 = ", "function buildMercadoPagoPreference("),
    trecho("function normalizeMercadoPagoWebhook(", "__name(normalizeMercadoPagoWebhook"),
    trecho("function verifyMercadoPagoSignature(", "__name(verifyMercadoPagoSignature"),
  ].join("\n");
  assert.equal(CODIGO, literal, "[S12.1] região do helper difere da extração literal do teste");
  assert.equal(REGIAO.sha256, crypto.createHash("sha256").update(literal, "utf8").digest("hex"), "[S12.2] sha256 da região");
});

test("S13 o hash da região testada é o mp_signature_region_sha256 que write-build-info.py grava para a mesma árvore", () => {
  requireTool("python3");
  const tmp = mkdtempSync(join(tmpdir(), "zev-mpsig-s13-"));
  try {
    for (const rel of ["scripts/deploy/write-build-info.py", "scripts/deploy/build_provenance.py",
      "scripts/deploy/mp-signature-region.json", "worker/cloudflare-worker.recovered.mjs"]) {
      mkdirSync(join(tmp, ...rel.split("/").slice(0, -1)), { recursive: true });
      copyFileSync(new URL(`../${rel}`, import.meta.url), join(tmp, ...rel.split("/")));
    }
    mkdirSync(join(tmp, "public"));
    const r = spawnSync("python3", ["scripts/deploy/write-build-info.py"], { cwd: tmp, encoding: "utf8", windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TARGET_RUNTIME_SHA: "0".repeat(40), GITHUB_REPOSITORY: "o/r" } });
    assert.equal(r.status, 0, `[S13.1] write-build-info.py falhou: ${r.stderr}`);
    const info = JSON.parse(readTextNormalized(join(tmp, "public", "build-info.json")));
    const testado = crypto.createHash("sha256").update(CODIGO, "utf8").digest("hex");
    assert.equal(info.mp_signature_region_sha256, testado, "[S13.2] build-info difere do hash da região testada");
    assert.deepEqual(Object.keys(info).slice(0, 3), ["sha", "source", "repository"], "[S13.3] campos anteriores preservados");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
