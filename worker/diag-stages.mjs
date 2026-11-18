// P19 fase 1 (medição, sem mudar comportamento): etapas de leitura com registro de ENTRADA e de SAÍDA.
// Uma leitura que trava deixa a linha `phase:"start"` sem a `phase:"end"` correspondente; o Server-Timing só
// existe quando há resposta, por isso a entrada é registrada antes de qualquer espera.
// Os logs operacionais carregam o nome técnico da etapa; o cabeçalho público Server-Timing usa só rótulos
// genéricos (db, kv, total) e durações. Nenhum dado de cliente, consulta, cabeçalho ou credencial é registrado.
// O valor e os erros da etapa são devolvidos/relançados sem alteração (status, payload e fail-closed preservados).

export const DIAG_EVT = "diag_stage";
export const DIAG_RID_RE = /^[0-9a-f]{12}$/;
export const DIAG_RID_HEADER = "x-zevanory-diag";
export const PUBLIC_GROUPS = Object.freeze(["db", "kv"]);

export function newDiagRid() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function cleanDiagRid(value) {
  const v = String(value || "").toLowerCase();
  return DIAG_RID_RE.test(v) ? v : null;
}

// rid: o chamador pode trazer o seu (cabeçalho x-zevanory-diag, 12 hex) para que a ENTRADA da etapa seja
// correlacionável mesmo sem resposta; inválido ou ausente = aleatório. É correlação, não autenticação.
export function ridFrom(request) {
  try { return cleanDiagRid(request?.headers?.get?.(DIAG_RID_HEADER)) || newDiagRid(); } catch { return newDiagRid(); }
}

export function createDiag(route, { rid = newDiagRid(), log = (line) => console.log(line), now = () => Date.now() } = {}) {
  const t0 = now();
  const groups = Object.create(null);
  const emit = (o) => { try { log(JSON.stringify({ evt: DIAG_EVT, rid, route, ...o })); } catch { /* registro nunca derruba a rota */ } };
  async function stage(name, group, fn) {
    const s = now();
    emit({ stage: name, phase: "start" });
    try {
      const value = await fn();
      const ms = now() - s;
      if (PUBLIC_GROUPS.includes(group)) groups[group] = (groups[group] || 0) + ms;
      emit({ stage: name, phase: "end", ok: true, ms });
      return value;
    } catch (e) {
      const ms = now() - s;
      if (PUBLIC_GROUPS.includes(group)) groups[group] = (groups[group] || 0) + ms;
      emit({ stage: name, phase: "end", ok: false, ms, error_class: String(e?.name || "Error").slice(0, 40) });
      throw e;
    }
  }
  // begin/end: para medir uma linha existente sem reescrevê-la (leituras que já tratam o próprio erro).
  function begin(name, group) {
    const s = now();
    emit({ stage: name, phase: "start" });
    return { end(ok = true) {
      const ms = now() - s;
      if (PUBLIC_GROUPS.includes(group)) groups[group] = (groups[group] || 0) + ms;
      emit({ stage: name, phase: "end", ok: ok === true, ms });
    } };
  }
  function note(fields) { emit({ phase: "note", ...fields }); }
  function serverTiming() {
    const parts = PUBLIC_GROUPS.filter((g) => Number.isFinite(groups[g])).map((g) => `${g};dur=${Math.max(0, Math.round(groups[g]))}`);
    parts.push(`total;dur=${Math.max(0, Math.round(now() - t0))}`);
    return parts.join(", ");
  }
  return { rid, route, stage, begin, note, serverTiming };
}

// Recuperação de uma tentativa SEM resposta (o cliente não recebeu cabeçalhos, logo nem o rid): nos logs do Worker,
// as etapas com `start` e sem `end` dentro da janela da sonda do smoke (de SURFACE_PROBE_START até o tempo limite)
// são o evento interno daquela tentativa. Entrada: linhas `diag_stage` já lidas (objetos), com `at` opcional (ms)
// atribuído pelo coletor de logs. Saída: [{rid, route, stage, read_route?}] em ordem de entrada.
export function openStages(lines, { route = null, from = -Infinity, to = Infinity } = {}) {
  const open = new Map();
  for (const l of lines) {
    if (!l || l.evt !== DIAG_EVT || (route && l.route !== route)) continue;
    if (Number.isFinite(l.at) && (l.at < from || l.at > to)) continue;
    const key = `${l.rid}|${l.stage}|${l.read_route || ""}`;
    if (l.phase === "start") open.set(key, { rid: l.rid, route: l.route, stage: l.stage, ...(l.read_route ? { read_route: l.read_route } : {}) });
    else if (l.phase === "end") open.delete(key);
  }
  return [...open.values()];
}
