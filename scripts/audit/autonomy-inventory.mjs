// Certifiable autonomy (Protocolo Omega, item 9): inventory of business processes, each
// classified (eligible or owner-reserved; autonomous, partial, blocked, manual) and proven
// against live evidence. Index = eligible processes autonomous AND proven now ÷ eligible.
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
  const ok = (runs || []).filter((r) => r.path?.endsWith(workflow) && (r.event === "schedule" || (r.event === "workflow_dispatch" && r.actor === "github-actions[bot]")) && r.conclusion === "success");
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
    case "buyflow": { const ok = (ctx.buyFlow || []).length > 0 && ctx.buyFlow.every((b) => b.state === "checkout"); return { proven: ok, lastEvidence: ok ? new Date(now).toISOString() : null, how: "botão Comprar abre o pagamento" }; }
    case "hotmart": { const ok = (ctx.hotmart || []).length > 0 && ctx.hotmart.every((h) => h.http === 200 && !h.blockedText); return { proven: ok, lastEvidence: ok ? new Date(now).toISOString() : null, how: "checkouts respondem com o produto" }; }
    case "probes": { const ok = (ctx.probes || []).length > 0 && ctx.probes.every((x) => x.ok); return { proven: ok, lastEvidence: ok ? new Date(now).toISOString() : null, how: "serviços respondendo" }; }
    default: return { proven: false, lastEvidence: null, how: "sem evidência automática ainda" };
  }
}

export function evaluateInventory(inventory, ctx = {}, now = Date.now()) {
  const processes = (inventory?.processes || []).map((p) => {
    const proof = p.eligible && p.state === "autonomous" ? proveProcess(p, ctx, now) : { proven: false, lastEvidence: null, how: null };
    return { id: p.id, area: p.area, agent: p.agent, name: p.name, eligible: p.eligible, state: p.state, proven: proof.proven, lastEvidence: proof.lastEvidence, how: proof.how, dependency: p.dependency || (p.state === "autonomous" && !proof.proven ? (p.note || "Autônomo, mas sem evidência recente") : null), impact: p.impact || null };
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
    byState: { autonomous: count("autonomous"), partial: count("partial"), blocked_third_party: count("blocked_third_party"), manual: count("manual") },
    ownerReserved: processes.filter((p) => !p.eligible).map((p) => p.name),
    dependencies: eligible.filter((p) => !p.proven).sort((a, b) => (IMPACT[a.impact] ?? 3) - (IMPACT[b.impact] ?? 3)).map((p) => ({ id: p.id, name: p.name, state: p.state, dependency: p.dependency, impact: p.impact })),
    processes,
  };
}
