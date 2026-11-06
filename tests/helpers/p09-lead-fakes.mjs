// P09: cópia do banco falso de tests/lead-magnet.test.mjs (mesmo SQL do worker/lead-magnet.mjs), para o teste ponta a
// ponta de descadastro do P09 rodar o caminho REAL de inscrição, confirmação e descadastro sem rede: mailbox()
// substitui globalThis.fetch e só captura o que seria enviado (nenhum e-mail sai).
// Minimal in-memory model of the zevanory_leads / zevanory_lead_events tables driven by the module's SQL.
export function fakeDb() {
  const rows = new Map();
  const events = [];
  const queries = [];
  const DAY = 86400e3;
  const query = async (text, params = []) => {
    const t = text.trim();
    queries.push(t);
    if (/^create table|^alter table/i.test(t)) return [];
    if (/^select status, confirmed_at/i.test(t)) { const r = rows.get(params[0]); return r ? [r] : []; }
    if (/^insert into zevanory_leads/i.test(t)) {
      const [email, email_hash, name, consent_version, token_hash, subject_ref] = params;
      const prev = rows.get(email);
      rows.set(email, { ...(prev || { nurture_step: 0 }), email, email_hash, name, consent_version, token_hash, subject_ref: prev?.subject_ref ?? subject_ref, consent_at: Date.now(), token_expires_at: Date.now() + 48 * 3600e3, status: prev?.status === "confirmed" ? "confirmed" : "pending" });
      return [];
    }
    if (/^insert into zevanory_lead_events \(subject_ref, event, consent_version\) values/i.test(t)) { events.push({ subject_ref: params[0], event: params[1], consent_version: params[2], at: Date.now() }); return []; }
    if (/^insert into zevanory_lead_events .* unnest/i.test(t)) { params[0].forEach((ref, i) => events.push({ subject_ref: ref, event: params[1][i], consent_version: params[2][i], at: Date.now() })); return []; }
    if (/^update zevanory_leads set status='confirmed'/i.test(t)) {
      for (const r of rows.values()) if (r.token_hash === params[0] && r.status === "pending" && r.token_expires_at > Date.now()) { Object.assign(r, { status: "confirmed", token_hash: null, nurture_step: 1, nurture_at: new Date().toISOString() }); return [{ email: r.email, name: r.name, subject_ref: r.subject_ref, consent_version: r.consent_version }]; }
      return [];
    }
    if (/^update zevanory_leads set nurture_step=\$1 where status='confirmed' and consent_version=\$2/i.test(t)) {
      for (const r of rows.values()) if (r.status === "confirmed" && r.consent_version === params[1] && r.nurture_step >= params[2] && r.nurture_step < params[0]) r.nurture_step = params[0];
      return [];
    }
    if (/^select email, name, nurture_step/i.test(t)) return [...rows.values()].filter((r) => r.status === "confirmed" && r.nurture_step < params[0] && Date.parse(r.nurture_at) < Date.now() - 2 * DAY);
    if (/^update zevanory_leads set nurture_step=\$2, nurture_at=now\(\) where email=\$1 and status='confirmed' and nurture_step=\$3 returning email/.test(t)) {
      hooks.beforeClaim?.(params[0]);
      const r = rows.get(params[0]);
      if (!r || r.status !== "confirmed" || r.nurture_step !== params[2]) return [];
      r.nurture_step = params[1]; r.nurture_at = new Date().toISOString(); return [{ email: r.email }];
    }
    if (/^update zevanory_leads set nurture_step=\$2 where email=\$1 and nurture_step=\$3/.test(t)) { const r = rows.get(params[0]); if (r && r.nurture_step === params[2]) r.nurture_step = params[1]; return []; }
    if (/^select distinct p.subject_ref from zevanory_lead_events p/.test(t)) {
      const out = new Set();
      for (const e of events) if (e.event === "erase_kv_pending" && e.subject_ref && !events.some((d) => d.subject_ref === e.subject_ref && d.event === "erase_kv_done" && d.at >= e.at)) out.add(e.subject_ref);
      return [...out].map((subject_ref) => ({ subject_ref }));
    }
    if (/set nurture_step=\$2 where email=\$1/.test(t)) { const r = rows.get(params[0]); if (r && r.nurture_step < params[1]) r.nurture_step = params[1]; return []; }
    if (/^delete from zevanory_leads where (subject_ref|email_hash)=\$1/i.test(t)) {
      const col = t.match(/where (subject_ref|email_hash)=/)[1];
      const out = [];
      for (const [k, r] of rows) if (r[col] === params[0]) { out.push({ email: r.email, subject_ref: r.subject_ref, consent_version: r.consent_version }); rows.delete(k); }
      return out;
    }
    if (/^delete from zevanory_leads where email in/i.test(t)) {
      const [grace, inactive, limit, done, endGrace] = params;
      const due = [...rows.values()].filter((r) => (r.status === "pending" && r.token_expires_at < Date.now() - grace * DAY) || r.status === "unsubscribed" ||
        (r.status === "confirmed" && r.nurture_step >= done && Date.parse(r.nurture_at) < Date.now() - endGrace * DAY) ||
        (r.status === "confirmed" && Date.parse(r.nurture_at || r.confirmed_at || r.consent_at) < Date.now() - inactive * DAY)).slice(0, limit);
      for (const r of due) rows.delete(r.email);
      return due.map((r) => ({ email: r.email, subject_ref: r.subject_ref, consent_version: r.consent_version, status: r.status, nurture_step: r.nurture_step }));
    }
    if (/^delete from zevanory_lead_events where at </i.test(t)) { for (let i = events.length - 1; i >= 0; i--) if (events[i].at < Date.now() - params[0] * DAY) events.splice(i, 1); return []; }
    throw new Error("unexpected sql: " + t.slice(0, 60));
  };
  const hooks = {};
  return { rows, events, queries, hooks, factory: () => ({ query }) };
}
export const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; };
export function mailbox() { const sent = []; globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }; return sent; }
