// ZEVANORY | P20: leitura (e, para fixtures de teste, escrita) do envelope cifrado do backup Neon -> KV com node:crypto.
// Implementação INDEPENDENTE da do Worker (worker/backup-crypto.mjs, WebCrypto); mesmo contrato, descrito em
// docs/p20/cifragem-backup.md. Síncrono, sem rede. Nenhuma função devolve, imprime ou põe em mensagem de erro o
// material de chave: só kid (16 hex do SHA-256 de "zevanory-p20-backup-kid/v1|" || chave).
//
// Conjunto de chaves da restauração (segredo P20_BACKUP_KEYS do Environment producao-critica):
//   - uma chave base64 (32 bytes), ou várias separadas por vírgula/espaço/quebra de linha (rotação: "nova,antiga"); ou
//   - JSON {"<kid>": "<base64>"}; o kid declarado precisa ser o kid derivado da chave (erro de cadastro derruba).
// A restauração aceita qualquer kid presente no conjunto. Perda da chave = perda dos backups cifrados com ela.
import { createCipheriv, createDecipheriv, createHash, randomBytes as nodeRandomBytes } from "node:crypto";

export const ENC_FORMAT = "zevanory-backup-enc/v1";
export const ENC_VERSION = 1;
export const ENC_ALG = "A256GCM";
export const ENC_MARK = "$enc";
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;
const KID_PREFIX = "zevanory-p20-backup-kid/v1|";
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const err = (code) => { const e = new Error(code); e.code = code; return e; };

export const aadString = ({ day, part, bundleKey }) => `zevanory-backup-enc|v=${ENC_VERSION}|alg=${ENC_ALG}|day=${day}|part=${part}|key=${bundleKey}`;
export const kidOf = (raw) => createHash("sha256").update(Buffer.concat([Buffer.from(KID_PREFIX, "utf8"), raw])).digest("hex").slice(0, 16);

function decodeKey(s) {
  const t = String(s).trim();
  if (t.length % 4 !== 0 || !B64.test(t)) throw err("backup_keyring_malformed");
  const raw = Buffer.from(t, "base64");
  if (raw.length !== KEY_BYTES) throw err("backup_keyring_malformed");
  return raw;
}

// Map kid -> Buffer(32). Vazio quando o segredo não existe (bundles legados ainda são lidos; cifrados falham por kid).
export function parseKeyring(text) {
  const ring = new Map();
  if (text == null || String(text).trim() === "") return ring;
  const s = String(text).trim();
  if (s.startsWith("{")) {
    let o;
    try { o = JSON.parse(s); } catch { throw err("backup_keyring_malformed"); }
    if (!isObj(o) || !Object.keys(o).length) throw err("backup_keyring_malformed");
    for (const [kid, b64] of Object.entries(o)) {
      if (typeof b64 !== "string") throw err("backup_keyring_malformed");
      const raw = decodeKey(b64);
      if (kidOf(raw) !== kid) throw err("backup_keyring_kid_mismatch");
      ring.set(kid, raw);
    }
    return ring;
  }
  for (const part of s.split(/[\s,]+/).filter(Boolean)) { const raw = decodeKey(part); ring.set(kidOf(raw), raw); }
  return ring;
}

export const isEnvelopeObject = (o) => isObj(o) && Object.prototype.hasOwnProperty.call(o, ENC_MARK);

// Só para fixtures de teste e ferramentas locais: o backup real é cifrado pelo Worker.
export function sealBundleText(plaintext, ctx, raw, { randomBytes = nodeRandomBytes } = {}) {
  const nonce = randomBytes(NONCE_BYTES);
  if (!nonce || nonce.length !== NONCE_BYTES) throw err("nonce_invalid");
  const c = createCipheriv("aes-256-gcm", raw, nonce, { authTagLength: TAG_BYTES });
  c.setAAD(Buffer.from(aadString(ctx), "utf8"));
  const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final(), c.getAuthTag()]);
  return JSON.stringify({ [ENC_MARK]: ENC_FORMAT, v: ENC_VERSION, alg: ENC_ALG, kid: kidOf(raw), nonce: Buffer.from(nonce).toString("base64"), aad: { day: ctx.day, part: ctx.part, key: ctx.bundleKey }, ct: ct.toString("base64") });
}

// Abre o valor lido do KV. Legado (texto claro): { text, encrypted:false }. Envelope: formato, AAD esperada (dia,
// parte, chave do bundle, versão), kid no conjunto e tag GCM; qualquer divergência lança um código curto.
export function openBundleText(raw, ctx, ring = new Map()) {
  if (typeof raw !== "string") throw err("bundle_absent");
  let o;
  try { o = JSON.parse(raw); } catch { throw err("bundle_malformed"); }
  if (!isEnvelopeObject(o)) return { text: raw, encrypted: false, kid: null };
  if (o[ENC_MARK] !== ENC_FORMAT || o.v !== ENC_VERSION) throw err("envelope_version_unsupported");
  if (o.alg !== ENC_ALG || typeof o.kid !== "string" || !/^[0-9a-f]{16}$/.test(o.kid) || typeof o.nonce !== "string" || typeof o.ct !== "string" || !isObj(o.aad)) throw err("envelope_malformed");
  if (o.aad.day !== ctx.day || o.aad.part !== ctx.part || o.aad.key !== ctx.bundleKey) throw err("aad_mismatch");
  const key = ring.get(o.kid);
  if (!key) throw err("kid_unknown");
  if (o.nonce.length % 4 || !B64.test(o.nonce) || o.ct.length % 4 || !B64.test(o.ct)) throw err("envelope_malformed");
  const nonce = Buffer.from(o.nonce, "base64"), buf = Buffer.from(o.ct, "base64");
  if (nonce.length !== NONCE_BYTES || buf.length < TAG_BYTES) throw err("envelope_malformed");
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    d.setAAD(Buffer.from(aadString(ctx), "utf8"));
    d.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
    const pt = Buffer.concat([d.update(buf.subarray(0, buf.length - TAG_BYTES)), d.final()]);
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(pt), encrypted: true, kid: o.kid };
  } catch { throw err("decrypt_failed"); }
}
