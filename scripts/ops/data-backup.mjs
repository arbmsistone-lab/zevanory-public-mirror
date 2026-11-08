// Triggers the daily backup + restore drill inside the production Worker (the only holder of the
// database credential), in parts that each fit the free plan's per-invocation budget, then the
// combined verdict. The endpoint returns counts and hashes only.
const base = process.env.BACKUP_URL || "https://zevanory.api.br/api/internal/backup/run";
const token = process.env.ZEVANORY_OPERATOR_TOKEN || "";
const PARTS = 3;
if (token.length < 32) { console.log("::error title=DATA_BACKUP::token_unavailable"); process.exit(1); }
const call = async (qs) => {
  const r = await fetch(`${base}?${qs}`, { method: "POST", headers: { "x-backup-token": token }, signal: AbortSignal.timeout(120000) });
  return { http: r.status, body: await r.json().catch(() => ({ ok: false, failures: ["http_" + r.status] })) };
};
for (let p = 0; p < PARTS; p++) {
  const { http, body } = await call(`part=${p}&parts=${PARTS}`);
  console.log(`::notice title=DATA_BACKUP_PART_${p}::` + JSON.stringify({ http, ok: body.ok, tables: body.neon?.tables, rows: body.neon?.rows, restored: body.restore?.neon?.ok, encryption: body.encryption?.state ?? null, failures: body.failures }));
}
const { http, body: rep } = await call(`finalize=1&parts=${PARTS}`);
console.log("::notice title=DATA_BACKUP::" + JSON.stringify({ http, ok: rep.ok, day: rep.day, coverage: rep.coverage, kv: rep.kv, neon: { tables: rep.neon?.tables, rows: rep.neon?.rows, excluded: rep.neon?.excluded, skipped: rep.neon?.skipped }, restore: rep.restore, failures: rep.failures }));
// P20: cópia Neon -> KV não cifrada (segredo P20_BACKUP_KEY ausente no Worker) é alerta na fase 1 (docs/p20/cifragem-backup.md).
if (rep.encryption?.state !== "cifrado") console.log("::warning title=DATA_BACKUP_NAO_CIFRADO::" + JSON.stringify({ state: rep.encryption?.state ?? null, parts_cifradas: rep.encryption?.parts_cifradas ?? null }));
// P20 diário D1 (PR 4): reconciliação Neon × diário. Em sombra, divergência é alerta (o relatório não reprova).
{
  const d = rep.diario || {};
  const resumo = JSON.stringify({ estado: d.estado ?? null, fase: d.fase ?? null, esperados: d.esperados ?? null, presentes: d.presentes ?? null, faltando: d.faltando ?? null, sobrando: d.sobrando ?? null, cadeia_ok: d.cadeia_ok ?? null, motivo: d.motivo ?? null });
  console.log((d.estado === "ok" || d.estado === "nao_configurado" ? "::notice" : "::warning") + " title=DATA_BACKUP_DIARIO::" + resumo);
}
if (!rep.ok) { console.log("::error title=DATA_BACKUP::" + (rep.failures || []).join(", ").slice(0, 400)); process.exit(1); }
