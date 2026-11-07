// P12 (roteiro v4.9.1, seção 12-B.4): avaliador da matriz data/p12-degradacao-12b4.json. Puro, sem rede.
// Para cada cenário (um componente fora) e cada direito, procura um caminho que dê esse direito e cujo
// RECEBIMENTO não dependa do componente que caiu. Lacuna = cenário × direito sem caminho.
// Também valida a forma da matriz (componentes conhecidos, direitos conhecidos, carimbo e "informado_em").
export function validateMatrix(m) {
  const problems = [];
  const comps = new Set(Array.isArray(m?.componentes) ? m.componentes : []);
  const rights = new Set(Array.isArray(m?.direitos) ? m.direitos : []);
  if (!comps.size) problems.push("sem_componentes");
  if (!rights.size) problems.push("sem_direitos");
  for (const c of m?.cenarios || []) if (!comps.has(c?.falha)) problems.push("cenario_com_componente_desconhecido:" + c?.id);
  for (const p of m?.caminhos || []) {
    for (const r of p?.direitos || []) if (!rights.has(r)) problems.push("direito_desconhecido:" + p?.id + ":" + r);
    for (const d of [...(p?.deps_recebimento || []), ...(p?.deps_tratamento || [])]) if (!comps.has(d)) problems.push("dependencia_desconhecida:" + p?.id + ":" + d);
    if (!Array.isArray(p?.deps_recebimento) || !p.deps_recebimento.length) problems.push("sem_deps_recebimento:" + p?.id);
    for (const d of p?.deps_recebimento || []) if (!(p?.deps_tratamento || []).includes(d)) problems.push("recebimento_fora_do_tratamento:" + p?.id + ":" + d);
    if (typeof p?.carimbo !== "string" || !p.carimbo.trim()) problems.push("sem_carimbo:" + p?.id);
    if (typeof p?.informado_em !== "string" || !p.informado_em.trim()) problems.push("sem_informado_em:" + p?.id);
  }
  return problems;
}

export function evaluateMatrix(m) {
  const rows = [];
  const gaps = [];
  for (const c of m?.cenarios || []) {
    for (const r of m?.direitos || []) {
      const caminhos = (m?.caminhos || [])
        .filter((p) => (p.direitos || []).includes(r) && !(p.deps_recebimento || []).includes(c.falha))
        .map((p) => ({ id: p.id, diferido: (p.deps_tratamento || []).includes(c.falha) }));
      rows.push({ cenario: c.id, direito: r, caminhos });
      if (!caminhos.length) gaps.push(c.id + "×" + r);
    }
  }
  return { ok: gaps.length === 0, gaps, rows };
}
