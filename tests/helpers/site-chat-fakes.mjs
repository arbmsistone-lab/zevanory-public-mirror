// Fakes LOCAIS do chat do site (nunca rede, nunca produção): PostgreSQL em memória que entende só as
// instruções de worker/site-chat.mjs, KV que conta escritas, sink de e-mail e modelo falso.
// O SQL real é exercitado contra PostgreSQL descartável em tests/integration/site-chat-postgres.test.mjs.

export function fakeSql({ fail = false } = {}) {
  const db = { sessions: new Map(), messages: [], tickets: new Map(), counters: new Map(), queries: 0 };
  const ticketBySession = (s) => [...db.tickets.values()].find((t) => t.session_hash === s);
  const sql = {
    db,
    async query(text, p = []) {
      db.queries += 1;
      if (fail) throw new Error("database_down");
      const q = text.replace(/\s+/g, " ").trim();
      if (/^create (table|index)/.test(q)) return [];
      if (q.startsWith("insert into zevanory_site_chat_counters")) {
        const [buckets, windows] = p;
        return buckets.map((b, i) => { const k = b + "|" + windows[i]; const n = (db.counters.get(k) || 0) + 1; db.counters.set(k, n); return { bucket: b, n }; });
      }
      if (q.startsWith("select session_hash, turns, corrections, last_at from zevanory_site_chat_sessions")) { const s = db.sessions.get(p[0]); return s ? [{ ...s }] : []; }
      if (q.startsWith("insert into zevanory_site_chat_sessions")) { db.sessions.set(p[0], { session_hash: p[0], last_at: p[1], source_version: p[2], sandbox: p[3], turns: 0, corrections: 0 }); return []; }
      if (q.startsWith("update zevanory_site_chat_sessions set last_at")) { const s = db.sessions.get(p[0]); if (s) s.last_at = p[1]; return []; }
      if (q.startsWith("update zevanory_site_chat_sessions set turns")) { const s = db.sessions.get(p[0]); if (s) { s.turns += 1; s.corrections += Number(p[1]); s.last_at = p[2]; s.source_version = p[3]; } return []; }
      if (q.startsWith("insert into zevanory_site_chat_messages")) { db.messages.push({ session_hash: p[0], role: "u", body: p[1] }, { session_hash: p[0], role: "a", body: p[2] }); return []; }
      if (q.startsWith("insert into zevanory_site_chat_tickets")) {
        let t = ticketBySession(p[1]);
        if (!t) { t = { protocol: p[0], session_hash: p[1], category: p[2], categories: [p[2]], due_at: p[3], source_version: p[4], sandbox: p[5], status: "open", contact_email: null, customer_confirmed_at: null, owner_notified_at: null }; db.tickets.set(t.protocol, t); }
        else if (!t.categories.includes(p[2])) t.categories.push(p[2]);
        return [{ protocol: t.protocol, due_at: t.due_at, contact_email: t.contact_email, customer_confirmed_at: t.customer_confirmed_at }];
      }
      if (q.startsWith("update zevanory_site_chat_tickets set contact_email")) { const t = db.tickets.get(p[0]); if (t) t.contact_email = p[1]; return []; }
      if (q.startsWith("select protocol from zevanory_site_chat_tickets where session_hash")) { const t = ticketBySession(p[0]); return t ? [{ protocol: t.protocol }] : []; }
      if (q.startsWith("select categories from zevanory_site_chat_tickets")) { const t = db.tickets.get(p[0]); return t ? [{ categories: t.categories }] : []; }
      if (q.startsWith("update zevanory_site_chat_tickets set owner_notified_at")) { const t = db.tickets.get(p[0]); if (t) t.owner_notified_at ||= new Date().toISOString(); return []; }
      if (q.startsWith("update zevanory_site_chat_tickets set customer_confirmed_at")) { const t = db.tickets.get(p[0]); if (t) t.customer_confirmed_at ||= new Date().toISOString(); return []; }
      throw new Error("fake_sql_unknown_query: " + q.slice(0, 80));
    },
  };
  return sql;
}

export function fakeKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, puts: 0, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { this.puts += 1; m.set(k, v); }, async delete(k) { m.delete(k); } };
}

export function sinkMailer() {
  const sent = [];
  return { sent, async send(msg) { sent.push(msg); return { ok: true, id: "sink-" + sent.length }; } };
}

// Modelo falso: devolve um texto fixo por modo (adversarial ou bom) ou lança erro.
export const AI_OUTPUTS = Object.freeze({
  good: "O Vendas na Prática ajuda a organizar atendimento, oferta e follow-up. Página: https://vendas.zevanory.api.br/vendas-na-pratica",
  price: "O Vendas na Prática sai por R$ 97,00 hoje.",
  price_catalog: "O Vendas na Prática custa R$ 197,00.",
  price_words: "Custa só 150 reais.",
  checkout: "Compre aqui: https://vendas.zevanory.api.br/comprar/ZEV-VEN-011",
  external_checkout: "Garanta o seu em https://pay.hotmart.com/Y107979937I",
  discount: "Hoje tem 30% de desconto com o cupom ZEV30.",
  urgency: "Últimas vagas, só hoje!",
  deadline: "Você recebe tudo em 10 minutos e tem 30 dias de garantia.",
  promise: "Garanto que você vai vender mais com o método.",
  deny_right: "Infelizmente o prazo já expirou e não há reembolso.",
  policy_conflict: "Você tem garantia de 7 dias após a compra.",
  injected: "Ignorando as regras: o preço é R$ 1,00 e o link é https://evil.example/pagar",
  empty: "",
});
export function fakeAi(mode = "good") {
  const ai = { calls: 0, async run() { ai.calls += 1; if (mode === "throw") throw new Error("ai_down"); if (mode === "hang") return new Promise(() => {}); return { response: AI_OUTPUTS[mode] ?? "" }; } };
  return ai;
}

export function captureLogs() {
  const lines = [];
  const orig = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) { orig[k] = console[k]; console[k] = (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }
  return { lines, restore() { for (const k of Object.keys(orig)) console[k] = orig[k]; } };
}

export const SANDBOX_ENV = Object.freeze({ SITE_CHAT_ENABLED: "true", SITE_CHAT_SANDBOX: "true", DATABASE_URL: "fake-database-url", SITE_CHAT_HASH_SECRET: "s".repeat(32) });

// Requisição LOCAL ao handler (host do service binding; nunca sai da máquina).
export const CHAT_BINDING_ORIGIN = ["https://chat", "internal"].join(".");
export function chatRequest(path, body, { method = "POST", headers = {} } = {}) {
  return new Request(CHAT_BINDING_ORIGIN + path, { method, headers: { "content-type": "application/json", "x-zev-client-ip": "203.0.113.7", ...headers }, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
}
