// ZEVANORY | P20: reconstrução EM MEMÓRIA do KV a partir da cópia KV -> Neon restaurada no Postgres efêmero do ensaio
// mensal (docs/p20/inventario-estado-critico.md, "Cópia KV -> Neon no ensaio mensal").
//
// Isto NÃO é um escritor de KV: não há binding, API REST nem credencial. É um Map do próprio processo que reproduz a
// semântica do Cloudflare KV que importa para a prova (valor, expiração absoluta >= agora + 60 s, metadados JSON <= 1024 B),
// para conferir chave a chave que a cópia restaurada recria a fonte. Os métodos são set/get/list de uma estrutura
// interna (memKvReplay), sem método de escrita com o nome da API do KV. Os prefixos críticos chegam por parâmetro, a
// partir da lista oficial (KV_PREFIXES em scripts/p20/restore-drill-lib.mjs); este módulo não tem prefixo de produção.
import { checkKvRows, kvEntryDigest, manifestHash, sha256, KV_MIN_TTL_S, KV_METADATA_MAX_BYTES } from "./restore-drill-lib.mjs";

// Estrutura em memória com a semântica do Cloudflare KV usada na prova da restauração.
export function memKvReplay({ nowSec }) {
  const m = new Map();
  return {
    async set(key, value, opts = {}) {
      if (typeof value !== "string") throw new Error("kv_value_not_string");
      if (opts.expiration != null && !(Number.isSafeInteger(opts.expiration) && opts.expiration >= nowSec + KV_MIN_TTL_S)) throw new Error("kv_expiration_invalid");
      if (opts.metadata !== undefined && Buffer.byteLength(JSON.stringify(opts.metadata), "utf8") > KV_METADATA_MAX_BYTES) throw new Error("kv_metadata_too_large");
      m.set(key, { value, expiration: opts.expiration ?? null, metadata: opts.metadata === undefined ? null : opts.metadata });
    },
    async get(key) { return m.has(key) ? m.get(key).value : null; },
    async list({ prefix = "" } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => { const e = m.get(name); return { name, ...(e.expiration != null ? { expiration: e.expiration } : {}), ...(e.metadata != null ? { metadata: e.metadata } : {}) }; }), list_complete: true };
    },
  };
}

// Plano de restauração do KV a partir das linhas da cópia (o MESMO usado numa recuperação real): uma entrada por
// chave com o valor, a expiração absoluta e os metadados. Chave já expirada no instante da restauração (ou a menos de
// 60 s de expirar) não é recriada: no KV de origem ela também já não existiria.
export function planKvRestore(rows, { nowSec }) {
  const entries = [], expired = [];
  for (const r of rows) {
    const exp = r.expiration ?? null;
    if (exp != null && exp < nowSec + KV_MIN_TTL_S) { expired.push(r.key); continue; }
    const opts = {};
    if (exp != null) opts.expiration = exp;
    if (r.metadata != null) opts.metadata = JSON.parse(r.metadata);
    entries.push({ key: r.key, value: r.value, opts });
  }
  return { entries, expired };
}

// Ensaio da restauração do KV: linhas RELIDAS do Postgres efêmero -> estrutura em memória -> conferência chave a chave
// (valor, TTL, metadados) contra o manifesto da fonte gravado pelo Worker. Saída só com contagens e booleanos.
// prefixes: a lista oficial dos prefixos críticos (obrigatória). mem: estrutura alternativa, só para os testes.
export async function kvRestoreDrill(restoredRows, kvAssessment, { nowSec, prefixes, mem = null } = {}) {
  const A = kvAssessment;
  const proof = { day: A.day, keys: A.keys, restored: 0, expired_at_restore: 0, with_ttl: 0, with_metadata: 0,
    pg_rows_ok: false, values_hash_ok: false, ttl_metadata_ok: false, entries_manifest_ok: false, copia_cifrada: A.copia_cifrada === true,
    restored_into: "KV em memória reconstruído das linhas de zevanory_kv_backup relidas do Postgres efêmero" };
  const failures = [];
  if (!Array.isArray(prefixes) || prefixes.length === 0 || !prefixes.every((p) => typeof p === "string" && p.length > 0)) { failures.push("kv_restore_prefixes_missing"); return { proof, failures }; }
  const pg = checkKvRows(restoredRows, { day: A.day, keys: A.keys, entriesManifest: A.entries_manifest, prefix: "kv_restore_pg" });
  failures.push(...pg.failures);
  if (failures.length) return { proof, failures };
  proof.pg_rows_ok = true;
  let plan;
  try { plan = planKvRestore(restoredRows, { nowSec }); } catch { failures.push("kv_restore_metadata_invalid"); return { proof, failures }; }
  const replay = mem || memKvReplay({ nowSec });
  try { for (const e of plan.entries) await replay.set(e.key, e.value, e.opts); } catch (e) { failures.push("kv_restore_put_failed:" + String(e?.message || "x").replace(/[^a-z_]/g, "").slice(0, 40)); return { proof, failures }; }
  // Releitura da estrutura reconstruída: list (nome, expiração, metadados) + get (valor), por prefixo crítico.
  const listed = new Map();
  for (const pre of prefixes) for (const k of (await replay.list({ prefix: pre })).keys) listed.set(k.name, k);
  const rowsBy = new Map(restoredRows.map((r) => [r.key, r]));
  const digests = {};
  let valueBad = 0, metaBad = 0;
  for (const [name, k] of listed) {
    const v = await replay.get(name);
    const r = rowsBy.get(name);
    if (!r || typeof v !== "string" || sha256(v) !== r.sha256) { valueBad++; continue; }
    const exp = Number.isSafeInteger(k.expiration) ? k.expiration : null;
    const meta = k.metadata == null ? null : JSON.stringify(k.metadata);
    if (exp !== (r.expiration ?? null) || meta !== (r.metadata ?? null)) metaBad++;
    if (exp != null) proof.with_ttl++;
    if (meta != null) proof.with_metadata++;
    digests[name] = kvEntryDigest({ sha: sha256(v), expiration: exp, metadata: meta });
  }
  for (const key of plan.expired) { const r = rowsBy.get(key); digests[key] = kvEntryDigest({ sha: r.sha256, expiration: r.expiration ?? null, metadata: r.metadata ?? null }); }
  proof.restored = listed.size;
  proof.expired_at_restore = plan.expired.length;
  if (valueBad) failures.push("kv_restore_value_mismatch:" + valueBad);
  if (metaBad) failures.push("kv_restore_ttl_metadata_mismatch:" + metaBad);
  if (listed.size !== plan.entries.length || proof.restored + proof.expired_at_restore !== A.keys) failures.push("kv_restore_key_count_mismatch");
  proof.values_hash_ok = valueBad === 0;
  proof.ttl_metadata_ok = metaBad === 0;
  proof.entries_manifest_ok = manifestHash(digests) === A.entries_manifest;
  if (!proof.entries_manifest_ok) failures.push("kv_restore_manifest_mismatch");
  return { proof, failures };
}
