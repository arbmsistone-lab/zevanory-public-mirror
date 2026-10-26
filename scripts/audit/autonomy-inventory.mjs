// Certifiable autonomy (Protocolo Omega, item 9): inventory of business processes, each
// classified (eligible or owner-reserved; autonomous, partial, blocked, manual) and proven
// against live evidence. Index = eligible processes autonomous AND proven now ÷ eligible.
import { evaluateBuyFlow, expectedBuyState, hotmartLockState } from "./funnel-counting.mjs";
const H = 3600e3;
const IMPACT = { high: 0, medium: 1, low: 2 };

function latestPublication(byDay, channel) {
  let best = null;
  for (const [day, entries] of Object.entries(byDay || {})) {
    const e = entries?.[channel];
    if (e?.status !== "publicado") continue;
    const t = Date.parse(e.at || day + "T12:00:00Z");
    if (!best || t > best) best = t;
  }
  return best;
}
function latestRun(runs, workflow) {
  const ok = (runs || []).filter((r) => r.path?.endsWith(workflow) && (r.event === "schedule" || r.event === "workflow_run" || (r.event === "workflow_dispatch" && r.actor === "github-actions[bot]")) && r.conclusion === "success");
  return ok.length ? Math.max(...ok.map((r) => Date.parse(r.updated_at || r.created_at))) : null;
}

export function proveProcess(p, ctx, now = Date.now()) {
  const ev = p.evidence || { type: "none" };
  const fresh = (t) => t != null && now - t <= (ev.maxAgeHours || 30) * H;
  switch (ev.type) {
    case "publication": { const t = latestPublication(ctx.byDay, ev.channel); return { proven: fresh(t), lastEvidence: t ? new Date(t).toISOString() : null, how: "publicação confirmada pelo provedor" }; }
    case "workflow": { const t = latestRun(ctx.runs, ev.workflow); return { proven: fresh(t), lastEvidence: t ? new Date(t).toISOString() : null, how: "execução agendada concluída" }; }
    case "freshness": { const t = ctx.funnelAt ? Date.parse(ctx.funnelAt) : null; return { proven: fresh(t), lastEvidence: ctx.funnelAt || null, how: "consolidado horário atualizado" }; }
    case "market": { const t = ctx.marketAt ? Date.parse(ctx.marketAt) : null; return { proven: fresh(t), lastEvidence: ctx.marketAt || null, how: "pesquisa semanal gravada" }; }
    case "support_eval": { const t = ctx.support?.generatedAt ? Date.parse(ctx.support.generatedAt) : null; return { proven: fresh(t) && (ctx.support?.scorePct ?? 0) >= (ev.minScore || 90), lastEvidence: ctx.support?.generatedAt || null, how: `avaliação do atendimento: ${ctx.support?.scorePct ?? "—"}%` }; }
    case "voice_eval": { const v = ctx.voiceEval; const t = v?.generatedAt ? Date.parse(v.generatedAt) : null; return { proven: fresh(t) && v?.ok === true, failed: fresh(t) && v?.ok === false, lastEvidence: v?.generatedAt || null, how: `voz ponta a ponta: ${v?.scorePct ?? "—"}% das amostras, reserva ${v?.fallback?.ok ? "ok" : "falhou"}` }; }
    case "backup": { const b = ctx.backup; const t = b?.finishedAt ? Date.parse(b.finishedAt) : null; return { proven: fresh(t) && b?.ok === true, failed: fresh(t) && b?.ok === false, lastEvidence: b?.finishedAt || null, how: `cópia e restauração conferidas (${b?.restore?.neon?.ok ?? 0} tabelas, ${b?.restore?.kv?.verified ?? 0} chaves)` }; }
    case "cron_task": { const b = [...(ctx.cronBeats || []), ctx.cronBeat].filter((x) => x?.tasks?.[ev.task]).sort((x, y) => String(y.finishedAt).localeCompare(String(x.finishedAt)))[0]; const t = b?.finishedAt ? Date.parse(b.finishedAt) : null; const st = b?.tasks?.[ev.task]; return { proven: fresh(t) && st === "ok", failed: fresh(t) && String(st || "").startsWith("fail"), lastEvidence: b?.finishedAt || null, how: `ciclo horário do servidor: ${ev.task} ${st || "sem registro"}` }; }
    // Buy path vs the owner switch: open => /comprar/ opens the own checkout; closed => it shows the
    // closed notice (expected, healthy). Unknown switch proves nothing; a mismatch is a failure.
    case "buyflow": {
      const recs = evaluateBuyFlow(ctx.buyFlow, ctx.salesOpen);
      const expected = expectedBuyState(ctx.salesOpen);
      const ok = recs.length > 0 && expected != null && recs.every((b) => b.ok);
      const mismatch = expected != null && recs.some((b) => !b.ok && b.state !== "error");
      return { proven: ok, failed: mismatch, lastEvidence: ok ? new Date(now).toISOString() : null, how: expected === "closed" ? "vendas fechadas: botão Comprar mostra o aviso de fechado (esperado)" : expected === "checkout" ? "vendas abertas: botão Comprar abre o pagamento do checkout próprio" : "interruptor de vendas não verificado" };
    }
    // Hotmart offers vs the global lock (six probes): open => offers answer; closed => every offer must show
    // Hotmart's closed page. Any offer accepting payment while sales are closed is a P0 failure.
    case "hotmart": {
      const lock = hotmartLockState(ctx.hotmart, ctx.salesOpen);
      const ok = lock.state === "selling" || lock.state === "closed";
      const how = { selling: "vendas abertas: as ofertas Hotmart respondem", closed: `vendas fechadas: ${lock.closed.length}/${lock.total} ofertas Hotmart encerradas (coerente com a trava)`, p0_bypass: `P0: vendas fechadas, mas ${lock.accepting.length} oferta(s) Hotmart aceitando pagamento (encerrar na Hotmart é ato do dono)`, closed_while_open: "vendas abertas, mas as ofertas Hotmart estão encerradas", degraded: "vendas abertas, mas alguma oferta Hotmart não responde", unverified: "vendas fechadas; alguma oferta Hotmart não respondeu à sonda", unknown: "interruptor ou sondas Hotmart não verificados" }[lock.state];
      return { proven: ok, failed: ["p0_bypass", "closed_while_open", "degraded"].includes(lock.state), lastEvidence: ok ? new Date(now).toISOString() : null, how };
    }
    case "probes": { const ok = (ctx.probes || []).length > 0 && ctx.probes.every((x) => x.ok); return { proven: ok, lastEvidence: ok ? new Date(now).toISOString() : null, how: "serviços respondendo" }; }
    default: return { proven: false, lastEvidence: null, how: "sem evidência automática ainda" };
  }
}

export function evaluateInventory(inventory, ctx = {}, now = Date.now()) {
  const processes = (inventory?.processes || []).map((p) => {
    const proof = p.eligible && p.state === "autonomous" ? proveProcess(p, ctx, now) : { proven: false, lastEvidence: null, how: null };
    return { id: p.id, area: p.area, agent: p.agent, name: p.name, eligible: p.eligible, state: p.state, proven: proof.proven, failed: proof.failed === true, lastEvidence: proof.lastEvidence, how: proof.how, dependency: p.dependency || (p.state === "autonomous" && !proof.proven ? (p.note || "Autônomo, mas sem evidência recente") : null), impact: p.impact || null };
  });
  const eligible = processes.filter((p) => p.eligible);
  const proven = eligible.filter((p) => p.proven);
  const count = (s) => eligible.filter((p) => p.state === s).length;
  return {
    criterion: inventory?.criterion || "",
    measuredAt: new Date(now).toISOString(),
    eligible: eligible.length,
    provenAutonomous: proven.length,
    pct: eligible.length ? Math.round((1000 * proven.length) / eligible.length) / 10 : null,
    byState: { autonomous: count("autonomous"), partial: count("partial"), blocked_third_party: count("blocked_third_party"), manual: count("manual"), awaiting_event: count("awaiting_event") },
    ownerReserved: processes.filter((p) => !p.eligible).map((p) => p.name),
    dependencies: eligible.filter((p) => !p.proven).sort((a, b) => (IMPACT[a.impact] ?? 3) - (IMPACT[b.impact] ?? 3)).map((p) => ({ id: p.id, name: p.name, state: p.state, dependency: p.dependency, impact: p.impact })),
    processes,
  };
}
