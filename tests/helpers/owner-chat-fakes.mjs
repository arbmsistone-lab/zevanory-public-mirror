// Banco falso dos testes do Chat do Proprietário (semântica das consultas marcadas).
export function fakeSql() {
  const rows = []; let seq = 0; let cseq = 0; const ai = new Map(); const log = []; let clock = Date.parse("2026-11-12T23:00:00Z");
  const lock = { holder: null, since: null }; const neurons = { n: 0, fail: false };
  const out = (r) => ({ id: String(r.id), seq: String(r.seq ?? r.id), created_at: new Date(r.created_at).toISOString(), sender: r.sender, kind: r.kind, body: r.body, action_type: r.action_type, action_expires_at: r.action_expires_at ? new Date(r.action_expires_at).toISOString() : null, action_state: r.action_state });
  return { rows, log, lock, neurons, tick: (ms) => { clock += ms; }, query: async (text, p = []) => {
    const tag = (/\/\*owner-chat:([a-z-]+)\*\//.exec(text) || [])[1] || (/\/\*chat:neurons\*\//.test(text) ? "neurons" : /^\s*(create|alter)\b/i.test(text) ? "ddl" : "?");
    log.push(tag);
    if (tag === "ddl") return [];
    if (tag === "insert") {
      if (p[5] !== null && rows.some((r) => r.dedupe_key === p[5])) { seq++; cseq++; return []; }
      const r = { id: ++seq, seq: ++cseq, created_at: clock, sender: p[0], kind: p[1], body: p[2], action_type: p[3], action_expires_at: p[3] ? clock + p[4] * 1000 : null, action_state: p[3] ? "proposta" : null, dedupe_key: p[5] };
      rows.push(r); return [out(r)];
    }
    if (tag === "feed") return rows.slice().sort((a, b) => (b.seq ?? b.id) - (a.seq ?? a.id)).slice(0, p[0]).map(out);
    if (tag === "feed-after") return rows.filter((r) => (r.seq ?? r.id) > Number(p[0])).sort((a, b) => (a.seq ?? a.id) - (b.seq ?? b.id)).slice(0, p[1]).map(out);
    if (tag === "lock") { if (lock.holder !== null) return []; lock.holder = String(p[0]); lock.since = clock; return [{ holder: lock.holder }]; }
    if (tag === "unlock") { if (lock.holder === String(p[0])) { lock.holder = null; lock.since = null; } return []; }
    if (tag === "lock-read") return lock.holder === null ? [] : [{ holder: lock.holder, age: Math.floor((clock - lock.since) / 1000) }];
    if (tag === "neurons") { if (neurons.fail) throw new Error("db"); if (neurons.n + p[1] > p[2]) return []; neurons.n += p[1]; return [{ n: neurons.n }]; }
    if (tag === "claim") { const r = rows.find((x) => String(x.id) === p[0] && x.action_state === "proposta" && x.action_expires_at > clock); if (!r) return []; r.action_state = "executando"; return [{ action_type: r.action_type }]; }
    if (tag === "action-state") { const r = rows.find((x) => String(x.id) === p[0] && x.action_type); return r ? [{ action_state: r.action_state, action_type: r.action_type, live: r.action_expires_at > clock }] : []; }
    if (tag === "settle") { const r = rows.find((x) => String(x.id) === p[0] && ["executando", "incerto"].includes(x.action_state)); if (r) r.action_state = p[1]; return []; }
    if (tag === "ai-reserve") { const n = ai.get(p[0]) || 0; if (n >= p[1]) return []; ai.set(p[0], n + 1); return [{ n: n + 1 }]; }
    if (tag === "retention") { const before = rows.length; for (let i = rows.length - 1; i >= 0; i--) if (rows[i].created_at < clock - 180 * 86400000) rows.splice(i, 1); return [{ n: before - rows.length }]; }
    if (tag === "retention-ai") { let n = 0; for (const d of [...ai.keys()]) if (Date.parse(d) < clock - 60 * 86400000) { ai.delete(d); n++; } return [{ n }]; }
    throw new Error("consulta desconhecida: " + text.slice(0, 60));
  } };
}
