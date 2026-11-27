// ZEVANORY | Sessão do chat do proprietário no PostgreSQL (R1, O1, R1.2 — 26/11/2026).
// * Autoridade ÚNICA da sessão: a linha em zevanory_owner_chat_sessions no primário do PostgreSQL (relógio do banco).
//   O KV não participa da sessão (só guarda outras coisas do chat). Banco indisponível = acesso negado.
// * Ordem entre revogação e operações privilegiadas (R1.1): toda leitura, envio ou confirmação de ação é autorizada
//   NA MESMA instrução SQL que faz o trabalho, com `FOR SHARE` na linha da sessão. A revogação é um UPDATE nessa linha
//   (trava exclusiva). O PostgreSQL ordena as duas: ou a operação termina antes e a revogação espera, ou a revogação
//   termina antes e a operação, ao reavaliar a linha, não encontra sessão válida.
// * Tentativas de PIN (O1): contadores atômicos (UPSERT) por IP (5 em 15 min desde a última tentativa contada) e no
//   total por hora UTC (20). A tentativa é RESERVADA antes de comparar o PIN; PIN certo devolve a reserva.
// * Publicação em duas fases (R1.2): a fase A ("maintenance") nega toda sessão por PIN e apaga as sessões antigas do
//   KV; só depois a fase B ("postgres") entra. Um rollback de B cai em A (chat fechado), nunca em código que aceite KV.
export const SESSION_AUTHORITY = "postgres"; // padrão do handler; a entrada do Worker passa a fase do artefato.
export const SESSION_TTL_S = 12 * 3600;
export const PIN_IP_MAX = 5, PIN_IP_WINDOW_S = 900, PIN_GLOBAL_MAX = 20;
export const LEGACY_KV_SESSION_PREFIX = "zpc:owner-chat:pin-session:v1:";
const HEX64 = /^[0-9a-f]{64}$/;

const ready = new WeakSet();
export async function ensureSessionSchema(sql) {
  if (ready.has(sql)) return;
  await sql.query(`create table if not exists zevanory_owner_chat_sessions (
    token_sha256 text primary key check (token_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now(), expires_at timestamptz not null, revoked_at timestamptz)`, []);
  await sql.query(`create index if not exists zevanory_owner_chat_sessions_expires on zevanory_owner_chat_sessions (expires_at)`, []);
  await sql.query(`create table if not exists zevanory_owner_chat_pin_attempts (
    scope text not null, k text not null, n integer not null, last_at timestamptz not null, primary key (scope, k))`, []);
  await sql.query(`alter table zevanory_owner_chat_pin_attempts add column if not exists ip_window_id uuid`, []);
  // Ação reivindicada: qual sessão a autorizou (para o logout informar ações já autorizadas ainda em andamento).
  await sql.query(`alter table zevanory_owner_chat_messages add column if not exists action_session text`, []);
  // Sessão aberta pelo PAINEL: chave do marcador de fim da sessão do painel que a originou (sha256 de "panel-sid:"+sid).
  await sql.query(`alter table zevanory_owner_chat_sessions add column if not exists panel_end_marker text check (panel_end_marker is null or panel_end_marker ~ '^[0-9a-f]{64}$')`, []);
  ready.add(sql);
}

// Condição de sessão válida, com trava compartilhada na linha. Usada DENTRO das instruções de trabalho.
// Sessão do painel encerrada (marcador gravado na saída) = toda sessão de chat ligada a ela deixa de valer NA HORA, em
// qualquer aba e mesmo que uma renovação tenha corrido junto (não depende de qual cookie foi revogado).
export const PANEL_LIVE_SQL = `(panel_end_marker is null or not exists (select 1 from zevanory_owner_chat_sessions m where m.token_sha256 = zevanory_owner_chat_sessions.panel_end_marker))`;
export const SESSION_VALID_SQL = (p) => `exists (select 1 from zevanory_owner_chat_sessions where token_sha256 = $${p} and ${PANEL_LIVE_SQL} and revoked_at is null and expires_at > now() for share)`;

export async function checkSession(sql, hash) {
  if (!HEX64.test(String(hash || ""))) return false;
  const r = await sql.query(`/*owner-chat:session-check*/ select count(*)::int as n from (select 1 from zevanory_owner_chat_sessions where token_sha256 = $1 and ${PANEL_LIVE_SQL} and revoked_at is null and expires_at > now() for share) s`, [hash]);
  return Number(r[0]?.n) === 1;
}
export async function createSession(sql, hash, ttlS = SESSION_TTL_S, panelEndMarker = null) {
  const ttl = Number.isInteger(ttlS) && ttlS > 0 && ttlS <= SESSION_TTL_S ? ttlS : SESSION_TTL_S;
  const marker = HEX64.test(String(panelEndMarker || "")) ? panelEndMarker : null;
  const r = await sql.query(`/*owner-chat:session-create*/ insert into zevanory_owner_chat_sessions (token_sha256, expires_at, panel_end_marker) values ($1, now() + ($2::integer * interval '1 second'), $3) returning 1 as ok`, [hash, ttl, marker]);
  return Number(r[0]?.ok) === 1;
}
// Passe do painel de uso único: grava uma linha-marcador JÁ REVOGADA (nunca vale como sessão) com a chave do passe.
// A chave primária torna o uso atômico entre pontos de presença: a 2ª tentativa com o mesmo passe não insere nada.
export async function claimTicket(sql, markerHash) {
  if (!HEX64.test(String(markerHash || ""))) return false;
  const r = await sql.query(`/*owner-chat:ticket-claim*/ insert into zevanory_owner_chat_sessions (token_sha256, expires_at, revoked_at) values ($1, now() + interval '10 minutes', now()) on conflict (token_sha256) do nothing returning 1 as ok`, [markerHash]);
  return Number(r[0]?.ok) === 1;
}
// Fim da sessão do PAINEL que originou a sessão do chat (logout): linha-marcador revogada com a chave do painel. Depois
// dela, nenhum passe daquela sessão do painel abre sessão de chat, nem um passe emitido antes da saída (até 14 h).
export async function endPanelSession(sql, markerHash) {
  if (!HEX64.test(String(markerHash || ""))) return false;
  await sql.query(`/*owner-chat:panel-end*/ insert into zevanory_owner_chat_sessions (token_sha256, expires_at, revoked_at) values ($1, now() + interval '14 hours', now()) on conflict (token_sha256) do update set revoked_at = coalesce(zevanory_owner_chat_sessions.revoked_at, now())`, [markerHash]);
  // E revoga TODAS as sessões de chat abertas por esse login do painel (outras abas, renovação em andamento).
  await sql.query(`/*owner-chat:panel-revoke-all*/ update zevanory_owner_chat_sessions set revoked_at = now() where panel_end_marker = $1 and revoked_at is null`, [markerHash]);
  return true;
}
export async function panelSessionEnded(sql, markerHash) {
  const r = await sql.query(`/*owner-chat:panel-ended*/ select count(*)::int as n from zevanory_owner_chat_sessions where token_sha256 = $1`, [markerHash]);
  return Number(r[0]?.n) > 0;
}
// Revoga (idempotente). Retorna { revoked: true, pendingActions } só depois do commit do UPDATE. A contagem de ações
// é uma instrução SEPARADA, depois do commit: vê toda ação autorizada antes da revogação (nenhuma depois é possível).
export async function revokeSession(sql, hash) {
  await sql.query(`/*owner-chat:session-revoke*/ update zevanory_owner_chat_sessions set revoked_at = now() where token_sha256 = $1 and revoked_at is null`, [hash]);
  let pendingActions = null;
  try {
    const p = await sql.query(`/*owner-chat:session-pending*/ select count(*)::int as n from zevanory_owner_chat_messages where action_session = $1 and action_state in ('executando', 'incerto')`, [hash]);
    pendingActions = Number(p[0]?.n || 0);
  } catch { /* revogada mesmo assim; pendências desconhecidas */ }
  return { revoked: true, pendingActions };
}

// O1: reserva atômica de uma tentativa (IP e global) ANTES de comparar o PIN.
export async function reserveAttempt(sql, ipHash) {
  const r = await sql.query(`/*owner-chat:pin-reserve*/ with ip as (
      insert into zevanory_owner_chat_pin_attempts as a (scope, k, n, last_at, ip_window_id) values ('ip', $1, 1, now(), gen_random_uuid())
      on conflict (scope, k) do update set
        n = case when a.last_at <= now() - ($2::integer * interval '1 second') then 1 else a.n + 1 end,
        ip_window_id = case when a.last_at <= now() - ($2::integer * interval '1 second') then excluded.ip_window_id else coalesce(a.ip_window_id, excluded.ip_window_id) end,
        last_at = case when a.last_at <= now() - ($2::integer * interval '1 second') then now() when a.n >= $3::integer then a.last_at else now() end
      returning n, ip_window_id),
    g as (
      insert into zevanory_owner_chat_pin_attempts as a (scope, k, n, last_at) values ('global', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24'), 1, now())
      on conflict (scope, k) do update set n = a.n + 1, last_at = now()
      returning n, k)
    select ip.n::int as ip_n, g.n::int as g_n, g.k as g_k, ip.ip_window_id::text as ip_window_id from ip, g`, [ipHash, PIN_IP_WINDOW_S, PIN_IP_MAX]);
  const row = r[0];
  if (!row) throw new Error("pin_reserve_failed");
  return { ipN: Number(row.ip_n), globalN: Number(row.g_n), globalKey: String(row.g_k), ipWindowId: row.ip_window_id };
}
// Devolve a reserva apenas às janelas em que foi contabilizada.
export async function releaseAttempt(sql, ipHash, { globalKey, ipWindowId }) {
  await sql.query(`/*owner-chat:pin-release*/ update zevanory_owner_chat_pin_attempts set n = greatest(n - 1, 0) where (scope = 'ip' and k = $1 and ip_window_id = $3::uuid) or (scope = 'global' and k = $2)`, [ipHash, globalKey, ipWindowId]);
}

// R1.2: a limpeza do formato anterior é idempotente. Seu resultado serve apenas para registro.
// O destino seguro de rollback é o Worker em manutenção, que recusa sessões mesmo se houver chaves antigas.
let purgedInIsolate = false;
export async function purgeLegacyKvSessions(kv, { force = false } = {}) {
  if (!kv?.list || !kv?.delete) return { ok: false, deleted: 0 };
  if (purgedInIsolate && !force) return { ok: true, deleted: 0, skipped: true };
  let cursor, deleted = 0;
  do {
    const page = await kv.list({ prefix: LEGACY_KV_SESSION_PREFIX, cursor });
    for (const k of page.keys || []) { await kv.delete(k.name); deleted++; }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  purgedInIsolate = true;
  return { ok: true, deleted };
}

export async function sessionRetention(sql) {
  const s = await sql.query(`/*owner-chat:retention-sessions*/ with d as (delete from zevanory_owner_chat_sessions where expires_at < now() - interval '7 days' returning 1) select count(*)::int as n from d`, []);
  const a = await sql.query(`/*owner-chat:retention-attempts*/ with d as (delete from zevanory_owner_chat_pin_attempts where last_at < now() - interval '2 days' returning 1) select count(*)::int as n from d`, []);
  return { sessions: Number(s[0]?.n || 0), attempts: Number(a[0]?.n || 0) };
}
