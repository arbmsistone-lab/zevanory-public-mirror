// Região de assinatura Mercado Pago (roteiro seção 7): o texto que tests/mercadopago-webhook-signature.test.mjs
// executa, com a definição de scripts/deploy/mp-signature-region.json. Mesma regra de scripts/deploy/build_provenance.py
// (CRLF->LF; fatia [indexOf(início), indexOf(fim, início)); partes unidas por "\n"; início único e com offset > 0).
// O SHA-256 desta região é o que write-build-info.py publica em mp_signature_region_sha256.
import crypto from "node:crypto";
import { readTextNormalized, normalizeEol } from "./text.mjs";

export const MP_SIGNATURE_REGION_SPEC = JSON.parse(
  readTextNormalized(new URL("../../scripts/deploy/mp-signature-region.json", import.meta.url)));

export function extractMpSignatureRegion(source, spec = MP_SIGNATURE_REGION_SPEC) {
  const src = normalizeEol(source);
  const parts = spec.parts.map(([inicio, fim]) => {
    const n = src.split(inicio).length - 1;
    if (n !== 1) throw new Error(`REGION_ANCHOR_NOT_UNIQUE: ${inicio} (${n})`);
    const a = src.indexOf(inicio);
    const b = src.indexOf(fim, a);
    if (!(a > 0 && b > a)) throw new Error(`REGION_ANCHOR_NOT_FOUND: ${inicio}`);
    return src.slice(a, b);
  });
  const code = parts.join(spec.joiner);
  return { parts, code, sha256: crypto.createHash("sha256").update(code, "utf8").digest("hex") };
}
