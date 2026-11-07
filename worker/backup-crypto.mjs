// ZEVANORY | P20 (seção 9.1): cifragem da cópia Neon -> KV do backup diário. Só WebCrypto (runtime do Worker).
// O contrato do envelope está em docs/p20/cifragem-backup.md e é lido também por scripts/p20/backup-envelope.mjs
// (node:crypto, ensaio mensal). As duas implementações são independentes de propósito: o teste cifra com uma e
// decifra com a outra.
//
// Envelope (valor da chave zpc:backup:v1:neon:<dia>:part:<n> no KV), JSON:
//   { "$enc": "zevanory-backup-enc/v1", "v": 1, "alg": "A256GCM", "kid": "<16 hex>", "nonce": "<base64 de 12 bytes>",
//     "aad": { "day": "<AAAA-MM-DD>", "part": <n>, "key": "<chave do bundle>" }, "ct": "<base64 de ciphertext||tag de 16 bytes>" }
// Texto claro = o MESMO JSON {tabela: json} de antes; o manifesto (SHA-256 por tabela) continua sobre o texto claro.
// AAD (bytes que o GCM autentica) = "zevanory-backup-enc|v=1|alg=A256GCM|day=<dia>|part=<n>|key=<chave>", SEMPRE
// recalculada de onde o bundle DEVE estar (dia e parte esperados), nunca lida do envelope: mover um envelope de dia ou
// de parte, ou trocar a versão, derruba a tag. "$enc" não é nome de tabela válido, então um bundle legado (texto claro)
// nunca é confundido com um envelope.
// Chave: segredo P20_BACKUP_KEY do Worker = base64 de 32 bytes aleatórios. kid = 16 hex do SHA-256 de
// "zevanory-p20-backup-kid/v1|" || chave (identifica a chave sem revelá-la). A chave nunca vai para o relatório,
// para o KV, para log nem para mensagem de erro: só o kid.
export const ENC_FORMAT = "zevanory-backup-enc/v1";
export const ENC_VERSION = 1;
export const ENC_ALG = "A256GCM";
export const ENC_MARK = "$enc";
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;
export const KID_PREFIX = "zevanory-p20-backup-kid/v1|";
// Fase 1 (#982): sem P20_BACKUP_KEY o backup seguia em texto claro, marcado "nao_cifrado" com alerta.
// Fase 2 (R154, ativa): a chave foi cadastrada e o ensaio mensal ENSAIO_EM_PRODUCAO run 42401391418 (07/11/2026)
// restaurou 60/60 tabelas com copia_cifrada=true nas 3 partes. Agora, sem chave NADA é gravado em claro:
// a parte falha (fail-closed, backup_key_absent_encryption_required) e o consolidado com parte não cifrada falha.
export const ENCRYPTION_REQUIRED = true;

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const err = (code) => { const e = new Error(code); e.code = code; return e; };

export function b64encode(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64decode(s) {
  if (typeof s !== "string" || s.length % 4 !== 0 || !B64.test(s)) throw err("base64_invalid");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

export function aadString({ day, part, bundleKey }) {
  return `zevanory-backup-enc|v=${ENC_VERSION}|alg=${ENC_ALG}|day=${day}|part=${part}|key=${bundleKey}`;
}

export async function kidOf(raw) {
  const pre = te.encode(KID_PREFIX);
  const buf = new Uint8Array(pre.length + raw.length);
  buf.set(pre); buf.set(raw, pre.length);
  return hex(await crypto.subtle.digest("SHA-256", buf)).slice(0, 16);
}

// Lê o segredo. { state: "absent" } | { state: "invalid" } | { state: "present", kid, key }. Nunca devolve o texto.
export async function loadBackupKey(secret) {
  if (secret == null || String(secret).trim() === "") return { state: "absent" };
  let raw;
  try { raw = b64decode(String(secret).trim()); } catch { return { state: "invalid" }; }
  if (raw.length !== KEY_BYTES) return { state: "invalid" };
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { state: "present", kid: await kidOf(raw), key };
}

export function isEnvelopeObject(o) { return isObj(o) && Object.prototype.hasOwnProperty.call(o, ENC_MARK); }

// Cifra o texto claro do bundle. Nonce aleatório de 96 bits por chamada (uma por parte por dia).
export async function sealBundle(plaintext, ctx, k, { randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n)) } = {}) {
  if (!k || k.state !== "present") throw err("backup_key_unavailable");
  const nonce = randomBytes(NONCE_BYTES);
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) throw err("nonce_invalid");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: te.encode(aadString(ctx)), tagLength: 128 }, k.key, te.encode(String(plaintext))));
  return JSON.stringify({ [ENC_MARK]: ENC_FORMAT, v: ENC_VERSION, alg: ENC_ALG, kid: k.kid, nonce: b64encode(nonce), aad: { day: ctx.day, part: ctx.part, key: ctx.bundleKey }, ct: b64encode(ct) });
}

// Abre um bundle lido do KV. Legado (texto claro) volta como está, marcado encrypted:false. Envelope: confere formato,
// kid, AAD (dia/parte/chave esperados) e tag; qualquer divergência lança um código (sem material de chave).
// keys: lista de { kid, key } (o Worker só tem a chave ativa).
export async function openBundle(raw, ctx, keys = []) {
  if (typeof raw !== "string") throw err("bundle_absent");
  let o;
  try { o = JSON.parse(raw); } catch { throw err("bundle_malformed"); }
  if (!isEnvelopeObject(o)) return { text: raw, encrypted: false, kid: null };
  if (o[ENC_MARK] !== ENC_FORMAT || o.v !== ENC_VERSION) throw err("envelope_version_unsupported");
  if (o.alg !== ENC_ALG || typeof o.kid !== "string" || !/^[0-9a-f]{16}$/.test(o.kid) || typeof o.nonce !== "string" || typeof o.ct !== "string" || !isObj(o.aad)) throw err("envelope_malformed");
  if (o.aad.day !== ctx.day || o.aad.part !== ctx.part || o.aad.key !== ctx.bundleKey) throw err("aad_mismatch");
  const k = (keys || []).find((x) => x && x.kid === o.kid);
  if (!k) throw err("kid_unknown");
  let nonce, ct;
  try { nonce = b64decode(o.nonce); ct = b64decode(o.ct); } catch { throw err("envelope_malformed"); }
  if (nonce.length !== NONCE_BYTES || ct.length < 16) throw err("envelope_malformed");
  let pt;
  try { pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: te.encode(aadString(ctx)), tagLength: 128 }, k.key, ct); }
  catch { throw err("decrypt_failed"); }
  try { return { text: td.decode(pt), encrypted: true, kid: o.kid }; } catch { throw err("decrypt_failed"); }
}

// Dia e parte de uma chave de bundle (para abrir o bundle anterior com a AAD certa).
export function bundleCtxFromKey(bundleKey) {
  const m = /^zpc:backup:v1:neon:(\d{4}-\d{2}-\d{2}):part:(\d+)$/.exec(String(bundleKey || ""));
  return m ? { day: m[1], part: Number(m[2]), bundleKey: String(bundleKey) } : null;
}
