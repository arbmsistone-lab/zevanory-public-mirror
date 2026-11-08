// ZEVANORY | P20 (Roteiro Mestre v4.7, seção 9.1): diário de eventos críticos no Cloudflare D1.
//
// Módulo PURO (sem estado global, sem rede, sem dependência nova). Usa só WebCrypto (crypto.subtle) e a API do
// binding D1 (db.prepare(sql).bind(...).first()/all()/run() e db.batch([...]), atômico). Ainda NÃO é importado pelo
// Worker de produção (PR 1 de 7, docs/p20/diario-d1.md).
//
// Garantias:
//  - somente inclusão: diario_v1 tem triggers que abortam UPDATE e DELETE (migrations/d1/0001_diario_v1.sql);
//  - cadeia: chain_hash = sha256(esquema, prev_hash, event_key, payload_sha, ts_ms); a primeira linha encadeia na
//    cabeça genesis (64 zeros);
//  - compare-and-set: a linha só entra se a cabeça (diario_head) ainda for a lida; até MAX_TENTATIVAS em corrida;
//  - idempotência por event_key: mesma chave e mesmo payload_sha = {ok:true, duplicate:true}; payload diferente =
//    {ok:false, code:"diario_conflito"} (nunca sobrescreve);
//  - LGPD: nenhum e-mail, CPF ou telefone em claro (assertNoPii recusa ANTES de qualquer gravação). Quem precisar
//    correlacionar um titular grava um hash/HMAC (chave terminada em _sha, _hash ou _hmac).

export const DIARIO_SCHEMA = "zevanory.p20.diario.v1";
export const GENESIS_HASH = "0".repeat(64);
export const MAX_TENTATIVAS = 3;
export const MAX_PAYLOAD_BYTES = 8192;
const MAX_DEPTH = 8;

// Tipos de evento (seção 9.1: pedido, consentimento, entrega, pagamento/estorno, referência fiscal).
// fiscal_ref fica reservado: o documento fiscal vive no emissor (F3); o diário guarda só a referência.
export const TIPOS = Object.freeze([
  "order_created",
  "payment_status",
  "delivery_sent",
  "refund",
  "consent_given",
  "consent_confirmed",
  "consent_revoked",
  "erase",
  "fiscal_ref",
]);
const TIPO_SET = new Set(TIPOS);

const HEX64 = /^[0-9a-f]{64}$/;
const KEY_PART = /^[A-Za-z0-9._-]{1,96}$/;
const EVENT_KEY = /^[a-z_]+:[A-Za-z0-9._:-]{1,200}$/;

export class DiarioError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DiarioError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Hash
const te = new TextEncoder();

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", te.encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// JSON canônico: chaves ordenadas em todos os níveis, sem espaços. Números não finitos são recusados.
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DiarioError("diario_payload_invalido", "número não finito");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  throw new DiarioError("diario_payload_invalido", "tipo " + typeof value);
}

export async function payloadSha(payload) {
  return sha256Hex(canonicalJson(payload));
}

export async function chainHash(prevHash, eventKeyValue, payloadShaValue, tsMs) {
  if (!HEX64.test(String(prevHash))) throw new DiarioError("diario_hash_invalido", "prev_hash");
  if (!HEX64.test(String(payloadShaValue))) throw new DiarioError("diario_hash_invalido", "payload_sha");
  if (!Number.isSafeInteger(tsMs) || tsMs < 0) throw new DiarioError("diario_ts_invalido");
  return sha256Hex([DIARIO_SCHEMA, prevHash, eventKeyValue, payloadShaValue, String(tsMs)].join("\n"));
}

// ---------------------------------------------------------------------------------------------------------
// Chave de evento determinística: "<tipo>:<parte>:<parte>...". Partes são identificadores (id do pedido, id do
// pagamento, status), nunca dado pessoal: o alfabeto restrito exclui "@" e espaços, e cada parte passa pelo
// detector de PII. Exemplo: eventKey("payment_status", "ord_123", "mp_987", "approved").
export function eventKey(tipo, ...partes) {
  if (!TIPO_SET.has(tipo)) throw new DiarioError("diario_tipo_invalido", String(tipo));
  if (partes.length === 0) throw new DiarioError("diario_chave_invalida", "sem partes");
  for (const p of partes) {
    if (typeof p !== "string" || !KEY_PART.test(p)) throw new DiarioError("diario_chave_invalida", "parte fora do alfabeto");
    if (piiInString(p)) throw new DiarioError("diario_pii", "chave de evento");
  }
  return tipo + ":" + partes.join(":");
}

// ---------------------------------------------------------------------------------------------------------
// LGPD: recusa e-mail, CPF e telefone em qualquer valor string, e chaves que nomeiam dado pessoal.
const RE_EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/;
const RE_CPF = /(?<![0-9A-Za-z])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![0-9A-Za-z])/;
const RE_PHONE = /(?<![0-9A-Za-z])(?:\+?55[\s.-]?)?\(?[1-9]\d\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?![0-9A-Za-z])/;
const PII_TOKENS = new Set(["email", "mail", "nome", "name", "cpf", "cnpj", "rg", "telefone", "phone", "celular", "whatsapp", "endereco", "address", "ip"]);
const HASH_TOKENS = new Set(["sha", "sha256", "hash", "hmac"]);

function piiInString(s) {
  if (HEX64.test(s)) return null; // um sha256 em hex é o substituto permitido, não o dado
  if (RE_EMAIL.test(s)) return "email";
  if (RE_CPF.test(s)) return "cpf";
  if (RE_PHONE.test(s)) return "telefone";
  return null;
}

function keyTokens(k) {
  return String(k).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}

function piiKey(k) {
  const toks = keyTokens(k);
  if (toks.some((t) => HASH_TOKENS.has(t))) return false;
  return toks.some((t) => PII_TOKENS.has(t)) || toks.join("") === "email";
}

export function assertNoPii(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new DiarioError("diario_payload_invalido", "payload precisa ser objeto");
  const walk = (v, path, depth) => {
    if (depth > MAX_DEPTH) throw new DiarioError("diario_payload_invalido", "profundidade");
    if (typeof v === "string") {
      const kind = piiInString(v);
      if (kind) throw new DiarioError("diario_pii", `${kind} em ${path}`);
      return;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) {
        if (piiKey(k)) throw new DiarioError("diario_pii", `chave ${path}.${k}`);
        walk(v[k], `${path}.${k}`, depth + 1);
      }
      return;
    }
    throw new DiarioError("diario_payload_invalido", `tipo ${typeof v} em ${path}`);
  };
  walk(payload, "$", 0);
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Gravação
const SQL_FIND = "select payload_sha from diario_v1 where event_key = ?";
const SQL_HEAD = "select seq, chain_hash from diario_head where id = 1";
// CAS: a cabeça só avança se ainda for a lida (seq e chain_hash). A inclusão só acontece se, dentro da mesma
// transação do batch, a cabeça for exatamente a nova; se o UPDATE não casou, nada é gravado.
const SQL_CAS = "update diario_head set seq = ?, chain_hash = ? where id = 1 and seq = ? and chain_hash = ?";
const SQL_INSERT = "insert into diario_v1 (seq, event_key, tipo, ts_ms, ref, payload_json, payload_sha, prev_hash, chain_hash) "
  + "select ?, ?, ?, ?, ?, ?, ?, ?, ? where exists (select 1 from diario_head where id = 1 and seq = ? and chain_hash = ?)";

const changesOf = (r) => Number(r?.meta?.changes ?? 0);

function validateEvent(ev) {
  if (ev === null || typeof ev !== "object") throw new DiarioError("diario_evento_invalido");
  if (!TIPO_SET.has(ev.tipo)) throw new DiarioError("diario_tipo_invalido", String(ev.tipo));
  if (typeof ev.event_key !== "string" || !EVENT_KEY.test(ev.event_key) || !ev.event_key.startsWith(ev.tipo + ":")) throw new DiarioError("diario_chave_invalida");
  if (piiInString(ev.event_key)) throw new DiarioError("diario_pii", "chave de evento");
  if (!Number.isSafeInteger(ev.ts_ms) || ev.ts_ms <= 0) throw new DiarioError("diario_ts_invalido");
  if (ev.ref != null && (typeof ev.ref !== "string" || !KEY_PART.test(ev.ref) || piiInString(ev.ref))) throw new DiarioError("diario_ref_invalida");
  assertNoPii(ev.payload);
}

// ev = { tipo, event_key (de eventKey), ts_ms, ref?, payload }.
// Retorno: {ok:true, seq, chain_hash, duplicate:false} | {ok:true, duplicate:true, seq?} |
//          {ok:false, code: diario_pii|diario_conflito|diario_corrida|diario_sem_cabeca|diario_indisponivel|...}.
// Nunca lança por falha do D1: quem chama decide (checkout próprio e leads fecham; webhooks e entregas vão para a
// fila de pendências), conforme docs/p20/diario-d1.md.
export async function appendEvent(db, ev) {
  let payloadJson, psha;
  try {
    validateEvent(ev);
    payloadJson = canonicalJson(ev.payload);
    if (te.encode(payloadJson).length > MAX_PAYLOAD_BYTES) throw new DiarioError("diario_payload_grande");
    psha = await sha256Hex(payloadJson);
  } catch (e) {
    return { ok: false, code: e instanceof DiarioError ? e.code : "diario_evento_invalido" };
  }
  let lastError = null;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      const existing = await db.prepare(SQL_FIND).bind(ev.event_key).first();
      if (existing) {
        if (existing.payload_sha === psha) return { ok: true, duplicate: true };
        return { ok: false, code: "diario_conflito" };
      }
      const head = await db.prepare(SQL_HEAD).first();
      if (!head || !HEX64.test(String(head.chain_hash)) || !Number.isSafeInteger(Number(head.seq))) return { ok: false, code: "diario_sem_cabeca" };
      const prevSeq = Number(head.seq);
      const seq = prevSeq + 1;
      const chain = await chainHash(head.chain_hash, ev.event_key, psha, ev.ts_ms);
      const res = await db.batch([
        db.prepare(SQL_CAS).bind(seq, chain, prevSeq, head.chain_hash),
        db.prepare(SQL_INSERT).bind(seq, ev.event_key, ev.tipo, ev.ts_ms, ev.ref ?? null, payloadJson, psha, head.chain_hash, chain, seq, chain),
      ]);
      if (changesOf(res?.[0]) === 1 && changesOf(res?.[1]) === 1) return { ok: true, duplicate: false, seq, chain_hash: chain, tentativas: tentativa };
      // cabeça mudou entre a leitura e a escrita: nada foi gravado; relê e tenta de novo
    } catch (e) {
      // UNIQUE(event_key) numa corrida com a mesma chave: o batch inteiro voltou atrás; a próxima volta decide
      // entre duplicada e conflito. Outro erro do D1 também é tentado de novo e, persistindo, vira indisponível.
      lastError = e;
    }
  }
  return { ok: false, code: lastError ? "diario_indisponivel" : "diario_corrida" };
}

// ---------------------------------------------------------------------------------------------------------
// Verificação da cadeia. rows na ordem de seq (select * from diario_v1 order by seq). A ordem recebida é a
// conferida: linhas trocadas, removidas ou adulteradas quebram a cadeia. opts.from = {seq, chain_hash} para
// conferir a partir de um ponto já verificado; opts.head = linha de diario_head para detectar corte do fim.
export async function verifyChain(rows, opts = {}) {
  if (!Array.isArray(rows)) return { ok: false, broken_at: null, reason: "rows_invalidas" };
  let prev = opts.from?.chain_hash ?? GENESIS_HASH;
  let expectSeq = Number(opts.from?.seq ?? 0) + 1;
  for (const r of rows) {
    const at = r && r.seq != null ? Number(r.seq) : expectSeq;
    const bad = (reason) => ({ ok: false, broken_at: at, reason });
    if (!r || Number(r.seq) !== expectSeq) return bad("seq_fora_de_ordem");
    if (r.prev_hash !== prev) return bad("prev_hash");
    // A coluna tipo não entra no hash; a reconciliação (compara) classifica pela coluna. A chave (que entra no hash)
    // precisa começar por "<tipo>:", como appendEvent exige, senão um tipo trocado passaria pela cadeia.
    if (!TIPO_SET.has(r.tipo) || typeof r.event_key !== "string" || !r.event_key.startsWith(r.tipo + ":")) return bad("tipo_chave");
    let parsed;
    try { parsed = JSON.parse(r.payload_json); } catch { return bad("payload_json"); }
    let canon;
    try { canon = canonicalJson(parsed); } catch { return bad("payload_json"); }
    if (canon !== r.payload_json) return bad("payload_nao_canonico");
    if ((await sha256Hex(r.payload_json)) !== r.payload_sha) return bad("payload_sha");
    let expected;
    try { expected = await chainHash(prev, r.event_key, r.payload_sha, Number(r.ts_ms)); } catch { return bad("campos_invalidos"); }
    if (expected !== r.chain_hash) return bad("chain_hash");
    prev = r.chain_hash;
    expectSeq++;
  }
  if (opts.head && (Number(opts.head.seq) !== expectSeq - 1 || opts.head.chain_hash !== prev)) {
    return { ok: false, broken_at: expectSeq, reason: "cabeca_divergente" };
  }
  return { ok: true, broken_at: null, count: rows.length, head: { seq: expectSeq - 1, chain_hash: prev } };
}
