// Triggers the daily backup + restore drill inside the production Worker (the only holder of the
// database credential), in parts that each fit the free plan's per-invocation budget, then the
// combined verdict. The endpoint returns counts and hashes only.
// P20 v2 (docs/p20/particoes-v2.md): asks the Worker for the day's authenticated plan first (number of parts =
// ceil(eligible tables / 30), at most 6) and passes its plan_id to every part and to the finalize call; a part whose
// re-read inventory does not match the plan fails without writing. A Worker without the plan route (404) still runs the
// legacy v1 flow with 3 fixed parts, flagged as such.
import { randomBytes } from "node:crypto";
const base = process.env.BACKUP_URL || "https://zevanory.api.br/api/internal/backup/run";
const planUrl = process.env.BACKUP_PLAN_URL || "https://zevanory.api.br/api/internal/backup/plan";
const token = process.env.ZEVANORY_OPERATOR_TOKEN || "";
const LEGACY_PARTS = 3;
const call = async (qs) => {
  const r = await fetch(`${base}?${qs}`, { method: "POST", headers: { "x-backup-token": token }, signal: AbortSignal.timeout(120000) });
  return { http: r.status, body: await r.json().catch(() => ({ ok: false, failures: ["http_" + r.status] })) };
};
// Plano (só leitura no Worker): plan_id, número de partes e contagens; nunca nomes de tabela ou dados.
const askPlan = async () => {
  const r = await fetch(planUrl, { method: "POST", headers: { "x-backup-token": token }, signal: AbortSignal.timeout(120000) });
  return { http: r.status, body: await r.json().catch(() => ({ ok: false, failures: ["http_" + r.status] })) };
};

export function planDecision({ http, body }) {
  if (http === 404) return { mode: "v1" };
  // Dia já concluído e aprovado (relatório v2 autenticado): nada a fazer; a cópia do dia é imutável.
  if (http === 409 && body && body.day_complete === true && Array.isArray(body.failures) && body.failures.includes("day_already_complete")) {
    const ok = /^[0-9a-f]{64}$/.test(String(body.plan_id || "")) && Number.isInteger(body.parts) && body.parts >= 1 && body.parts <= 6;
    return ok ? { mode: "done", planId: body.plan_id, parts: body.parts } : { mode: "fail", failures: ["day_complete_without_report_plan"] };
  }
  if (http === 200 && body && body.ok === true && /^[0-9a-f]{64}$/.test(String(body.plan_id || "")) && Number.isInteger(body.parts) && body.parts >= 1 && body.parts <= 6) {
    return { mode: "v2", planId: body.plan_id, parts: body.parts };
  }
  return { mode: "fail", failures: (body && body.failures) || ["plan_http_" + http] };
}

export function doneVerdict(body) {
  const f = body && Array.isArray(body.failures) ? body.failures : [];
  return { ok: f.length === 1 && f[0] === "day_already_complete" && ["ja_publicado", "republicado"].includes(body.publicacao) && body.report_ok === true };
}

async function main() {
  if (token.length < 32) { console.log("::error title=DATA_BACKUP::token_unavailable"); process.exit(1); }
  const plan = await askPlan();
  const d = planDecision(plan);
  console.log("::notice title=DATA_BACKUP_PLAN::" + JSON.stringify({ http: plan.http, mode: d.mode, parts: d.parts ?? null, eligible: plan.body?.eligible ?? null, excluded: plan.body?.excluded ?? null, auth: plan.body?.auth ?? null, failures: d.failures ?? [] }));
  if (d.mode === "done") {
    // Dia já concluído: a consolidação confere se o relatório aprovado está publicado no KV e, se uma queda o deixou só no
    // banco, o republica (recuperação). Nada mais é gravado.
    const { http, body } = await call(`finalize=1&parts=${d.parts}&plan_id=${d.planId}&run_id=${randomBytes(16).toString("hex")}`);
    const v = doneVerdict(body);
    console.log((v.ok ? "::notice" : "::error") + " title=DATA_BACKUP_DIA_CONCLUIDO::" + JSON.stringify({ http, publicacao: body?.publicacao ?? null, failures: body?.failures ?? null }));
    if (!v.ok) process.exit(1);
    return;
  }
  if (d.mode === "fail") { console.log("::error title=DATA_BACKUP::plan_failed " + (d.failures || []).join(",").slice(0, 300)); process.exit(1); }
  if (d.mode === "v1") console.log("::warning title=DATA_BACKUP_LEGADO_V1::Worker sem a rota de plano: 3 partes fixas, sem plano autenticado");
  const parts = d.mode === "v2" ? d.parts : LEGACY_PARTS;
  // run_id: identifica ESTA execução; a consolidação v2 recusa relatório de parte de outra execução (part_run_mismatch).
  const runId = randomBytes(16).toString("hex");
  const extra = d.mode === "v2" ? `&plan_id=${d.planId}&run_id=${runId}` : "";
  for (let p = 0; p < parts; p++) {
    const { http, body } = await call(`part=${p}&parts=${parts}${extra}`);
    console.log(`::notice title=DATA_BACKUP_PART_${p}::` + JSON.stringify({ http, ok: body.ok, tables: body.neon?.tables, rows: body.neon?.rows, restored: body.restore?.neon?.ok, encryption: body.encryption?.state ?? null, failures: body.failures }));
  }
  const { http, body: rep } = await call(`finalize=1&parts=${parts}${extra}`);
  console.log("::notice title=DATA_BACKUP::" + JSON.stringify({ http, ok: rep.ok, day: rep.day, contract: rep.contract ?? 1, auth: rep.auth ? { state: rep.auth.state, kid: rep.auth.kid ?? null } : null, coverage: rep.coverage, kv: rep.kv, neon: { tables: rep.neon?.tables, rows: rep.neon?.rows, excluded: rep.neon?.excluded, skipped: rep.neon?.skipped }, restore: rep.restore, failures: rep.failures }));
  // P20: cópia Neon -> KV não cifrada (segredo P20_BACKUP_KEY ausente no Worker) é alerta na fase 1 (docs/p20/cifragem-backup.md).
  if (rep.encryption?.state !== "cifrado") console.log("::warning title=DATA_BACKUP_NAO_CIFRADO::" + JSON.stringify({ state: rep.encryption?.state ?? null, parts_cifradas: rep.encryption?.parts_cifradas ?? null }));
  // P20 diário D1 (PR 4): reconciliação Neon × diário. Em sombra, divergência é alerta (o relatório não reprova).
  {
    const dd = rep.diario || {};
    const resumo = JSON.stringify({ estado: dd.estado ?? null, fase: dd.fase ?? null, esperados: dd.esperados ?? null, presentes: dd.presentes ?? null, faltando: dd.faltando ?? null, sobrando: dd.sobrando ?? null, cadeia_ok: dd.cadeia_ok ?? null, motivo: dd.motivo ?? null });
    console.log((dd.estado === "ok" || dd.estado === "nao_configurado" ? "::notice" : "::warning") + " title=DATA_BACKUP_DIARIO::" + resumo);
  }
  if (!rep.ok) { console.log("::error title=DATA_BACKUP::" + (rep.failures || []).join(", ").slice(0, 400)); process.exit(1); }
}

if (process.argv[1] && import.meta.url.endsWith("/data-backup.mjs") && process.argv[1].endsWith("data-backup.mjs")) await main();
