// ZEVANORY | P20: cópia do backup em memória no formato EXATO do Worker (worker/data-backup.mjs): um bundle por
// parte, manifesto fp.tables[t].sha e resumo neon.manifest. Dados 100% sintéticos (testes do ensaio e do coletor B0).
// key (Buffer de 32 bytes): bundles cifrados no envelope do Worker (encryptParts escolhe as partes; padrão: todas).
import { sha256, manifestHash, REPORT_KEY, partReportKey, bundleKeyFor, kvEntryDigest, kvCopyKeyFor, KV_COPY_FORMAT } from "../../scripts/p20/restore-drill-lib.mjs";
import { sealBundleText, kidOf } from "../../scripts/p20/backup-envelope.mjs";

export const SEGREDO = "pessoa-sintetica-p20@example.invalid";
export const DAY = "2026-11-02";

// Linhas sintéticas da cópia KV -> Neon (formato de zevanory_kv_backup relido pelo Worker): trava, resumo, chave com
// TTL e chave com metadados. exp em segundos absolutos (2027, longe do instante dos ensaios de teste).
export const KV_ROWS = Object.freeze([
  { key: "sales:open:v1", value: JSON.stringify({ enabled: false }) },
  { key: "zpc:sales:v1:summary", value: JSON.stringify({ totals: { approved: 0 } }) },
  { key: "zpc:sales:v1:txn:00000000000000a1:approved", value: "1", expiration: 1800000000 },
  { key: "zpc:cp:sub:sintetico", value: JSON.stringify({ plan: "cp" }), metadata: JSON.stringify({ kind: "sub", v: 1 }) },
]);
export const kvRowsFull = (rows, day = DAY) => rows.map((r) => ({ snapshot_day: day, key: r.key, value: r.value, sha256: sha256(r.value), expiration: r.expiration ?? null, metadata: r.metadata ?? null }));

// kv: null (Worker anterior: sem cópia do KV) ou { rows } (linhas da FONTE; o manifesto de entradas sai delas).
// kvCopyRows (opcional): linhas efetivamente gravadas na cópia (para simular cópia divergente da fonte).
export function makeBackup({ day = DAY, started = "2026-11-02T05:10:00.000Z", tables = null, key = null, encryptParts = [0, 1, 2], kv: kvSrc = null, kvCopyRows = null } = {}) {
  const T = tables || [
    { orders: [{ id: 1, total: 47 }], zevanory_leads: [{ email: SEGREDO }] },
    { service_fulfillment: [{ id: 1 }, { id: 2 }], knowledge_documents: [] },
    { telemetry_events: [{ e: "v" }], product_support_cases: [{ id: "c1" }] },
  ];
  const kv = {};
  let tot = 0, rows = 0;
  T.forEach((part, p) => {
    const bundle = {}, ft = {}, shas = {};
    let r = 0;
    for (const [t, arr] of Object.entries(part)) { const js = JSON.stringify(arr); bundle[t] = js; shas[t] = sha256(js); ft[t] = { fp: "0".repeat(32), sha: shas[t] }; r += arr.length; }
    const bkey = bundleKeyFor(day, p);
    const enc = !!key && encryptParts.includes(p);
    kv[bkey] = enc ? sealBundleText(JSON.stringify(bundle), { day, part: p, bundleKey: bkey }, key) : JSON.stringify(bundle);
    kv[partReportKey(p)] = JSON.stringify({ schema: "zevanory-backup/v1", day, part: p, parts: 3, startedAt: started, finishedAt: "2026-11-02T05:11:00.000Z", ok: true, failures: [],
      encryption: enc ? { state: "cifrado", format: "zevanory-backup-enc/v1", alg: "A256GCM", kid: kidOf(key) } : { state: "nao_cifrado", format: null, alg: null, kid: null, reason: "key_absent" },
      neon: { tables: Object.keys(part).length, rows: r, skipped: [], excluded: [], manifest: manifestHash(shas).slice(0, 16) }, fp: { bundleKey: bkey, tables: ft } });
    tot += Object.keys(part).length; rows += r;
  });
  if (kvSrc) {
    const src = kvRowsFull(kvSrc.rows, day);
    const entries = Object.fromEntries(src.map((r) => [r.key, kvEntryDigest({ sha: r.sha256, expiration: r.expiration, metadata: r.metadata })]));
    const json = JSON.stringify(kvCopyRows || src);
    const ck = kvCopyKeyFor(day);
    kv[ck] = key && encryptParts.includes(0) ? sealBundleText(json, { day, part: 0, bundleKey: ck }, key) : json;
    const p0 = JSON.parse(kv[partReportKey(0)]);
    p0.kv = { keys: src.length, bytes: src.reduce((n, r) => n + r.value.length, 0), manifest: manifestHash(Object.fromEntries(src.map((r) => [r.key, r.sha256]))).slice(0, 16),
      entries_manifest: manifestHash(entries), copy: { format: KV_COPY_FORMAT, bundleKey: ck, rows: src.length, sha: sha256(json) } };
    kv[partReportKey(0)] = JSON.stringify(p0);
  }
  kv[REPORT_KEY] = JSON.stringify({ schema: "zevanory-backup/v1", day, parts: 3, ok: true, failures: [], neon: { tables: tot, rows, excluded: [{ table: "provider_oauth_credentials", rows: 0, reason: "credenciais_nao_duplicadas" }], skipped: [] } });
  return kv;
}
