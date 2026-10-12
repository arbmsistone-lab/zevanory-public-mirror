// Triggers the daily backup + restore drill inside the production Worker (the only holder of the
// database credential) and records the report. The endpoint returns counts and hashes only.
const url = process.env.BACKUP_URL || "https://zevanory.api.br/api/internal/backup/run";
const token = process.env.CERTIFICATION_E2E_TOKEN || "";
if (token.length < 32) { console.log("::error title=DATA_BACKUP::token_unavailable"); process.exit(1); }
const r = await fetch(url, { method: "POST", headers: { "x-backup-token": token }, signal: AbortSignal.timeout(120000) });
const report = await r.json().catch(() => ({ ok: false, failures: ["http_" + r.status] }));
const { ok, day, kv, neon, restore, failures } = report;
console.log("::notice title=DATA_BACKUP::" + JSON.stringify({ http: r.status, ok, day, kv, neon, restore, failures }));
if (!ok) { console.log("::error title=DATA_BACKUP::" + (failures || []).join(", ").slice(0, 400)); process.exit(1); }
