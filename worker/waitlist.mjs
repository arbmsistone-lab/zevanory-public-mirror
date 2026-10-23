// P01 Fase A (Ordem 080 AVAL; correções da AVAL 085): lista de espera SEM cobrança em 3 nichos e
// medição de demanda por PESSOA experimental.
// * Só pelo binding privado do Worker de vendas (host waitlist.internal) e só com FASE_A_WAITLIST="on"
//   (padrão: ausente = DESLIGADO). Esquema: migração versionada db/migrations/030_waitlist_fase_a.sql
//   (este módulo não cria tabelas; sem a migração as chamadas falham fechado com 503).
// * Unidade estatística (AVAL 085 §1): pessoa experimental única por nicho em TODA a janela, por um
//   identificador aleatório próprio (cookie assinado com WAITLIST_VISITOR_SECRET, escopo /lista-de-espera,
//   expira no fim da janela, no máximo 60 dias). Conta no denominador só quando CONFIRMADO (o navegador
//   devolveu o cookie). A inscrição leva o mesmo identificador: numerador e denominador na MESMA unidade.
//   Mesmo contato vindo de dois identificadores = mesma pessoa (alias). Sem identificador possível
//   (sem segredo ou sem janela configurada) a visita vira só "exposição pessoa-dia" e a decisão é
//   INCONCLUSIVO.
// * Segredo dedicado (§4): WAITLIST_VISITOR_SECRET com >= 32 bytes, SEM fallback; ausente = nada é contado.
// * Consentimento (§2): obrigatório só para "avisar quando abrir"; convite para entrevista é opcional.
// * Saída e retenção (§5): a saída apaga a inscrição; nenhum registro ligado ao contato sobra (o oráculo
//   guarda só contagens agregadas). Retenção por finalidade: tudo apagado 30 dias após a decisão da
//   Fase A (FASE_A_DECISION_DATE); limites absolutos de 12 meses (inscrição) e 180 dias (medição).
// * Dupla confirmação (P08, issue #871): nenhuma mensagem é enviada por este módulo.
import { isAutomationUA, DATACENTER_ASNS } from "./funnel.mjs";

export const WAITLIST_NICHES = Object.freeze(["confeitaria", "loja-de-roupas", "salao-e-barbearia"]);
export const CONSENT_VERSION = "fase-a-lista-v2-2026-10-22";
export const RETENTION = Object.freeze({ afterDecisionDays: 30, signupMaxMonths: 12, measurementMaxDays: 180, cookieMaxDays: 60 });
export const COOKIE = "zvfa";
const SALES = "https://vendas.zevanory.api.br";
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const RETENTION_MARKER = "zpc:waitlist:retention:v2:last";
export const SEEN_MARKER = "zpc:waitlist:seen:v1";
let seenMarked = false;
const DAY_MS = 86_400_000;

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
export const flagOn = (env) => String(env?.FASE_A_WAITLIST || "").trim().toLowerCase() === "on";

async function sha256Hex(value) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(value))))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randomHex = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); };
// Contato: mesmo anel de chaves do lead-magnet (atual + anterior durante rotação).
const keyOf = (v) => (v && String(v).length >= 32 ? "zevanory-waitlist-privacy-v1:" + v : "");
const privacyKeys = (env) => [keyOf(env.LEAD_PRIVACY_SECRET), keyOf(env.LEAD_PRIVACY_SECRET_PREVIOUS)].filter(Boolean);
// Visitante: segredo DEDICADO, >= 32 bytes, sem nenhum fallback (AVAL 085 §4).
export function visitorSecret(env) {
  const s = String(env?.WAITLIST_VISITOR_SECRET || "");
  return new TextEncoder().encode(s).length >= 32 ? s : null;
}
// Janela: FASE_A_WINDOW_ID (a-z0-9-) + FASE_A_WINDOW_END (AAAA-MM-DD, fim do dia UTC). Inválida/expirada = null.
export function windowOf(env, now = Date.now()) {
  const id = String(env?.FASE_A_WINDOW_ID || ""), end = String(env?.FASE_A_WINDOW_END || "");
  if (!/^[a-z0-9-]{1,32}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const endMs = Date.parse(end + "T23:59:59Z");
  if (!Number.isFinite(endMs) || endMs <= now) return null;
  return { id, end, maxAge: Math.max(1, Math.min(Math.floor((endMs - now) / 1000), RETENTION.cookieMaxDays * 86400)) };
}
const sigFor = async (secret, win, vid) => (await hmacHex(secret, `fa-vid:${win.id}:${win.end}:${vid}`)).slice(0, 32);
const personIdOf = async (secret, vid) => (await hmacHex(secret, "fa-pid:" + vid)).slice(0, 32);
// Cookie "<vid>.<sig>": devolve o person_id (HMAC do vid; o vid em claro nunca vai ao banco) ou null.
export async function personFromCookie(env, value, now = Date.now()) {
  const secret = visitorSecret(env), win = windowOf(env, now);
  const m = /^([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(String(value || ""));
  if (!secret || !win || !m || (await sigFor(secret, win, m[1])) !== m[2]) return null;
  return personIdOf(secret, m[1]);
}
async function newCookie(secret, win) { const vid = randomHex(16); return { value: `${vid}.${await sigFor(secret, win, vid)}`, pid: await personIdOf(secret, vid) }; }

export function normalizeContact(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 254) return null;
  if (s.includes("@")) { const email = s.toLowerCase(); return EMAIL_RE.test(email) ? { kind: "email", value: email } : null; }
  if (!/^[\d\s()+.-]+$/.test(s)) return null;
  let d = s.replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  if (!/^55[1-9][0-9]9?[0-9]{8}$/.test(d)) return null;
  return { kind: "whatsapp", value: d };
}
export async function contactRef(env, contact) { const key = privacyKeys(env)[0]; return key ? hmacHex(key, "contact:" + contact.kind + ":" + contact.value) : null; }
const tokenWith = async (key, ref) => (await hmacHex(key, "waitlist-optout:" + ref)).slice(0, 32);
export async function optOutLink(env, ref) { const key = privacyKeys(env)[0]; return key && ref ? `${SALES}/lista-de-espera/sair?r=${ref}&t=${await tokenWith(key, ref)}` : null; }
async function optOutTokenValid(env, ref, t) { for (const key of privacyKeys(env)) if ((await tokenWith(key, ref)) === t) return true; return false; }

// Mesmo filtro do funil (worker/funnel.mjs). Devolve a razão da exclusão ou null (elegível).
export function exclusionOf({ userAgent, asn = 0 }) {
  if (DATACENTER_ASNS.has(Number(asn))) return "asn";
  if (isAutomationUA(userAgent)) return "ua";
  return null;
}
export const isEligibleTraffic = ({ userAgent, asn = 0, purpose = "" }) => !/prefetch|prerender/i.test(String(purpose || "")) && exclusionOf({ userAgent, asn }) === null;
// Protocolo v3: origem do link (rótulo de lista fechada, sem dado pessoal) gravada na pessoa experimental.
export const SOURCE_TAGS = Object.freeze(["wa_status", "wa_lista", "ig_story", "ig_post", "ig_reel", "fb_grupo", "organico", "direto"]);
// Protocolo v4 (AVAL 092 §4): wa_status/wa_lista (WhatsApp do proprietário: status e lista de transmissão) formam
// a classe de origem "wa_owned". NÃO são descartados: ficam fora da métrica PRIMÁRIA (população da decisão),
// mas são reportados como métrica SECUNDÁRIA pré-registrada (pessoas, inscrições, conversão e Wilson próprios,
// que nunca decidem). Parceiros (parc_*) continuam fora da população da decisão; meta_* é reservado (tráfego
// pago futuro), aceito e reportado.
export const WA_OWNED_TAGS = Object.freeze(["wa_status", "wa_lista"]);
export const SOURCE_CLASSES = Object.freeze(["canal", "wa_owned", "parceiro", "reservado_meta", "sem_origem"]);
const PARTNER_RE = /^parc_[a-z0-9]{1,20}$/, META_RE = /^meta_[a-z0-9]{1,20}$/;
export const MISSING_SOURCE_TAGS = Object.freeze(["sem_tag", "invalido"]);
// utm_source da lista -> ele mesmo; utm fora da lista -> "invalido"; sem utm: referer externo -> "organico",
// nenhum -> "direto". Valor já classificado (vindo do formulário) é revalidado pela mesma lista.
export function sourceTag({ utm = "", refExternal = false } = {}) {
  const u = String(utm || "").trim().toLowerCase();
  if (u) return SOURCE_TAGS.includes(u) || PARTNER_RE.test(u) || META_RE.test(u) ? u : "invalido";
  return refExternal ? "organico" : "direto";
}
export function sourceGroup(tag) {
  if (WA_OWNED_TAGS.includes(tag)) return "wa_owned";
  if (PARTNER_RE.test(tag)) return "parceiro";
  if (META_RE.test(tag)) return "reservado_meta";
  if (MISSING_SOURCE_TAGS.includes(tag) || !tag) return "sem_origem";
  return "canal";
}
const formSource = (v) => { const t = String(v || ""); return SOURCE_TAGS.includes(t) || PARTNER_RE.test(t) || META_RE.test(t) ? t : MISSING_SOURCE_TAGS.includes(t) ? t : "invalido"; };
// SQL: população da decisão (métrica primária) = pessoa sem exclusão de robô, fora de wa_owned e de parceiros.
const WA_OWNED_IN = (a) => `${a}.src in (${WA_OWNED_TAGS.map((t) => `'${t}'`).join(",")})`;
const PRIMARY_SRC = (a) => `${a}.src not in (${WA_OWNED_TAGS.map((t) => `'${t}'`).join(",")}) and ${a}.src not like 'parc\\_%'`;
const label = (v, max) => { const x = String(v || "").toLowerCase().trim(); return new RegExp(`^[a-z0-9_-]{1,${max}}$`).test(x) ? x : ""; };
const yesNo = (v) => (v === true || v === "sim" ? true : v === false || v === "nao" ? false : null);
const today = (now) => new Date(now).toISOString().slice(0, 10);

// Contadores do oráculo (sem identificador). bump() é usado dentro de CTEs para ficar na MESMA instrução.
const BUMP = (dayP, nicheP, metricExpr, nExpr = "1") => `insert into waitlist_raw_daily (day, niche, metric, n) select ${dayP}::date, ${nicheP}, ${metricExpr}, ${nExpr}
  on conflict (day, niche, metric) do update set n = waitlist_raw_daily.n + excluded.n`;
const bump = (sql, day, niche, metric, n = 1) => sql.query(BUMP("$1", "$2", "$3", "$4::int"), [day, niche, metric, n]);

export async function recordVisit(env, sql, body = {}, now = Date.now()) {
  const niche = String(body.nicho || "");
  if (!WAITLIST_NICHES.includes(niche)) return { counted: false };
  const day = today(now), userAgent = String(body.ua || "").slice(0, 300);
  await bump(sql, day, niche, "visita:recebida");
  const secret = visitorSecret(env);
  if (!secret) { await bump(sql, day, niche, "classe:sem_segredo"); return { counted: false }; }
  if (String(body.method || "GET") !== "GET") { await bump(sql, day, niche, "classe:metodo"); return { counted: false }; }
  if (/prefetch|prerender/i.test(String(body.purpose || ""))) { await bump(sql, day, niche, "classe:prefetch"); return { counted: false }; }
  const exclusion = exclusionOf({ userAgent, asn: body.asn });
  const cls = exclusion || "incluida";
  // Exposição pessoa-dia (descritiva): HMAC diário de IP+navegador; IP e UA não são gravados em claro.
  const dhash = (await hmacHex(secret, `fa-day:${day}|${String(body.ip || "")}|${userAgent}`)).slice(0, 32);
  await sql.query(`with ins as (insert into waitlist_person_days (day, niche, dhash, exclusion) values ($1::date, $2, $3, $4) on conflict do nothing returning 1)
    ${BUMP("$1", "$2", "'classe:' || $5 || case when exists (select 1 from ins) then '' else ':dup_dia' end")}`, [day, niche, dhash, exclusion, cls]);
  const win = windowOf(env, now);
  if (!win) { await bump(sql, day, niche, "id:sem_janela:" + cls); return { counted: false }; }
  let pid = await personFromCookie(env, body.vid, now), cookie = null;
  if (!pid) { cookie = await newCookie(secret, win); pid = cookie.pid; }
  const src = sourceTag({ utm: body.utm, refExternal: body.ref_ext === true });
  // Uma pessoa por nicho na janela inteira: retorno no mesmo dia não muda nada; em outro dia soma days.
  // Origem = primeira visita (a linha existente mantém a sua).
  await sql.query(`with up as (insert into waitlist_persons (window_id, niche, person_id, first_day, last_day, exclusion, src) values ($1, $2, $3, $4::date, $4::date, $5, $7)
      on conflict (window_id, niche, person_id) do update set days = waitlist_persons.days + (case when waitlist_persons.last_day < excluded.last_day then 1 else 0 end),
        last_day = greatest(waitlist_persons.last_day, excluded.last_day)
      returning (xmax = 0) as novo)
    ${BUMP("$4", "$2", "case when (select novo from up) then 'id:novo:' else 'id:retorno:' end || $6")}`, [win.id, niche, pid, day, exclusion, cls, src]);
  return { counted: cls === "incluida", src, cookie: cookie ? { name: COOKIE, value: cookie.value, maxAge: win.maxAge } : null };
}

export async function confirmPerson(env, sql, body = {}, now = Date.now()) {
  const niche = String(body.nicho || ""), win = windowOf(env, now);
  if (!WAITLIST_NICHES.includes(niche) || !win) return false;
  const pid = await personFromCookie(env, body.vid, now);
  if (!pid) { await bump(sql, today(now), niche, "confirmacao:sem_id"); return false; }
  await sql.query(`with c as (update waitlist_persons set confirmed = true where window_id = $1 and niche = $2 and person_id = $3 and not confirmed returning 1)
    ${BUMP("$4", "$2", "'id:confirmado'", "(select count(*)::int from c)")}`, [win.id, niche, pid, today(now)]);
  return true;
}

export async function subscribe(env, sql, body = {}, now = Date.now()) {
  const niche = String(body.nicho || "");
  if (!WAITLIST_NICHES.includes(niche)) return { status: 400, body: { ok: false, code: "nicho" } };
  const contact = normalizeContact(body.contato);
  if (!contact) return { status: 400, body: { ok: false, code: "contato" } };
  if (body.consent !== true) return { status: 400, body: { ok: false, code: "consentimento" } };
  const qRecurring = yesNo(body.q1), qDigital = yesNo(body.q2);
  if (qRecurring === null || qDigital === null) return { status: 400, body: { ok: false, code: "perguntas" } };
  const ref = await contactRef(env, contact), win = windowOf(env, now);
  if (!ref || !win) return { status: 503, body: { ok: false, code: "indisponivel" } };
  const name = String(body.nome || "").trim().replace(/[\r\n<>]/g, " ").slice(0, 60) || null;
  const exclusion = exclusionOf({ userAgent: String(body.ua || ""), asn: body.asn });
  const pid = await personFromCookie(env, body.vid, now);
  const day = today(now);
  // Uma instrução: insere (idempotente por janela+nicho+contato), confirma a pessoa do cookie e conta.
  const rows = await sql.query(`with ins as (insert into waitlist_signups (window_id, niche, contact_kind, contact, contact_ref, name, q_recurring, q_digital,
        interview_ok, consent_version, consent_at, person_id, exclusion, src) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13)
        on conflict (window_id, niche, contact_ref) do nothing returning id),
      cnt as (${BUMP("$14", "$2", "case when exists (select 1 from ins) then (case when $11::text is null then 'inscricao:nova_sem_id' else 'inscricao:nova' end) else 'inscricao:repetida' end")})
    select (select count(*)::int from ins) as created,
      (select person_id from waitlist_signups where window_id = $1 and niche = $2 and contact_ref = $5) as primary_pid`,
    [win.id, niche, contact.kind, contact.value, ref, name, qRecurring, qDigital, body.interview === true, CONSENT_VERSION, pid, exclusion, formSource(body.src), day]);
  const created = Number(rows[0]?.created) > 0;
  if (pid) {
    // A inscrição prova que o navegador devolveu o cookie: confirma a pessoa (cria se ainda não existia).
    await sql.query(`with up as (insert into waitlist_persons (window_id, niche, person_id, first_day, last_day, exclusion, confirmed, src) values ($1, $2, $3, $4::date, $4::date, $5, true, $6)
        on conflict (window_id, niche, person_id) do update set confirmed = true where not waitlist_persons.confirmed returning (xmax = 0) as novo),
      a as (${BUMP("$4", "$2", "'id:novo_insc:' || coalesce($5, 'incluida')", "(select count(*)::int from up where novo)")}),
      b as (${BUMP("$4", "$2", "'id:confirmado'", "(select count(*)::int from up)")})
      select 1`, [win.id, niche, pid, day, exclusion, formSource(body.src)]);
    const primary = rows[0]?.primary_pid;
    // Mesmo contato, outro identificador: mesma pessoa comprovada (alias), conta uma vez.
    if (!created && primary && primary !== pid)
      await sql.query(`with al as (insert into waitlist_person_alias (window_id, niche, alias_id, primary_id) values ($1, $2, $3, $4) on conflict do nothing returning 1)
        ${BUMP("$5", "$2", "'id:alias'", "(select count(*)::int from al)")}`, [win.id, niche, pid, primary, day]);
  }
  return { status: 200, body: { ok: true, code: created ? "inscrito" : "ja_inscrito", optout: await optOutLink(env, ref) } };
}

async function revoke(env, sql, ref, t, now = Date.now()) {
  if (!/^[0-9a-f]{64}$/.test(ref) || !/^[0-9a-f]{32}$/.test(t) || !(await optOutTokenValid(env, ref, t))) return { status: 400, body: { ok: false, code: "link_invalido" } };
  // Uma instrução (atômica): apaga TODAS as inscrições do contato e soma só a contagem agregada por nicho.
  const rows = await sql.query(`with d as (delete from waitlist_signups where contact_ref = $1 returning niche),
      c as (insert into waitlist_raw_daily (day, niche, metric, n) select $2::date, niche, 'inscricao:revogada', count(*)::int from d group by niche
        on conflict (day, niche, metric) do update set n = waitlist_raw_daily.n + excluded.n)
    select count(*)::int as erased from d`, [ref, today(now)]);
  return { status: 200, body: { ok: true, code: "removido", erased: Number(rows[0]?.erased) || 0 } };
}

// Wilson 95% (z = 1,959964).
export function wilson(successes, n, z = 1.959964) {
  if (!n) return { low: 0, high: 0 };
  const p = successes / n, z2 = z * z, den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den, half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
export const RULE = Object.freeze({ minVisitors: 300, minConversion: 0.08, minWilsonLow: 0.05, minLeads: 20 });
// "visitors" = pessoas experimentais confirmadas; "signups" = inscrições ligadas a essas pessoas.
export function decide({ visitors, signups, complianceViolation = false, blockers = [] }) {
  if (blockers.length) return "INCONCLUSIVO";
  if (visitors < RULE.minVisitors) return "INCONCLUSIVO";
  if (complianceViolation) return "NO-GO";
  return signups / visitors >= RULE.minConversion && wilson(signups, visitors).low >= RULE.minWilsonLow && signups >= RULE.minLeads ? "GO" : "NO-GO";
}

// Consultas agregadas (nenhuma coluna de contato é lida). $1 janela, $2 de, $3 até, $4 nichos.
const RESOLVED = `coalesce(a.primary_id, s.person_id)`;
export const SUMMARY_SQL = `with n as (select unnest($4::text[]) as niche),
  p as (select p.* from waitlist_persons p where p.window_id = $1 and not exists (select 1 from waitlist_person_alias a where a.window_id = p.window_id and a.niche = p.niche and a.alias_id = p.person_id)),
  s as (select s.niche, s.exclusion, s.person_id, ${RESOLVED} as rpid from waitlist_signups s left join waitlist_person_alias a on a.window_id = s.window_id and a.niche = s.niche and a.alias_id = s.person_id where s.window_id = $1 and s.created_at::date between $2::date and $3::date),
  r as (select niche, metric, sum(n)::int as n from waitlist_raw_daily where day between $2::date and $3::date group by niche, metric)
select n.niche,
  (select count(*)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is null and ${PRIMARY_SRC("p")}) as persons,
  (select count(*)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is distinct from 'ua' and ${PRIMARY_SRC("p")}) as persons_sem_filtro_asn,
  (select count(*)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is distinct from 'asn' and ${PRIMARY_SRC("p")}) as persons_sem_filtro_ua,
  (select count(*)::int from p where p.niche = n.niche and p.confirmed and ${PRIMARY_SRC("p")}) as persons_sem_filtros,
  (select count(*)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is null) as persons_com_rede,
  (select count(*)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is null and ${WA_OWNED_IN("p")}) as persons_wa_owned,
  (select count(*)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is null and p.src like 'parc\\_%') as persons_parceiro,
  (select count(*)::int from p where p.niche = n.niche and not p.confirmed and p.exclusion is null) as persons_nao_confirmadas,
  (select count(*)::int from p where p.niche = n.niche and p.days > 1 and p.exclusion is null and p.confirmed) as persons_multi_dia,
  (select count(*)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is null and ${PRIMARY_SRC("p")}
     and exists (select 1 from p o where o.person_id = p.person_id and o.niche <> p.niche and o.confirmed and o.exclusion is null and ${PRIMARY_SRC("o")})) as persons_multi_nicho,
  (select count(*)::int from waitlist_persons x where x.window_id = $1 and x.niche = n.niche) as persons_linhas,
  (select count(*)::int from waitlist_persons x where x.window_id = $1 and x.niche = n.niche and x.confirmed) as persons_confirmadas_linhas,
  (select count(*)::int from waitlist_person_alias x where x.window_id = $1 and x.niche = n.niche) as aliases,
  (select count(*)::int from waitlist_person_days d where d.niche = n.niche and d.exclusion is null and d.day between $2::date and $3::date) as pessoa_dia,
  (select count(distinct s.rpid)::int from s join p on p.niche = s.niche and p.person_id = s.rpid and p.confirmed and p.exclusion is null where s.niche = n.niche and s.exclusion is null and ${PRIMARY_SRC("p")}) as signups,
  (select count(distinct s.rpid)::int from s join p on p.niche = s.niche and p.person_id = s.rpid and p.confirmed where s.niche = n.niche and s.exclusion is distinct from 'ua' and p.exclusion is distinct from 'ua' and ${PRIMARY_SRC("p")}) as signups_sem_filtro_asn,
  (select count(distinct s.rpid)::int from s join p on p.niche = s.niche and p.person_id = s.rpid and p.confirmed where s.niche = n.niche and s.exclusion is distinct from 'asn' and p.exclusion is distinct from 'asn' and ${PRIMARY_SRC("p")}) as signups_sem_filtro_ua,
  (select count(distinct s.rpid)::int from s join p on p.niche = s.niche and p.person_id = s.rpid and p.confirmed where s.niche = n.niche and ${PRIMARY_SRC("p")}) as signups_sem_filtros,
  (select count(distinct s.rpid)::int from s join p on p.niche = s.niche and p.person_id = s.rpid and p.confirmed and p.exclusion is null where s.niche = n.niche and s.exclusion is null) as signups_com_rede,
  (select count(distinct s.rpid)::int from s join p on p.niche = s.niche and p.person_id = s.rpid and p.confirmed and p.exclusion is null where s.niche = n.niche and s.exclusion is null and ${WA_OWNED_IN("p")}) as signups_wa_owned,
  (select count(*)::int from s where s.niche = n.niche and s.exclusion is null and s.person_id is null) as signups_sem_id,
  (select count(*)::int from s where s.niche = n.niche) as signups_linhas,
  coalesce((select json_object_agg(r.metric, r.n) from r where r.niche = n.niche), '{}'::json) as raw
from n order by n.niche`;
export const QUALIFIED_SQL = `select s.niche, count(distinct coalesce(a.primary_id, s.person_id))::int as qualified, count(*) filter (where s.interview_ok)::int as interview_ok
  from waitlist_signups s left join waitlist_person_alias a on a.window_id = s.window_id and a.niche = s.niche and a.alias_id = s.person_id
  join waitlist_persons p on p.window_id = s.window_id and p.niche = s.niche and p.person_id = coalesce(a.primary_id, s.person_id) and p.confirmed and p.exclusion is null and ${PRIMARY_SRC("p")}
  where s.window_id = $1 and s.created_at::date between $2::date and $3::date and s.exclusion is null and s.q_recurring and s.q_digital group by s.niche`;

// Mistura de canais: pessoas confirmadas sem exclusão de robô, por nicho e origem (inclui wa_owned/parceiros;
// a mistura da população da decisão é calculada em JS sem eles).
export const SOURCE_SQL = `select p.niche, p.src, count(*)::int as n from waitlist_persons p
  where p.window_id = $1 and p.confirmed and p.exclusion is null
    and not exists (select 1 from waitlist_person_alias a where a.window_id = p.window_id and a.niche = p.niche and a.alias_id = p.person_id)
  group by p.niche, p.src order by p.niche, p.src`;
// Multi-nicho (protocolo v4, §2.2): cada nicho é um braço com denominador PRÓPRIO; a mesma pessoa (mesmo cookie,
// escopo /lista-de-espera) confirmada em k nichos conta 1 vez em CADA um desses k denominadores e nunca 2 vezes no
// mesmo. A sobreposição entre braços é reportada (descritiva, nunca decide). População = métrica primária.
export const CROSS_NICHE_SQL = `with p as (select p.person_id, p.niche from waitlist_persons p where p.window_id = $1 and p.confirmed and p.exclusion is null and ${PRIMARY_SRC("p")}
    and not exists (select 1 from waitlist_person_alias a where a.window_id = p.window_id and a.niche = p.niche and a.alias_id = p.person_id)),
  k as (select person_id, count(*)::int as niches from p group by person_id)
select (select count(*)::int from p) as person_niche_rows, (select count(*)::int from k) as unique_persons,
  (select count(*)::int from k where niches >= 2) as persons_2plus_niches`;
// Mesma mistura de canais entre os braços (pré-registrado): cada nicho com >= 1 pessoa, origem ausente
// (sem_tag/invalido) <= 5% em cada nicho e diferença máxima de participação de qualquer origem <= 10 pontos.
export const BALANCE = Object.freeze({ maxMissingShare: 0.05, maxShareDiff: 0.10 });
export function channelBalance(mix) {
  const niches = Object.keys(mix);
  const totals = Object.fromEntries(niches.map((k) => [k, Object.values(mix[k]).reduce((a, b) => a + b, 0)]));
  const missing = Object.fromEntries(niches.map((k) => [k, totals[k] ? MISSING_SOURCE_TAGS.reduce((a, t) => a + (mix[k][t] || 0), 0) / totals[k] : 1]));
  if (!niches.length || niches.some((k) => !totals[k])) return { status: "NAO_VERIFICAVEL", reason: "nicho_sem_pessoas", missing_share: missing, max_share_diff: null };
  if (niches.some((k) => missing[k] > BALANCE.maxMissingShare)) return { status: "NAO_VERIFICAVEL", reason: "origem_ausente", missing_share: missing, max_share_diff: null };
  const tags = [...new Set(niches.flatMap((k) => Object.keys(mix[k])))];
  let diff = 0;
  for (const t of tags) { const shares = niches.map((k) => (mix[k][t] || 0) / totals[k]); diff = Math.max(diff, Math.max(...shares) - Math.min(...shares)); }
  return { status: diff <= BALANCE.maxShareDiff ? "EQUILIBRADO" : "DESEQUILIBRADO", reason: null, missing_share: missing, max_share_diff: diff };
}
export function finalistsOf(niches, balance) {
  if (balance.status !== "EQUILIBRADO") return { finalists: [], reason: "mistura_de_canais_" + balance.status.toLowerCase() };
  const go = Object.entries(niches).filter(([, v]) => v.decision === "GO").sort((a, b) => b[1].wilson95.low - a[1].wilson95.low || b[1].signups - a[1].signups);
  return { finalists: go.slice(0, 2).map(([k]) => k), reason: go.length ? null : "nenhum_go" };
}

// "Semana de teste" (protocolo v3, condição aprovada pelo Sol): 7 dias CONSECUTIVOS de tráfego gratuito
// apontado às calculadoras, com utm_campaign=sdt-<nicho>. O funil (worker/funnel.mjs, FASE_A_SEMANA_TESTE=on)
// conta por nicho e dia "sdt:<nicho>:visita", "sdt:<nicho>:qualificada" (visitante único do dia, sem robôs/
// datacenter, com Accept-Language e país BR) e "sdt:<nicho>:pago" (utm_source meta_*, reservado a pago).
// Autoriza SOMENTE o teste de 21 dias se, em TODOS os nichos: 7 dias consecutivos com tráfego, >= 98
// visitas qualificadas, distribuição estável (nenhum dia com mais de 30% das qualificadas) e zero tráfego pago.
export const TEST_WEEK = Object.freeze({ days: 7, minQualifiedPerNiche: 98, maxDayShare: 0.30, maxPaid: 0, windowDays: 21 });
export const TEST_WEEK_SQL = `select day::text as day, metric, sum(n)::int as n from zevanory_funnel_daily
  where day between $1::date and $2::date and metric like 'sdt:%' group by day, metric order by day, metric`;
export function testWeekSummary(rows, { since, until } = {}) {
  const start = Date.parse(since + "T00:00:00Z");
  const days = Math.round((Date.parse(until + "T00:00:00Z") - start) / DAY_MS) + 1;
  const valid = Number.isFinite(days) && days === TEST_WEEK.days;
  const dayList = valid ? Array.from({ length: days }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10)) : [];
  const niches = {};
  for (const n of WAITLIST_NICHES) niches[n] = { qualified: 0, visits: 0, paid: 0, qualified_per_day: {}, visits_per_day: {} };
  for (const r of rows) {
    const m = /^sdt:([a-z-]+):(qualificada|visita|pago)$/.exec(String(r.metric));
    if (!m || !niches[m[1]]) continue;
    const v = niches[m[1]], d = String(r.day).slice(0, 10), k = Number(r.n) || 0;
    if (m[2] === "qualificada") { v.qualified += k; v.qualified_per_day[d] = (v.qualified_per_day[d] || 0) + k; }
    else if (m[2] === "visita") { v.visits += k; v.visits_per_day[d] = (v.visits_per_day[d] || 0) + k; }
    else v.paid += k;
  }
  for (const v of Object.values(niches)) {
    const q = dayList.map((d) => v.qualified_per_day[d] || 0);
    v.days_with_traffic = dayList.filter((d) => (v.visits_per_day[d] || 0) > 0).length;
    v.max_day_share = v.qualified ? Math.max(...q) / v.qualified : 1;
    v.reasons = [];
    if (!valid) v.reasons.push("periodo_diferente_de_7_dias");
    if (valid && v.days_with_traffic !== TEST_WEEK.days) v.reasons.push("dias_nao_consecutivos");
    if (v.qualified < TEST_WEEK.minQualifiedPerNiche) v.reasons.push("menos_de_98_qualificadas");
    if (v.max_day_share > TEST_WEEK.maxDayShare) v.reasons.push("distribuicao_instavel");
    if (v.paid > TEST_WEEK.maxPaid) v.reasons.push("trafego_pago");
    v.passes = v.reasons.length === 0;
  }
  const decision = !valid ? "PERIODO_INVALIDO" : Object.values(niches).every((v) => v.passes) ? "AUTORIZA_TESTE_21_DIAS" : "NAO_AUTORIZA";
  return { schema: "zevanory-fase-a-semana-teste/v2", protocol: "v3", period: { since, until, days }, rule: TEST_WEEK, niches, decision,
    note: "autoriza somente a abertura do teste de 21 dias; não decide GO/NO-GO" };
}
export async function buildTestWeekSummary(sql, { since, until }) { return testWeekSummary(await sql.query(TEST_WEEK_SQL, [since, until]), { since, until }); }

const R = (raw, k) => Number(raw?.[k]) || 0;
const secondaryOf = (p, s) => { const persons = Number(p) || 0, signups = Number(s) || 0; return { source_class: "wa_owned", persons, signups, conversion: persons ? signups / persons : 0, wilson95: wilson(signups, persons), decides: false }; };
const sumPrefix = (raw, prefix) => Object.entries(raw || {}).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + (Number(v) || 0), 0);
// Oráculo independente: reconcilia contadores agregados com as linhas. Qualquer divergência = INCONCLUSIVO.
export function reconcile(row) {
  const raw = typeof row.raw === "string" ? JSON.parse(row.raw) : row.raw || {};
  const classes = ["incluida", "ua", "asn"];
  const classTotal = classes.reduce((a, c) => a + R(raw, "classe:" + c) + R(raw, `classe:${c}:dup_dia`), 0) + R(raw, "classe:sem_segredo") + R(raw, "classe:metodo") + R(raw, "classe:prefetch");
  const classified = classes.reduce((a, c) => a + R(raw, "classe:" + c) + R(raw, `classe:${c}:dup_dia`), 0);
  const idOutcomes = classes.reduce((a, c) => a + R(raw, "id:retorno:" + c) + R(raw, "id:sem_janela:" + c) + R(raw, "id:novo:" + c), 0);
  const signupNew = R(raw, "inscricao:nova") + R(raw, "inscricao:nova_sem_id");
  const checks = {
    visitas_recebidas_igual_classes: R(raw, "visita:recebida") === classTotal,
    // Cada visita classificada (incluída/ua/asn) tem exatamente um desfecho de identificador.
    um_desfecho_de_id_por_visita: idOutcomes === classified,
    // Pessoas = criadas por visita + criadas por inscrição (cookie válido sem linha prévia).
    pessoas_linhas_igual_criadas: Number(row.persons_linhas) === sumPrefix(raw, "id:novo:") + sumPrefix(raw, "id:novo_insc:"),
    confirmadas_linhas_igual_contador: Number(row.persons_confirmadas_linhas) === R(raw, "id:confirmado"),
    aliases_linhas_igual_contador: Number(row.aliases) === R(raw, "id:alias"),
    inscricoes_linhas_mais_apagadas_igual_novas: Number(row.signups_linhas) + R(raw, "inscricao:revogada") + R(raw, "inscricao:apagada_retencao") === signupNew,
    pessoa_dia_linhas_igual_contador: Number(row.pessoa_dia) === R(raw, "classe:incluida"),
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

export function summarize(rows, { windowId, since, until, qualified = [], sources = [], crossNiche = null, complianceViolations = {} } = {}) {
  const q = Object.fromEntries(qualified.map((r) => [r.niche, r]));
  const mixAll = {}, mixPrimary = {};
  for (const r of rows) { mixAll[r.niche] = {}; mixPrimary[r.niche] = {}; }
  for (const r of sources) {
    if (!mixAll[r.niche]) continue;
    mixAll[r.niche][r.src] = (mixAll[r.niche][r.src] || 0) + (Number(r.n) || 0);
    const g = sourceGroup(r.src);
    if (g !== "wa_owned" && g !== "parceiro") mixPrimary[r.niche][r.src] = (mixPrimary[r.niche][r.src] || 0) + (Number(r.n) || 0);
  }
  const niches = {};
  for (const r of rows) {
    const raw = typeof r.raw === "string" ? JSON.parse(r.raw) : r.raw || {};
    const persons = Number(r.persons) || 0, signups = Number(r.signups) || 0;
    const rec = reconcile({ ...r, raw });
    const blockers = [];
    if (!windowId) blockers.push("janela_nao_informada");
    if (R(raw, "classe:sem_segredo")) blockers.push("segredo_de_visitante_ausente");
    if (sumPrefix(raw, "id:sem_janela:")) blockers.push("identificador_nao_estabelecido");
    if (Number(r.signups_sem_id)) blockers.push("inscricao_sem_identificador");
    if (!rec.ok) blockers.push("oraculo_divergente");
    const sens = (p, s) => ({ persons: Number(p) || 0, signups: Number(s) || 0, conversion: Number(p) ? (Number(s) || 0) / Number(p) : 0 });
    niches[r.niche] = {
      unit: "pessoa_experimental_confirmada",
      eligible_visitors: persons, signups, qualified: Number(q[r.niche]?.qualified) || 0, interview_ok: Number(q[r.niche]?.interview_ok) || 0,
      conversion: persons ? signups / persons : 0, wilson95: wilson(signups, persons),
      exposure_person_days: Number(r.pessoa_dia) || 0, unconfirmed_ids: Number(r.persons_nao_confirmadas) || 0, multi_day_persons: Number(r.persons_multi_dia) || 0, aliases: Number(r.aliases) || 0,
      signups_without_id: Number(r.signups_sem_id) || 0, revoked: R(raw, "inscricao:revogada"),
      excluded: { ua: R(raw, "classe:ua") + R(raw, "classe:ua:dup_dia"), asn: R(raw, "classe:asn") + R(raw, "classe:asn:dup_dia"), prefetch: R(raw, "classe:prefetch"), method: R(raw, "classe:metodo"), no_secret: R(raw, "classe:sem_segredo") },
      sensitivity: { with_filters: sens(r.persons, r.signups), without_asn_filter: sens(r.persons_sem_filtro_asn, r.signups_sem_filtro_asn), without_ua_filter: sens(r.persons_sem_filtro_ua, r.signups_sem_filtro_ua), without_filters: sens(r.persons_sem_filtros, r.signups_sem_filtros), with_wa_owned_and_partners: sens(r.persons_com_rede, r.signups_com_rede) },
      excluded_source: { wa_owned: Number(r.persons_wa_owned) || 0, parceiro: Number(r.persons_parceiro) || 0 },
      // Métrica SECUNDÁRIA pré-registrada (v4): origem wa_owned com unidade, conversão e Wilson próprios; nunca decide.
      secondary: { wa_owned: secondaryOf(r.persons_wa_owned, r.signups_wa_owned) },
      cross_niche_persons: Number(r.persons_multi_nicho) || 0,
      source_mix: mixAll[r.niche] || {}, source_mix_decision_population: mixPrimary[r.niche] || {},
      oracle: rec, blockers,
      decision: decide({ visitors: persons, signups, complianceViolation: Boolean(complianceViolations[r.niche]), blockers }),
    };
  }
  const balance = channelBalance(mixPrimary);
  const cn = crossNiche || {};
  const cross_niche = { rule: "um_por_nicho", person_niche_rows: Number(cn.person_niche_rows) || 0, unique_persons: Number(cn.unique_persons) || 0, persons_2plus_niches: Number(cn.persons_2plus_niches) || 0 };
  return { schema: "zevanory-fase-a/v4", protocol: "v4", consent_version: CONSENT_VERSION, window: { id: windowId || null, since, until }, rule: RULE, niches,
    cross_niche, channel_balance: balance, ...finalistsOf(niches, balance) };
}
export async function buildWaitlistSummary(sql, { windowId, since = "2026-01-01", until = "2999-12-31", complianceViolations = {} } = {}) {
  const rows = await sql.query(SUMMARY_SQL, [windowId || "", since, until, [...WAITLIST_NICHES]]);
  const qualified = await sql.query(QUALIFIED_SQL, [windowId || "", since, until]);
  const sources = await sql.query(SOURCE_SQL, [windowId || "", since, until]);
  const crossNiche = (await sql.query(CROSS_NICHE_SQL, [windowId || ""]))[0] || null;
  return summarize(rows, { windowId, since, until, qualified, sources, crossNiche, complianceViolations });
}

// Retenção por finalidade (texto da página e da política): 30 dias após FASE_A_DECISION_DATE apaga
// inscrições e medição; limites absolutos: inscrição 12 meses, medição 180 dias. 1x/dia (marcador KV);
// sem a lista nunca ligada e com a bandeira desligada, nenhuma consulta. Cada exclusão é uma instrução
// atômica que soma só a contagem agregada.
export async function runWaitlistRetention(env, { sqlFactory, now = Date.now(), force = false } = {}) {
  if (!env?.DATABASE_URL || !sqlFactory) return { ok: false, reason: "waitlist_retention_unconfigured" };
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const day = today(now);
  if (!flagOn(env)) { let seen = null; try { seen = await kv?.get?.(SEEN_MARKER); } catch {} if (!seen) return { ok: true, skipped: "never_enabled" }; }
  if (!force) { try { if ((await kv?.get?.(RETENTION_MARKER)) === day) return { ok: true, skipped: "already_ran_today" }; } catch {} }
  const sql = sqlFactory(env.DATABASE_URL);
  const exists = await sql.query("select to_regclass('waitlist_signups') is not null as present", []);
  let out = { ok: true, erased: 0, measurement_erased: 0 };
  if (exists[0]?.present === true || exists[0]?.present === "t") {
    const dec = /^\d{4}-\d{2}-\d{2}$/.test(String(env.FASE_A_DECISION_DATE || "")) ? String(env.FASE_A_DECISION_DATE) : null;
    const purposeOver = dec ? Date.parse(dec + "T00:00:00Z") + RETENTION.afterDecisionDays * DAY_MS <= now : false;
    const e = await sql.query(`with d as (delete from waitlist_signups where $1::boolean or created_at < $2::timestamptz - ($3::int * interval '1 month') returning niche),
        c as (insert into waitlist_raw_daily (day, niche, metric, n) select $4::date, niche, 'inscricao:apagada_retencao', count(*)::int from d group by niche
          on conflict (day, niche, metric) do update set n = waitlist_raw_daily.n + excluded.n)
      select count(*)::int as n from d`, [purposeOver, new Date(now).toISOString(), RETENTION.signupMaxMonths, day]);
    const cut = today(now - RETENTION.measurementMaxDays * DAY_MS);
    const m = await sql.query(`with a as (delete from waitlist_persons where $1::boolean or last_day < $2::date returning 1),
        b as (delete from waitlist_person_alias where $1::boolean or created_day < $2::date returning 1),
        c as (delete from waitlist_person_days where $1::boolean or day < $2::date returning 1)
      select (select count(*) from a)::int + (select count(*) from b)::int + (select count(*) from c)::int as n`, [purposeOver, cut]);
    out = { ok: true, erased: e.reduce((s, r) => s + (Number(r.n) || 0), 0), measurement_erased: Number(m[0]?.n) || 0, purpose_over: purposeOver };
  }
  try { await kv?.put?.(RETENTION_MARKER, day, { expirationTtl: 3 * 86400 }); } catch {}
  return out;
}

// Endpoint do binding privado (somente o Worker de vendas o alcança).
export async function handleWaitlist(request, env, { sqlFactory, now } = {}) {
  const url = new URL(request.url);
  if (url.hostname !== "waitlist.internal") return null;
  if (!flagOn(env)) return json(404, { ok: false, code: "desligado" });
  if (!sqlFactory || !env.DATABASE_URL) return json(503, { ok: false, code: "indisponivel" });
  if (request.method !== "POST") return json(405, { ok: false });
  const sql = sqlFactory(env.DATABASE_URL);
  if (!seenMarked) { seenMarked = true; try { await env.ZEVANORY_PRIVATE_ARTIFACTS?.put?.(SEEN_MARKER, "1"); } catch {} }
  let body = {};
  try { body = await request.json(); } catch {}
  const t = now ?? Date.now();
  try {
    if (url.pathname === "/inscrever") { const out = await subscribe(env, sql, body, t); return json(out.status, out.body); }
    if (url.pathname === "/sair") { const out = await revoke(env, sql, String(body.r || ""), String(body.t || ""), t); return json(out.status, out.body); }
    if (url.pathname === "/sair/verificar") {
      const ok = /^[0-9a-f]{64}$/.test(String(body.r || "")) && /^[0-9a-f]{32}$/.test(String(body.t || "")) && (await optOutTokenValid(env, String(body.r), String(body.t)));
      return json(ok ? 200 : 400, { ok });
    }
    if (url.pathname === "/visita") { const out = await recordVisit(env, sql, body, t); return json(200, { ok: true, cookie: out.cookie || null, src: out.src || null }); }
    if (url.pathname === "/confirmar") { await confirmPerson(env, sql, body, t); return new Response(null, { status: 204 }); }
  } catch (error) {
    console.error("waitlist_failed", error instanceof Error ? error.message.slice(0, 120) : String(error));
    return json(503, { ok: false, code: "indisponivel" });
  }
  return json(404, { ok: false });
}
export function resetWaitlistState() { seenMarked = false; }
