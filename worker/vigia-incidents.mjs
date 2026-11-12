// Incidentes do Epaminondas no PostgreSQL (NC-CX-1031-01/02/03).
// Uma LINHA DE ESTADO por chave de problema (zevanory_vigia_state). Toda transição é UM comando condicional sobre
// essa linha (INSERT ... ON CONFLICT DO UPDATE ... WHERE / UPDATE ... WHERE). Em READ COMMITTED o PostgreSQL trava a
// linha e reavalia a condição na versão mais nova, então sentinelas concorrentes não abrem duas vezes, não
// resolvem com evidência velha e não reabrem com falha antiga atrasada.
// * Abrir: só se não está aberto, o ciclo anterior já foi avisado por completo (abertura e RESOLVIDO) e a evidência
//   da falha é POSTERIOR à evidência que resolveu o ciclo anterior. Cada abertura incrementa gen (ocorrência).
// * Resolver: só com observação SAUDÁVEL da mesma chave POSTERIOR à evidência de abertura.
// * Avisos por outbox: open_notified/resolve_notified; a entrega insere a mensagem com dedupe
//   vigia:abrir|resolver:<chave>:<gen> (idempotente) e só então marca entregue, condicionado ao mesmo gen.
//   Falha em qualquer ponto deixa a obrigação pendente para a próxima execução: nada se perde, nada duplica.
// * KV é só dica (zpc:vigia:abertos:v2, TTL 2 h), gravada como "pendente" ANTES de mexer no banco.
export const VIGIA_HINT_KEY = "zpc:vigia:abertos:v2";
const HINT_TTL = 2 * 3600;
const schemaReady = new WeakSet();
export async function ensureVigiaSchema(sql) {
  if (schemaReady.has(sql)) return;
  await sql.query(`create table if not exists zevanory_vigia_state (
    problem_key text primary key, gen integer not null, aberto boolean not null, opened_at timestamptz not null default now(),
    opened_evidence_at timestamptz not null, resolved_evidence_at timestamptz, open_text text not null,
    open_notified boolean not null default false, resolve_notified boolean not null default false)`, []);
  schemaReady.add(sql);
}

const duration = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const TS = (n) => `to_timestamp($${n}::double precision / 1000)`;

// Dentro de um mesmo lote, falha e saúde da mesma chave: vale a falha (nunca resolve com evidência ambígua).
export function normalizeObservations(observations) {
  const failing = new Map(), healthy = new Map();
  for (const o of observations || []) {
    if (!o || typeof o.key !== "string" || !Number.isFinite(o.at)) continue;
    if (o.health === "falha") { const p = failing.get(o.key); if (!p || o.at > p.at) failing.set(o.key, o); }
    else if (o.health === "saudavel") { const p = healthy.get(o.key); if (!p || o.at > p.at) healthy.set(o.key, o); }
  }
  for (const k of failing.keys()) healthy.delete(k);
  return { failing: [...failing.values()], healthy: [...healthy.values()] };
}

// Segunda barreira: saúde com data além de agora + 5 min é descartada aqui também, venha de onde vier.
export async function runIncidents({ sql, kv, observations, insertMessage, now = Date.now() }) {
  const { failing, healthy: all } = normalizeObservations(observations);
  const healthy = all.filter((o) => o.at <= now + 5 * 60000);
  let hint = null;
  try { const raw = await kv.get(VIGIA_HINT_KEY); const v = raw === null ? null : JSON.parse(raw); if (v && Array.isArray(v.open) && v.open.every((k) => typeof k === "string") && typeof v.pending === "boolean") hint = v; } catch {}
  // Atalho (não acorda o banco) só com dica válida e nada a fazer: toda falha já aberta, nenhuma evidência saudável
  // para chave aberta e nenhum aviso pendente. Dica ausente, ilegível ou vencida (TTL 2 h) = vai ao banco.
  if (hint && !hint.pending && failing.every((o) => hint.open.includes(o.key)) && !healthy.some((o) => hint.open.includes(o.key))) return { db: false, opened: 0, resolved: 0, delivered: 0 };
  try { await kv.put(VIGIA_HINT_KEY, JSON.stringify({ open: hint?.open || [], pending: true }), { expirationTtl: HINT_TTL }); } catch {}
  await ensureVigiaSchema(sql);
  let opened = 0, resolved = 0, delivered = 0;
  for (const o of failing) {
    const text = "⚠️ PROBLEMA — " + o.text + (o.fix ? "\nDiagnóstico e correção: " + o.fix : "");
    const r = await sql.query(`/*vigia:open*/ insert into zevanory_vigia_state as s (problem_key, gen, aberto, opened_evidence_at, open_text)
      values ($1, 1, true, ${TS(2)}, $3)
      on conflict (problem_key) do update set gen = s.gen + 1, aberto = true, opened_at = now(), opened_evidence_at = excluded.opened_evidence_at,
        resolved_evidence_at = null, open_text = excluded.open_text, open_notified = false, resolve_notified = false
      where not s.aberto and s.open_notified and s.resolve_notified and s.resolved_evidence_at < excluded.opened_evidence_at
      returning gen`, [o.key, o.at, text.slice(0, 2000)]);
    if (r[0]) opened++;
  }
  for (const o of healthy) {
    const r = await sql.query(`/*vigia:resolve*/ update zevanory_vigia_state set aberto = false, resolved_evidence_at = ${TS(2)}, resolve_notified = false
      where problem_key = $1 and aberto and opened_evidence_at < ${TS(2)} returning gen`, [o.key, o.at]);
    if (r[0]) resolved++;
  }
  const due = await sql.query(`/*vigia:outbox*/ select problem_key, gen, aberto, open_text, opened_evidence_at, resolved_evidence_at, open_notified, resolve_notified
    from zevanory_vigia_state where not open_notified or (not aberto and not resolve_notified) order by opened_at, problem_key limit 50`, []);
  for (const i of due) {
    const tag = i.problem_key + ":" + i.gen;
    if (!i.open_notified) {
      await insertMessage(sql, { from: "zevanory", kind: "alerta", text: i.open_text, dedupe: "vigia:abrir:" + tag });
      await sql.query(`/*vigia:notified-open*/ update zevanory_vigia_state set open_notified = true where problem_key = $1 and gen = $2::integer`, [i.problem_key, Number(i.gen)]);
      delivered++;
    }
    if (!i.aberto && !i.resolve_notified) {
      const first = String(i.open_text).replace(/^⚠️ PROBLEMA — /, "").split("\n")[0];
      await insertMessage(sql, { from: "zevanory", kind: "sistema", text: `✅ RESOLVIDO — ${first} (durou ${duration(Date.parse(i.resolved_evidence_at) - Date.parse(i.opened_evidence_at))}; confirmado por observação saudável posterior).`, dedupe: "vigia:resolver:" + tag });
      await sql.query(`/*vigia:notified-resolve*/ update zevanory_vigia_state set resolve_notified = true where problem_key = $1 and gen = $2::integer and not aberto`, [i.problem_key, Number(i.gen)]);
      delivered++;
    }
  }
  const open = await sql.query(`/*vigia:open-keys*/ select problem_key from zevanory_vigia_state where aberto order by problem_key`, []);
  const pending = await sql.query(`/*vigia:pending*/ select count(*)::int as n from zevanory_vigia_state where not open_notified or (not aberto and not resolve_notified)`, []);
  try { await kv.put(VIGIA_HINT_KEY, JSON.stringify({ open: open.map((r) => r.problem_key), pending: Number(pending[0]?.n || 0) > 0 }), { expirationTtl: HINT_TTL }); } catch {}
  return { db: true, opened, resolved, delivered };
}

export async function openIncidentsText(sql) {
  await ensureVigiaSchema(sql);
  const rows = await sql.query(`/*vigia:open-list*/ select open_text, opened_at from zevanory_vigia_state where aberto order by opened_at limit 20`, []);
  return rows.map((r) => "• " + String(r.open_text).replace(/^⚠️ PROBLEMA — /, "").split("\n")[0]);
}
