// ZEVANORY | P20: cópia do backup em memória no formato EXATO do Worker (worker/data-backup.mjs): um bundle por
// parte, manifesto fp.tables[t].sha e resumo neon.manifest. Dados 100% sintéticos (testes do ensaio e do coletor B0).
import { sha256, manifestHash, REPORT_KEY, partReportKey, bundleKeyFor } from "../../scripts/p20/restore-drill-lib.mjs";

export const SEGREDO = "pessoa-sintetica-p20@example.invalid";
export const DAY = "2026-11-02";

export function makeBackup({ day = DAY, started = "2026-11-02T05:10:00.000Z", tables = null } = {}) {
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
    const key = bundleKeyFor(day, p);
    kv[key] = JSON.stringify(bundle);
    kv[partReportKey(p)] = JSON.stringify({ schema: "zevanory-backup/v1", day, part: p, parts: 3, startedAt: started, finishedAt: "2026-11-02T05:11:00.000Z", ok: true, failures: [],
      neon: { tables: Object.keys(part).length, rows: r, skipped: [], excluded: [], manifest: manifestHash(shas).slice(0, 16) }, fp: { bundleKey: key, tables: ft } });
    tot += Object.keys(part).length; rows += r;
  });
  kv[REPORT_KEY] = JSON.stringify({ schema: "zevanory-backup/v1", day, parts: 3, ok: true, failures: [], neon: { tables: tot, rows, excluded: [{ table: "provider_oauth_credentials", rows: 0, reason: "credenciais_nao_duplicadas" }], skipped: [] } });
  return kv;
}
