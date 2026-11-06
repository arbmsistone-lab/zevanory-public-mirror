// Experiment registry evaluation: every hypothesis gets a metric, the data collected so far,
// and an automatic verdict that refuses to declare a winner without enough data and a
// statistically significant difference (two-sided, alpha 0.05).

// Normal CDF (Abramowitz-Stegun) for p-values.
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
// p-values are never shown as an exact zero: below 0.001 they read "p<0,001".
export function fmtP(p) { if (!Number.isFinite(p)) return "p indisponível"; return p < 0.001 ? "p<0,001" : "p=" + p.toFixed(3).replace(".", ","); }
const roundP = (p) => (p < 0.001 ? 0.001 : Math.round(p * 1000) / 1000);
const pct = (x) => (Math.round(x * 1000) / 10).toString().replace(".", ",");
// 95% Wald interval for the difference of two proportions, in percentage points.
export function diffInterval(x1, n1, x2, n2) {
  const p1 = x1 / n1, p2 = x2 / n2, se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return [Math.round((p2 - p1 - 1.96 * se) * 1000) / 10, Math.round((p2 - p1 + 1.96 * se) * 1000) / 10];
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const variance = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1); };

// Welch test on log(1+views): robust to the heavy tail of video views.
export function compareArms(a, b) {
  const la = a.map((x) => Math.log1p(x)), lb = b.map((x) => Math.log1p(x));
  const se = Math.sqrt(variance(la) / la.length + variance(lb) / lb.length);
  if (!se) return { p: 1, z: 0 };
  const z = (mean(la) - mean(lb)) / se;
  return { z, p: 2 * (1 - phi(Math.abs(z))) };
}

// Two-proportion z-test.
export function compareRates(x1, n1, x2, n2) {
  if (!n1 || !n2) return { p: 1, z: 0 };
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return { p: 1, z: 0 };
  const z = (x2 / n2 - x1 / n1) / se;
  return { z, p: 2 * (1 - phi(Math.abs(z))) };
}

export function evaluateArms(exp, videos, now = Date.now()) {
  const old = videos.filter((v) => v.slot && now - Date.parse(v.publishedAt) >= 3 * 864e5);
  const byArm = Object.fromEntries(exp.arms.map((a) => [a, old.filter((v) => v.slot === a).map((v) => v.views)]));
  const arms = exp.arms.map((a) => ({ arm: a, label: exp.armLabels?.[a] || a, n: byArm[a].length, meanViews: byArm[a].length ? Math.round(mean(byArm[a]) * 10) / 10 : null }));
  const ready = arms.every((x) => x.n >= exp.minPerArm);
  if (!ready) return { status: "collecting", arms, progress: `${Math.min(...arms.map((x) => x.n))}/${exp.minPerArm} vídeos no braço com menos dados`, verdict: "Coletando dados: ainda não há base para concluir." };
  const ranked = [...arms].sort((x, y) => y.meanViews - x.meanViews);
  const t = compareArms(byArm[ranked[0].arm], byArm[ranked[1].arm]);
  const method = `Welch em log(1+visualizações), bicaudal, alfa 0,05; ${ranked[0].n} e ${ranked[1].n} vídeos com 3+ dias`;
  if (t.p < 0.05) return { status: "winner", arms, winner: ranked[0].arm, p: roundP(t.p), pDisplay: fmtP(t.p), method, verdict: `${ranked[0].label} vence (${ranked[0].meanViews} vs ${ranked[1].meanViews} visualizações médias, ${fmtP(t.p)}).` };
  return { status: "no_difference", arms, p: roundP(t.p), pDisplay: fmtP(t.p), method, verdict: `Sem diferença comprovada entre os formatos (${fmtP(t.p)}). Manter o teste ou mudar mais forte a variação.` };
}

export function evaluateBeforeAfter(exp, productDaily = {}, now = Date.now()) {
  const change = Date.parse(exp.changeAt), w = exp.windowDays * 864e5;
  // Both windows must come from the same measurement: days before the bot filter are not comparable.
  if (exp.cleanSince && change - w < Date.parse(exp.cleanSince)) {
    return { status: "inconclusive", sides: null, method: "comparação antes/depois", verdict: `Inconclusivo: a janela anterior à mudança (${exp.windowDays} dias antes de ${exp.changeAt}) foi medida antes do filtro de robôs (${exp.cleanSince}); antes e depois não são comparáveis. Nenhum vencedor é declarado.` };
  }
  let bv = 0, bi = 0, av = 0, ai = 0;
  for (const [day, d] of Object.entries(productDaily)) {
    const t = Date.parse(day);
    if (t >= change - w && t < change) { bv += d.views || 0; bi += d.intents || 0; }
    if (t >= change && t < change + w && t < now) { av += d.views || 0; ai += d.intents || 0; }
  }
  const sides = { before: { views: bv, intents: bi, rate: bv ? Math.round((1000 * bi) / bv) / 10 : null }, after: { views: av, intents: ai, rate: av ? Math.round((1000 * ai) / av) / 10 : null } };
  const minEvents = exp.minEventsTotal || 20;
  if (now < change + w) return { status: "collecting", sides, progress: `janela depois da mudança termina em ${new Date(change + w).toISOString().slice(0, 10)}`, verdict: "Coletando dados: a janela de observação ainda não terminou." };
  if (bv < exp.minViewsPerSide || av < exp.minViewsPerSide || bi + ai < minEvents) return { status: "inconclusive", sides, progress: `${bv}/${av} visitas e ${bi + ai}/${minEvents} intenções`, verdict: "Inconclusivo: amostra abaixo do mínimo definido antes do teste." };
  const t = compareRates(bi, bv, ai, av);
  const better = ai / av > bi / bv;
  const ci = diffInterval(bi, bv, ai, av);
  const method = `teste de duas proporções, bicaudal, alfa 0,05; ${bv} e ${av} visitas; diferença ${pct(ai / av - bi / bv)} p.p. (IC95% ${ci[0]} a ${ci[1]} p.p.)`;
  if (t.p < 0.05) return { status: better ? "winner" : "loser", sides, p: roundP(t.p), pDisplay: fmtP(t.p), ci95: ci, method, verdict: `${better ? "Melhorou" : "Piorou"}: ${sides.before.rate}% → ${sides.after.rate}% de intenção (${fmtP(t.p)}; IC95% da diferença ${ci[0]} a ${ci[1]} p.p.).` };
  return { status: "no_difference", sides, p: roundP(t.p), pDisplay: fmtP(t.p), ci95: ci, method, verdict: `Sem diferença comprovada: ${sides.before.rate}% → ${sides.after.rate}% (${fmtP(t.p)}).` };
}

export function evaluateTracking(exp, campaigns = []) {
  const clicks = campaigns.filter((c) => String(c.campaign).startsWith(exp.campaignPrefix)).reduce((s, c) => s + (c.views || 0), 0);
  return { status: "tracking", clicks, verdict: clicks ? `${clicks} clique(s) vindos do e-mail de oferta em 30 dias.` : "Nenhum clique registrado ainda; a sequência começou agora." };
}

// P16 (data/p16/experiments.json): a closed experiment keeps its registered outcome and is never re-evaluated, so a
// late burst of data cannot turn an experiment closed as INCONCLUSIVO (e.g. started without a sample-size calculation)
// into a "winner". The P16 gate (scripts/p16/experiment_registry_gate.py) keeps `closed` equal to the closure record.
export function evaluateClosed(exp) {
  const c = exp.closed || {};
  return { status: "closed", outcome: String(c.outcome || "INCONCLUSIVO"), closedAt: c.at || null, ref: c.ref || null,
    verdict: `Encerrado em ${c.at || "data não registrada"}: ${c.outcome || "INCONCLUSIVO"} (registro ${c.ref || "P16"}). Nenhum vencedor é declarado.` };
}

export function evaluateExperiments(registry, { videos = [], productDaily = {}, campaigns = [] } = {}, now = Date.now()) {
  return (registry?.experiments || []).map((exp) => {
    if (exp.closed) return { id: exp.id, title: exp.title, hypothesis: exp.hypothesis, metric: exp.metric, decision: exp.decision, ...evaluateClosed(exp) };
    const result = exp.kind === "arms" ? evaluateArms(exp, videos, now) : exp.kind === "before_after" ? evaluateBeforeAfter(exp, productDaily, now) : evaluateTracking(exp, campaigns);
    return { id: exp.id, title: exp.title, hypothesis: exp.hypothesis, metric: exp.metric, decision: exp.decision, ...result };
  });
}
