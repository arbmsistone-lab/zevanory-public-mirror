// Triggers the daily backup + restore drill inside the production Worker (the only holder of the
// database credential), in parts that each fit the free plan's per-invocation budget, then the
// combined verdict. The endpoint returns counts and hashes only.
const base = process.env.BACKUP_URL || "https://zevanory.api.br/api/internal/backup/run";
const token = process.env.CERTIFICATION_E2E_TOKEN || "";
const PARTS = 3;
if (token.length < 32) { console.log("::error title=DATA_BACKUP::token_unavailable"); process.exit(1); }
const call = async (qs) => {
  const r = await fetch(`${base}?${qs}`, { method: "POST", headers: { "x-backup-token": token }, signal: AbortSignal.timeout(120000) });
  return { http: r.status, body: await r.json().catch(() => ({ ok: false, failures: ["http_" + r.status] })) };
};
for (let p = 0; p < PARTS; p++) {
  const { http, body } = await call(`part=${p}&parts=${PARTS}`);
  console.log(`::notice title=DATA_BACKUP_PART_${p}::` + JSON.stringify({ http, ok: body.ok, tables: body.neon?.tables, rows: body.neon?.rows, restored: body.restore?.neon?.ok, failures: body.failures }));
}
const { http, body: rep } = await call(`finalize=1&parts=${PARTS}`);
console.log("::notice title=DATA_BACKUP::" + JSON.stringify({ http, ok: rep.ok, day: rep.day, coverage: rep.coverage, kv: rep.kv, neon: { tables: rep.neon?.tables, rows: rep.neon?.rows, excluded: rep.neon?.excluded, skipped: rep.neon?.skipped }, restore: rep.restore, failures: rep.failures }));
if (!rep.ok) { console.log("::error title=DATA_BACKUP::" + (rep.failures || []).join(", ").slice(0, 400)); process.exit(1); }
