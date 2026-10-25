// ZEVANORY | Fase B0 (Roteiro Mestre v4.7, seções 5, 6.4, 8, 9.1, 11): lógica pura do coletor de linha de base
// e do monitor externo P18. Sem rede, sem segredos, sem dados pessoais. Tudo aqui é determinístico e testado
// em tests/b0-baseline.test.mjs.
//
// Regras de honestidade (fail-closed):
//  - Valor que não pôde ser lido de uma fonte somente leitura vira {"value":"NOT_AVAILABLE","reason":...};
//    nunca um número estimado, zero inventado ou "ok" presumido.
//  - Um dia só é COMPLETO para um processo se TODOS os campos daquele processo foram medidos e passam no
//    validador de forma. NOT_AVAILABLE nunca conta como dia completo.
//  - Completo != aprovado: um backup que falhou, medido, é um dia completo com resultado ruim.
//  - Histórico malformado no ramo de evidência derruba o job (HISTORY_MALFORMED); nunca é "consertado".
//  - Os rótulos de evidência da seção 6.4 (SINTETICA, ENSAIO_EM_PRODUCAO, OPERACIONAL) são contados em
//    separado e nunca somados. O CI só gera SINTETICA e nunca escreve no ramo de evidência.
//  - Estados por processo: NAO_INICIADA -> MEDICAO_ATIVA -> B0_VALIDA -> APTO_A_CERTIFICACAO, calculados
//    fail-closed. Nada vira B0_VALIDA com meta PROPOSED ou fonte MISSING. APTO exige prova operacional, que
//    este coletor NÃO mede: portanto nunca é atingido por ele.

export const NA = "NOT_AVAILABLE";
export const SCHEMA_DAY = "zevanory.b0.baseline.v1";
export const SCHEMA_PROBE = "zevanory.p18.probe.v1";
export const SCHEMA_RUN = "zevanory.p18.run.v1";
export const SCHEMA_INCIDENT = "zevanory.p18.incident.v1";
export const SCHEMA_HEARTBEAT = "zevanory.p18.heartbeat.v1";
export const SCHEMA_CF_DISPATCH = "zevanory.p18.cf-dispatch.v1";
export const SCHEMA_REGISTER = "zevanory.b0.register.v1";
export const SCHEMA_TARGETS = "zevanory.b0.metas.v1";
export const SCHEMA_A11Y = "zevanory.b0.p03-a11y.v1";
export const LABELS = Object.freeze(["SINTETICA", "ENSAIO_EM_PRODUCAO", "OPERACIONAL"]);
export const STATES = Object.freeze(["NAO_INICIADA", "MEDICAO_ATIVA", "B0_VALIDA", "APTO_A_CERTIFICACAO"]);
export const B0_DAYS = 14;
export const OP_DAYS = 14;
export const OP_EXECUTIONS = 30;
export const PROBE_CADENCE_MIN = 5;          // cron '2-59/5 * * * *' (Sol 246.09: era 10 min)
export const CRON_OFFSET_MIN = 2;            // minuto do primeiro slot da hora (foge do pico do minuto 0)
// Confirmação dentro da MESMA execução (Sol 246.09): 2 sondagens seguidas com falha, a segunda >= 60 s depois
// da primeira. Cada sondagem já tem uma nova tentativa por alvo após 3 s; a proteção contra falso positivo é
// mantida (duas observações independentes separadas por >= 60 s), sem esperar o próximo cron.
export const CONFIRM_DELAY_MS = 60000;
export const MIN_CONFIRM_SPACING_S = 60;
export const S9_ALERT_LIMIT_S = 600;         // seção 9, N2: "monitor externo alerta em até 10 min"
// Pior caso, em segundos, entre o início da 1ª sondagem que vê a queda e a issue criada: sondagem (20 s de
// timeout + 3 s + 20 s) + espera de confirmação (60 s) + 2ª sondagem (43 s) + API de issues (2 x 15 s).
export const PROBE_WORST_S = 43;
export const ALERT_API_WORST_S = 30;
export const CONFIRM_BUDGET_S = PROBE_WORST_S + CONFIRM_DELAY_MS / 1000 + PROBE_WORST_S + ALERT_API_WORST_S;  // 176
export const HEARTBEAT_STALE_MIN = 15;       // vigia: última execução bem-sucedida do monitor mais velha que isso = alerta
// Gatilho externo (AVAL Sol 253/254): o cron do Worker de controle pede workflow_dispatch a cada 5 min com um id de
// janela p18w-AAAAMMDDTHHMMZ (início da janela de 5 min, alinhada ao minuto 0). O agendador do GitHub continua como
// caminho extra de melhor esforço e cai na MESMA janela (slot :02 pertence à janela :00). Uma janela já sondada não
// é sondada de novo (idempotência); o id pedido só vale dentro de [início - 60 min, início + 2 min].
export const DISPATCH_WINDOW_MIN = 5;
export const DISPATCH_MAX_AGE_S = 3600;
export const DISPATCH_MAX_FUTURE_S = 120;
export const DISPATCH_SOURCES = Object.freeze(["cloudflare-cron", "manual"]);
export const CF_DISPATCH_STALE_MIN = 15;     // vigia: última execução pedida pela Cloudflare que INICIOU mais velha que isso
export const MIN_PROBE_COVERAGE = 0.8;      // dia de P18/P22 só é completo com >= 80% das sondagens esperadas
export const P22_TTL_MIN = 65;              // seção 5, P22: TTL de 65 min
export const P20_MAX_AGE_H = 26;            // seção 9.1: 24 h + 2 h de tolerância
export const P19_END_OF_DAY_UTC_HOUR = 20;  // leitura de cota só vale como "dia" se tirada a partir das 20:00 UTC
export const ALLOWED_HOSTS = Object.freeze(["zevanory.api.br", "vendas.zevanory.api.br"]);
export const UA = "Mozilla/5.0 (compatible; ZEVANORY-Monitor/1.0; B0 baseline; +https://github.com/arbmsistone-lab/zevanory-public-mirror)";

// Páginas de venda sondadas pelo P18 e auditadas pelo pa11y no P03. Nunca /comprar (seção 1: vendas fechadas,
// nenhuma chamada de checkout ou pagamento) e nunca POST.
export const SALES_PAGES = Object.freeze([
  "https://vendas.zevanory.api.br/",
  "https://vendas.zevanory.api.br/solucoes",
  "https://vendas.zevanory.api.br/ia-na-pratica",
  "https://vendas.zevanory.api.br/vendas-na-pratica",
  "https://vendas.zevanory.api.br/lucro-e-caixa",
  "https://vendas.zevanory.api.br/combo-ia-vendas",
  "https://vendas.zevanory.api.br/negocio-completo",
]);
export const STATUS_URL = "https://zevanory.api.br/api/status";
export const SITEMAPS = Object.freeze(["https://zevanory.api.br/sitemap.xml", "https://vendas.zevanory.api.br/sitemap.xml"]);
export const FORBIDDEN_PATH = /\/(comprar|checkout|api\/checkout|assinar|hotmart)(\/|$)/i;

export const S9_VERDICTS = Object.freeze(["MET", "NOT_MET", "NOT_PROVEN"]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v) && v >= 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
export const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
export const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export const dayOf = (iso) => new Date(iso).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------
// Validadores de forma por campo (usados ao gravar E ao reler o histórico).
const FIELD_VALIDATORS = {
  public_pages_http: (v) => isObj(v) && isInt(v.checked) && v.checked > 0 && isInt(v.ok) && isInt(v.non_ok) && v.ok + v.non_ok === v.checked
    && Array.isArray(v.failures) && v.failures.length === v.non_ok && v.failures.every((f) => isObj(f) && typeof f.path === "string" && !f.path.includes("?") && isInt(f.status))
    && Array.isArray(v.sitemaps) && v.sitemaps.length === SITEMAPS.length,
  a11y_wcag2aa: (v) => isObj(v) && typeof v.tool === "string" && Array.isArray(v.pages) && v.pages.length === SALES_PAGES.length
    && v.pages.every((p) => isObj(p) && typeof p.path === "string" && isInt(p.errors)) && isInt(v.total_errors)
    && v.total_errors === v.pages.reduce((s, p) => s + p.errors, 0),
  publication_duplicate_audit: (v) => isObj(v) && isInt(v.duplicates) && isInt(v.audited),
  lead_consent_counts: (v) => isObj(v) && isInt(v.opt_in) && isInt(v.double_confirmed) && isInt(v.unsubscribed) && isInt(v.deletions_honored),
  funnel_visits: (v) => isObj(v) && isInt(v.visitors7_clean) && isInt(v.visitors7_raw) && v.visitors7_clean <= v.visitors7_raw && isIso(v.snapshot_at),
  funnel_origin: (v) => isObj(v) && isObj(v.sources) && Object.values(v.sources).every((s) => isObj(s) && isInt(s.views) && isInt(s.intents)),
  funnel_interest: (v) => isObj(v) && isInt(v.intents_total) && isInt(v.checkouts7) && isInt(v.leads7),
  sales_availability: (v) => isObj(v) && isInt(v.probes) && isInt(v.expected) && isInt(v.up) && isInt(v.down) && v.up + v.down === v.probes
    && isNum(v.coverage) && v.coverage >= MIN_PROBE_COVERAGE && isNum(v.availability) && v.availability >= 0 && v.availability <= 1 && isNum(v.max_gap_min),
  alert_latency: (v) => isObj(v) && S9_VERDICTS.includes(v.s9_10min) && Array.isArray(v.s9_reasons) && v.s9_reasons.every((r) => typeof r === "string")
    && isInt(v.incidents) && isInt(v.alerts_emitted) && isInt(v.alerts_missing) && v.alerts_emitted + v.alerts_missing === v.incidents
    && ["max_alert_latency_s", "p95_alert_latency_s", "max_upper_bound_latency_s", "max_start_delay_s", "p95_start_delay_s", "max_run_gap_s", "p95_run_gap_s"].every((k) => v[k] === null || isNum(v[k]))
    && isInt(v.runs) && isInt(v.scheduled_runs)
    && ["dispatched_runs", "duplicate_runs"].every((k) => v[k] === undefined || isInt(v[k]))
    && ["max_dispatch_to_start_s", "p95_dispatch_to_start_s"].every((k) => v[k] === undefined || v[k] === null || isNum(v[k]))
    && isNum(v.max_check_gap_s) && isNum(v.capability_bound_s) && v.capability_bound_s === v.max_check_gap_s + CONFIRM_BUDGET_S
    // MET é afirmação forte: só sem motivo pendente, sem alerta faltando, com a pior lacuna + confirmação <= 10 min
    // e com todo incidente dentro do limite. Histórico com MET inconsistente derruba (HISTORY_MALFORMED).
    && (v.s9_10min !== "MET" || (v.s9_reasons.length === 0 && v.alerts_missing === 0 && v.capability_bound_s <= S9_ALERT_LIMIT_S
      && (v.max_upper_bound_latency_s === null || v.max_upper_bound_latency_s <= S9_ALERT_LIMIT_S)))
    && (v.s9_10min === "MET" || v.s9_reasons.length > 0),
  kv_quota: (v) => isObj(v) && v.verified === true && isDay(v.day) && isInt(v.writes) && isInt(v.reads) && isInt(v.limit) && v.limit > 0 && isNum(v.pct) && isIso(v.snapshot_at),
  backup_restore_sample: (v) => isObj(v) && isIso(v.run_created_at) && ["success", "failure", "cancelled", "timed_out"].includes(v.run_conclusion)
    && typeof v.ok === "boolean" && isInt(v.neon_tables) && isInt(v.neon_restored_ok) && typeof v.kv_sample_ok === "boolean" && isInt(v.failures) && isNum(v.age_hours_at_collection),
  financial_proof_freshness: (v) => isObj(v) && isInt(v.readings) && isInt(v.expected) && isInt(v.valid) && isInt(v.invalid) && isInt(v.unreadable)
    && v.valid + v.invalid + v.unreadable === v.readings && isNum(v.coverage) && v.coverage >= MIN_PROBE_COVERAGE && isInt(v.fail_safe_violations)
    && isObj(v.invalidation_reasons),
};

// ---------------------------------------------------------------------------------------------------------
// Definição por processo. "fields" = o que entra no dia (todos obrigatórios para dia completo).
// "sources" = fontes que a seção 5 exige; MISSING bloqueia B0_VALIDA mesmo com 14 dias completos.
// "scope.not_proven" = o que fica explicitamente fora do escopo medido (auditoria Sol 239).
export const PROCESSES = Object.freeze({
  P03: {
    name: "Páginas", risk: "R3", label: "OPERACIONAL", frequency: "frequente",
    fields: ["public_pages_http", "a11y_wcag2aa"],
    scope: { measured: ["status HTTP de todas as URLs dos sitemaps públicos", "erros pa11y WCAG2AA (HTML_CodeSniffer) nas páginas de venda"],
      not_proven: ["impressões e cliques por página (Search Console)", "WCAG 2.2 completo (o pa11y/htmlcs não cobre todos os critérios 2.2)", "alvo de toque >= 44 px em produção"] },
    sources: [
      { id: "public_http_probe", status: "PRESENT", note: "GET somente leitura dos sitemaps e das URLs listadas, fora da Cloudflare (runner do GitHub)" },
      { id: "pa11y_live", status: "PRESENT", note: "pa11y@9.0.1 WCAG2AA nas páginas de venda ao vivo" },
      { id: "search_console", status: "MISSING", note: "seção 5.1: Search Console ainda depende do TXT" },
    ],
  },
  P06: {
    name: "Publicação multicanal", risk: "R3", label: "OPERACIONAL", frequency: "frequente",
    fields: ["publication_duplicate_audit"],
    scope: { measured: ["auditoria diária de duplicatas do registro de publicações"], not_proven: ["WhatsApp (canal aposentado, excluído do escopo)"] },
    sources: [{ id: "publication_registry_readonly", status: "MISSING", note: "o registro de publicações vive no KV/Neon; não há leitura somente leitura sem credencial; o resumo do command-center só traz contagens por canal, não a auditoria de duplicatas" }],
  },
  P08: {
    name: "Lead", risk: "R2", label: "OPERACIONAL", frequency: "frequente",
    fields: ["lead_consent_counts"],
    scope: { measured: ["contagens de consentimento (opt-in, dupla confirmação, descadastro, exclusão)"], not_proven: [] },
    sources: [{ id: "lead_consent_readonly", status: "MISSING", note: "consentimentos só existem no Neon; não há endpoint público agregado nem credencial somente leitura no CI" }],
  },
  P15: {
    name: "Medição", risk: "R3", label: "OPERACIONAL", frequency: "frequente",
    fields: ["funnel_visits", "funnel_origin", "funnel_interest"],
    scope: { measured: ["visitas filtradas (7 dias, sem robôs/datacenter)", "origem (views e intenções por fonte)", "interesse (intenções, checkouts iniciados, leads em 7 dias)"],
      not_proven: ["conversão: NOT_PROVEN enquanto as vendas estiverem fechadas", "nível 'potencialmente qualificada' separado (funil v2, #893, não publicado)"] },
    sources: [
      { id: "command_center_annotation", status: "PRESENT", note: "anotação COMMAND_CENTER do command-center-snapshot (gh-pages, agendado), lida pela API REST" },
      { id: "funnel_diag_annotation", status: "PRESENT", note: "anotação FUNNEL_DIAG do mesmo run" },
    ],
  },
  P18: {
    name: "Monitoramento", risk: "R1", label: "OPERACIONAL", frequency: "frequente",
    fields: ["sales_availability", "alert_latency"],
    scope: { measured: ["disponibilidade das páginas de venda e de /api/status medida de fora da Cloudflare",
      "por incidente: última sondagem boa, 1ª falha observada, confirmação, emissão do alerta, recuperação e latências (seção 9 auditada, não presumida)",
      "por execução: atraso do início sobre o slot do cron e intervalo desde a execução anterior",
      "veredito diário da seção 9 (MET / NOT_MET / NOT_PROVEN); lacuna entre sondagens + orçamento de confirmação > 10 min = NOT_PROVEN"],
      not_proven: ["instante real da queda: só é limitado ao intervalo (última sondagem boa, 1ª falha observada]",
        "segundo gatilho independente do agendador do GitHub (seção 11): o vigia p18-monitor-watchdog roda no mesmo agendador; o gatilho na Cloudflare (workflow_dispatch por janela + leitura do batimento) está no código, mas só conta após token, deploy e ensaios do proprietário"] },
    sources: [
      { id: "p18_external_probe", status: "PRESENT", note: "workflow p18-external-monitor, cron 2-59/5, com re-sondagem de confirmação na mesma execução" },
      { id: "p18_monitor_watchdog", status: "PRESENT", note: "workflow p18-monitor-watchdog: batimento do monitor > 15 min = alerta por canal distinto (issue própria + falha do workflow)" },
      { id: "independent_secondary_trigger", status: "MISSING", note: "seção 11: gatilho fora do GitHub (cron existente do Worker de controle: workflow_dispatch por janela + leitura do batimento) depende de token, deploy e ensaios do proprietário" },
    ],
  },
  P19: {
    name: "Capacidade", risk: "R3", label: "OPERACIONAL", frequency: "frequente",
    fields: ["kv_quota"],
    scope: { measured: ["KV: gravações e leituras do dia (conta), leitura do fim do dia"], not_proven: ["Neon CU-h", "Workers requisições/dia", "Workers CPU p99", "D1 linhas", "Resend"] },
    sources: [
      { id: "kv_quota_annotation", status: "PRESENT", note: "kvQuota da anotação COMMAND_CENTER (verified=true)" },
      { id: "neon_compute_readonly", status: "MISSING", note: "exige credencial do Neon" },
      { id: "workers_requests_cpu_readonly", status: "MISSING", note: "seção 11: não medido; exige token Cloudflare" },
    ],
  },
  P20: {
    name: "Continuidade", risk: "R1", label: "ENSAIO_EM_PRODUCAO", frequency: "raro",
    fields: ["backup_restore_sample"],
    scope: { measured: ["resultado e idade do backup diário com restauração por amostra (data-backup.yml)"],
      not_proven: ["ensaio mensal de restauração COMPLETA (seção 9.1)", "diário de eventos no D1", "ensaio trimestral N2/N3", "RPO/RTO medidos"] },
    sources: [
      { id: "data_backup_annotation", status: "PRESENT", note: "anotação DATA_BACKUP do run agendado/manual em gh-pages" },
      { id: "monthly_full_restore_drill", status: "MISSING", note: "seção 9.1 exige ensaio mensal real de restauração completa; contagem de backups bem-sucedidos não substitui" },
    ],
  },
  P22: {
    name: "Prova financeira", risk: "R1", label: "OPERACIONAL", frequency: "frequente",
    fields: ["financial_proof_freshness"],
    scope: { measured: ["validade da prova (estado PROVEN e idade <= 65 min) em cada leitura do /api/status", "invalidações registradas", "fail-safe: prova inválida nunca com venda liberada"],
      not_proven: ["ciclo financeiro completo (pagamento, conciliação, entrega): NOT_PROVEN, vendas fechadas"] },
    sources: [{ id: "public_api_status", status: "PRESENT", note: "GET público /api/status em cada sondagem do P18" }],
  },
});
export const PROCESS_IDS = Object.freeze(Object.keys(PROCESSES));

export const measured = (source, value) => ({ value, source });
export const na = (source, reason) => ({ value: NA, source, reason: String(reason || "unknown").slice(0, 160) });
export function fieldOk(name, f) {
  const v = FIELD_VALIDATORS[name];
  if (!v || !isObj(f) || f.value === NA || typeof f.source !== "string") return false;
  try { return v(f.value) === true; } catch { return false; }
}

// Um processo num dia: completo sse todos os campos medidos e válidos. Campo inválido vira NOT_AVAILABLE.
export function processEntry(pid, fields) {
  const def = PROCESSES[pid];
  if (!def) throw new Error("UNKNOWN_PROCESS " + pid);
  const out = {}, reasons = [];
  for (const name of def.fields) {
    const f = fields?.[name];
    if (fieldOk(name, f)) { out[name] = f; continue; }
    const why = isObj(f) && f.value === NA ? f.reason : f === undefined ? "field_absent" : "malformed_value";
    out[name] = na(isObj(f) && typeof f.source === "string" ? f.source : "unknown", why);
    reasons.push(name + ":" + out[name].reason);
  }
  return { label: def.label, fields: out, complete: reasons.length === 0, incomplete_reasons: reasons };
}

export function buildDailyRecord({ day, collectedAt, runId, sha, fieldsByProcess }) {
  if (!isDay(day) || !isIso(collectedAt)) throw new Error("BAD_RECORD_HEADER");
  const processes = {};
  for (const pid of PROCESS_IDS) processes[pid] = processEntry(pid, fieldsByProcess?.[pid] || {});
  return { schema: SCHEMA_DAY, day, collected_at: collectedAt, run_id: String(runId || ""), collector_sha: String(sha || ""), processes };
}

// Releitura estrita do histórico. Recalcula "complete" a partir dos campos (o valor gravado não é confiável).
export function validateDailyRecord(r) {
  if (!isObj(r) || r.schema !== SCHEMA_DAY || !isDay(r.day) || !isIso(r.collected_at) || !isObj(r.processes)) throw new Error("bad_header");
  for (const pid of Object.keys(r.processes)) {
    const def = PROCESSES[pid], e = r.processes[pid];
    if (!def) throw new Error("unknown_process " + pid);
    if (!isObj(e) || e.label !== def.label || !isObj(e.fields)) throw new Error("bad_process " + pid);
    for (const name of Object.keys(e.fields)) if (!def.fields.includes(name)) throw new Error("unknown_field " + pid + "." + name);
    const recomputed = def.fields.every((n) => fieldOk(n, e.fields[n]));
    if (e.complete === true && !recomputed) throw new Error("complete_flag_mismatch " + pid);
    e.complete = recomputed;
  }
  return r;
}

export const PROBE_KINDS = Object.freeze(["scheduled", "confirm"]);
export function validateProbe(p) {
  if (!isObj(p) || p.schema !== SCHEMA_PROBE || !isIso(p.at) || typeof p.up !== "boolean" || !Array.isArray(p.targets) || p.targets.length === 0) throw new Error("bad_probe");
  for (const t of p.targets) if (!isObj(t) || typeof t.id !== "string" || typeof t.ok !== "boolean" || !isInt(t.status)) throw new Error("bad_probe_target");
  if (p.up !== p.targets.every((t) => t.ok)) throw new Error("probe_up_mismatch");
  if (!isObj(p.p22) || typeof p.p22.readable !== "boolean") throw new Error("bad_probe_p22");
  if (p.kind !== undefined && !PROBE_KINDS.includes(p.kind)) throw new Error("bad_probe_kind");
  return p;
}

export function parseJsonl(text, validate) {
  const out = [];
  String(text || "").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { throw new Error(`HISTORY_MALFORMED line ${i + 1}: invalid_json`); }
    try { out.push(validate(obj)); } catch (e) { throw new Error(`HISTORY_MALFORMED line ${i + 1}: ${e.message}`); }
  });
  return out;
}

// Última coleta de cada dia vence (reexecução do mesmo dia substitui, sem apagar a linha antiga).
export function latestPerDay(records) {
  const m = new Map();
  for (const r of records) { const prev = m.get(r.day); if (!prev || r.collected_at >= prev.collected_at) m.set(r.day, r); }
  return m;
}

// Dias completos consecutivos de um processo, terminando no dia mais recente registrado. Dia ausente quebra.
export function consecutiveCompleteDays(records, pid, label) {
  const byDay = latestPerDay(records);
  const days = [...byDay.keys()].sort();
  if (!days.length) return { consecutive: 0, streak_start: null, last_day: null };
  let d = days[days.length - 1], n = 0, start = null;
  for (;;) {
    const e = byDay.get(d)?.processes?.[pid];
    if (!e || e.label !== label || e.complete !== true) break;
    n += 1; start = d; d = addDays(d, -1);
  }
  return { consecutive: n, streak_start: start, last_day: days[days.length - 1] };
}

export function countsByLabel(records, pid) {
  const byDay = latestPerDay(records), out = {};
  for (const l of LABELS) {
    const days = [...byDay.values()].filter((r) => r.processes?.[pid]?.label === l);
    out[l] = { days_recorded: days.length, complete_days: days.filter((r) => r.processes[pid].complete === true).length, ...consecutiveCompleteDays(records, pid, l) };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Metas (arquivo docs/b0/metas-propostas.json). APPROVED exige aprovador e data; qualquer outra forma derruba.
export function validateTargets(doc) {
  if (!isObj(doc) || doc.schema !== SCHEMA_TARGETS || !isObj(doc.processes)) throw new Error("TARGETS_MALFORMED header");
  for (const pid of PROCESS_IDS) {
    const list = doc.processes[pid];
    if (!Array.isArray(list) || list.length === 0) throw new Error("TARGETS_MALFORMED missing " + pid);
    for (const t of list) {
      if (!isObj(t) || typeof t.id !== "string" || !["PI", "PR", "LB"].includes(t.type) || typeof t.metric !== "string") throw new Error("TARGETS_MALFORMED target " + pid);
      if (t.status === "PROPOSED") { if (t.approved_by != null || t.approved_at != null) throw new Error("TARGETS_MALFORMED proposed_with_approval " + t.id); continue; }
      if (t.status !== "APPROVED" || typeof t.approved_by !== "string" || !t.approved_by.trim() || !isDay(t.approved_at)) throw new Error("TARGETS_MALFORMED approval " + t.id);
    }
  }
  return doc;
}

// Estado de um processo, fail-closed. operational = {days, real_executions} medidos fora deste coletor (ou null).
export function computeState(pid, records, targetsDoc, operational = null) {
  const def = PROCESSES[pid];
  const recs = records.filter((r) => r.processes?.[pid]);
  const days = [...latestPerDay(recs).keys()].sort();
  const start = days[0] || null;
  const counts = countsByLabel(recs, pid);
  const main = counts[def.label];
  const missing = def.sources.filter((s) => s.status !== "PRESENT").map((s) => s.id);
  const targets = targetsDoc?.processes?.[pid] || [];
  const notApproved = targets.filter((t) => t.status !== "APPROVED").map((t) => t.id);
  const reasons = [];
  let state = start ? "MEDICAO_ATIVA" : "NAO_INICIADA";
  if (!start) reasons.push("nenhuma coleta registrada");
  if (missing.length) reasons.push("fontes ausentes: " + missing.join(", "));
  if (!targets.length) reasons.push("metas ausentes");
  if (notApproved.length) reasons.push("metas não aprovadas pelo proprietário: " + notApproved.join(", "));
  if (main.consecutive < B0_DAYS) reasons.push(`dias completos consecutivos ${main.consecutive}/${B0_DAYS}`);
  if (start && !missing.length && targets.length && !notApproved.length && main.consecutive >= B0_DAYS) {
    state = "B0_VALIDA";
    const rare = def.frequency === "raro";
    const op = operational;
    const opOk = !rare && isObj(op) && isInt(op.days) && isInt(op.real_executions) && op.days >= OP_DAYS && op.real_executions >= OP_EXECUTIONS;
    if (opOk) state = "APTO_A_CERTIFICACAO";
    else reasons.push(rare ? "processo raro: exige ensaio em produção mensal e censo (seção 6.4), não medidos aqui" : "prova operacional (14 dias E 30 execuções reais) não medida por este coletor");
  }
  const windowStart = main.consecutive > 0 ? main.streak_start : (main.last_day ? addDays(main.last_day, 1) : null);
  return {
    state, reasons, start_date_utc: start,
    consecutive_complete_days: main.consecutive,
    primeira_janela_de_avaliacao_min: windowStart ? addDays(windowStart, B0_DAYS - 1) : null,
    evidence_by_label: counts,
  };
}

export function buildRegister(records, targetsDoc, nowIso) {
  const processes = {};
  for (const pid of PROCESS_IDS) {
    const def = PROCESSES[pid];
    const st = computeState(pid, records, targetsDoc, null);
    processes[pid] = {
      name: def.name, risk: def.risk, frequency: def.frequency, evidence_label: def.label,
      scope: def.scope, sources: def.sources, fields: def.fields,
      targets: (targetsDoc?.processes?.[pid] || []).map((t) => ({ id: t.id, type: t.type, metric: t.metric, value: t.value ?? null, status: t.status, approved_by: t.approved_by ?? null, approved_at: t.approved_at ?? null })),
      ...st,
    };
  }
  return {
    schema: SCHEMA_REGISTER, generated_at: nowIso,
    note: "primeira_janela_de_avaliacao_min é a data mais cedo em que 14 dias completos podem existir; é janela de avaliação, nunca data de certificação.",
    rules: { b0_days: B0_DAYS, not_available_counts_as_complete: false, labels_never_mixed: true, targets_must_be_approved_by_owner: true },
    processes,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Parsers de fonte (fail-closed: retornam {ok:false, reason} e o chamador grava NOT_AVAILABLE).
const safeJson = (s) => { try { return { ok: true, v: JSON.parse(String(s)) }; } catch { return { ok: false }; } };

export function parseCommandCenter(message, day) {
  const j = safeJson(message);
  if (!j.ok || !isObj(j.v) || !isIso(j.v.at)) return { ok: false, reason: "malformed_source" };
  const c = j.v, out = { ok: true, at: c.at };
  const k = c.kvQuota;
  out.kv = isObj(k) && k.verified === true && k.day === day && isInt(k.writes) && isInt(k.reads) && isInt(k.limit) && isNum(k.pct)
    ? (Date.parse(c.at) >= Date.parse(day + "T" + String(P19_END_OF_DAY_UTC_HOUR).padStart(2, "0") + ":00:00Z")
      ? { ok: true, v: { verified: true, day: k.day, writes: k.writes, reads: k.reads, limit: k.limit, pct: k.pct, zevanory_writes: isInt(k.zevanoryWrites) ? k.zevanoryWrites : null, snapshot_at: c.at } }
      : { ok: false, reason: "snapshot_not_end_of_day" })
    : { ok: false, reason: isObj(k) && k.verified !== true ? "kv_quota_unverified" : "kv_quota_malformed_or_other_day" };
  out.visits = isInt(c.visitors7) && isInt(c.visitors7Raw) && c.visitors7 <= c.visitors7Raw
    ? { ok: true, v: { visitors7_clean: c.visitors7, visitors7_raw: c.visitors7Raw, snapshot_at: c.at } } : { ok: false, reason: "visitors_malformed" };
  return out;
}

export function parseFunnelDiag(message) {
  const j = safeJson(message);
  if (!j.ok || !isObj(j.v) || !isIso(j.v.at)) return { ok: false, reason: "malformed_source" };
  const f = j.v;
  if (!isObj(f.sources) || !isInt(f.leads7) || !isInt(f.checkouts7)) return { ok: false, reason: "funnel_fields_malformed" };
  const sources = {};
  let intents = 0;
  for (const [k, s] of Object.entries(f.sources)) {
    if (!/^[a-z0-9_-]{1,32}$/i.test(k) || !isObj(s) || !isInt(s.views) || !isInt(s.intents)) return { ok: false, reason: "funnel_source_malformed" };
    sources[k] = { views: s.views, intents: s.intents }; intents += s.intents;
  }
  return { ok: true, origin: { sources }, interest: { intents_total: intents, checkouts7: f.checkouts7, leads7: f.leads7 } };
}

export function parseDataBackup(message, run, nowIso) {
  const j = safeJson(message);
  if (!j.ok || !isObj(j.v) || typeof j.v.ok !== "boolean") return { ok: false, reason: "malformed_source" };
  if (!isObj(run) || !isIso(run.created_at) || !["success", "failure", "cancelled", "timed_out"].includes(run.conclusion)) return { ok: false, reason: "run_malformed" };
  const b = j.v, rn = b.restore?.neon, kv = b.restore?.kv;
  if (!isObj(b.neon) || !isInt(b.neon.tables) || !isObj(rn) || !isInt(rn.ok) || !isObj(kv) || typeof kv.sampleOk !== "boolean" || !Array.isArray(b.failures)) return { ok: false, reason: "backup_fields_malformed" };
  return { ok: true, v: {
    run_created_at: run.created_at, run_conclusion: run.conclusion, ok: b.ok && run.conclusion === "success",
    neon_tables: b.neon.tables, neon_restored_ok: rn.ok, kv_sample_ok: kv.sampleOk, failures: b.failures.length,
    age_hours_at_collection: Math.round((Date.parse(nowIso) - Date.parse(run.created_at)) / 36e5 * 10) / 10,
    age_over_26h_at_collection: (Date.parse(nowIso) - Date.parse(run.created_at)) / 36e5 > P20_MAX_AGE_H,
  } };
}

// Leitura P22 de um corpo do /api/status (já parseado). Nunca lê contagens ou ids.
export function readP22(body, nowMs) {
  if (!isObj(body)) return { readable: false, reason: "not_json_object" };
  const p = body.commercial_metrics_provenance;
  if (!isObj(p) || typeof p.state !== "string" || typeof p.commercial_release_allowed !== "boolean") return { readable: false, reason: "provenance_missing" };
  const at = p.measured_at == null ? null : Date.parse(p.measured_at);
  if (p.measured_at != null && Number.isNaN(at)) return { readable: false, reason: "measured_at_malformed" };
  const age = at == null ? null : Math.round((nowMs - at) / 60000);
  const valid = p.state === "PROVEN" && age != null && age >= -5 && age <= P22_TTL_MIN;
  const sales = isObj(body.sales_authorization) && typeof body.sales_authorization.state === "string" ? body.sales_authorization.state : "unknown";
  const salesOpen = p.commercial_release_allowed === true || sales === "open_authorized";
  const inv = body.financial_proof?.last_invalidation;
  return {
    readable: true, state: p.state.slice(0, 40), age_min: age, valid, sales_state: sales.slice(0, 40), release_allowed: p.commercial_release_allowed,
    fail_safe_ok: valid || !salesOpen,
    last_invalidation_reason: isObj(inv) && typeof inv.reason === "string" ? inv.reason.slice(0, 40) : null,
  };
}

export function parseSitemap(xml) {
  const s = String(xml || "");
  if (!/<urlset[\s>]/.test(s)) return { ok: false, reason: "not_a_urlset" };
  const locs = [...s.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  if (!locs.length) return { ok: false, reason: "empty_sitemap" };
  const urls = [];
  for (const u of locs) {
    let url; try { url = new URL(u); } catch { return { ok: false, reason: "bad_url" }; }
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.includes(url.hostname)) return { ok: false, reason: "foreign_url" };
    if (FORBIDDEN_PATH.test(url.pathname)) continue;  // nunca sondar compra/checkout
    url.search = ""; url.hash = "";
    urls.push(url.toString());
  }
  return { ok: true, urls: [...new Set(urls)] };
}

export function summarizeHttp(results, sitemapsRead) {
  const failures = results.filter((r) => !(r.status >= 200 && r.status < 400)).map((r) => ({ path: new URL(r.url).host + new URL(r.url).pathname, status: isInt(r.status) ? r.status : 0 }));
  return { checked: results.length, ok: results.length - failures.length, non_ok: failures.length, failures, sitemaps: sitemapsRead };
}

export function parseA11y(doc) {
  if (!isObj(doc) || doc.schema !== SCHEMA_A11Y || typeof doc.tool !== "string" || !Array.isArray(doc.pages)) return { ok: false, reason: "malformed_source" };
  const pages = [];
  for (const url of SALES_PAGES) {
    const p = doc.pages.find((x) => isObj(x) && x.url === url);
    if (!p) return { ok: false, reason: "page_missing" };
    if (p.evaluated !== true || !isInt(p.errors)) return { ok: false, reason: "page_unevaluated" };
    pages.push({ path: new URL(url).pathname, errors: p.errors });
  }
  return { ok: true, v: { tool: doc.tool, standard: "WCAG2AA", pages, total_errors: pages.reduce((s, p) => s + p.errors, 0) } };
}


// ---------------------------------------------------------------------------------------------------------
// Tempo: utilitários de latência (segundos inteiros) e percentil por posto mais próximo.
const msOf = (iso) => Date.parse(iso);
export const secsBetween = (a, b) => Math.round((msOf(b) - msOf(a)) / 1000);
export function percentile(xs, q) {
  const v = xs.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
}
const byAt = (a, b) => msOf(a.at) - msOf(b.at);

// Maior intervalo entre verificações (sondagens agendadas E de confirmação) no dia UTC. Usa a última sondagem antes
// da meia-noite e a primeira depois do fim do dia quando existem; sem vizinha, a borda do dia conta como verificação
// (conservador para o primeiro dia de histórico).
export function checkGaps(probes, day) {
  const from = Date.parse(day + "T00:00:00Z"), to = from + 86400000;
  const all = [...probes].sort(byAt);
  const inDay = all.filter((p) => { const t = msOf(p.at); return t >= from && t < to; });
  const before = all.filter((p) => msOf(p.at) < from).at(-1);
  const after = all.find((p) => msOf(p.at) >= to);
  const times = [before ? msOf(before.at) : from, ...inDay.map((p) => msOf(p.at)), after ? msOf(after.at) : to];
  let max = 0;
  for (let i = 1; i < times.length; i++) max = Math.max(max, (times[i] - times[i - 1]) / 1000);
  return { in_day: inDay, max_gap_s: Math.round(max) };
}

// Agrega as sondagens do P18 de um dia UTC em disponibilidade (P18) e validade da prova (P22). Cobertura e
// disponibilidade contam só as sondagens agendadas (a re-sondagem de confirmação não infla nem derruba a taxa);
// o maior intervalo conta todas as verificações.
export function aggregateProbes(probes, day) {
  const g = checkGaps(probes, day);
  const ps = g.in_day.filter((p) => p.kind !== "confirm");
  const expected = Math.round(1440 / PROBE_CADENCE_MIN);
  const coverage = Math.round(Math.min(ps.length, expected) / expected * 1000) / 1000;
  const up = ps.filter((p) => p.up).length;
  const p18 = { probes: ps.length, expected, coverage, up, down: ps.length - up, availability: ps.length ? Math.round(up / ps.length * 10000) / 10000 : 0, max_gap_min: Math.round(g.max_gap_s / 6) / 10 };
  const reasons = {};
  let valid = 0, invalid = 0, unreadable = 0, violations = 0;
  for (const p of ps) {
    const r = p.p22;
    if (!r.readable) { unreadable += 1; continue; }
    if (r.valid) valid += 1; else invalid += 1;
    if (r.fail_safe_ok === false) violations += 1;
    if (r.last_invalidation_reason) reasons[r.last_invalidation_reason] = (reasons[r.last_invalidation_reason] || 0) + 1;
  }
  const p22 = { readings: ps.length, expected, coverage, valid, invalid, unreadable, fail_safe_violations: violations, valid_ratio: ps.length ? Math.round(valid / ps.length * 10000) / 10000 : 0, invalidation_reasons: reasons };
  return { p18, p22, enough: coverage >= MIN_PROBE_COVERAGE };
}

// ---------------------------------------------------------------------------------------------------------
// Execuções do monitor: atraso do início sobre o slot do cron e intervalo desde a execução anterior.
// O slot é o último instante do cron '2-59/5' <= início. Atraso >= 5 min fica ambíguo por construção (cai no slot
// seguinte); por isso o intervalo entre execuções (prev_gap_s) é gravado junto e é ele que mostra descartes.
export function schedSlotMs(startedMs) {
  const period = PROBE_CADENCE_MIN * 60000, off = CRON_OFFSET_MIN * 60000;
  return Math.floor((startedMs - off) / period) * period + off;
}
export function buildRunRecord({ runId, event, startedMs, prevRun, dispatch = null }) {
  const sched = event === "schedule";
  const slot = schedSlotMs(startedMs);
  const d = dispatch || resolveDispatch({ startedMs });
  return {
    schema: SCHEMA_RUN, run_id: String(runId || ""), event: String(event || ""), started_at: new Date(startedMs).toISOString(),
    sched_slot_at: sched ? new Date(slot).toISOString() : null, start_delay_s: sched ? Math.round((startedMs - slot) / 1000) : null,
    prev_run_started_at: prevRun ? prevRun.started_at : null, prev_gap_s: prevRun ? Math.round((startedMs - msOf(prevRun.started_at)) / 1000) : null,
    window_id: d.window_id, start_window_id: d.start_window_id, dispatch_source: d.dispatch_source, dispatched_at: d.dispatched_at,
    dispatch_to_start_s: d.dispatch_to_start_s, window_rejected: d.window_rejected,
  };
}
// duplicate_window: execução que INICIOU (prova de que o pedido chegou ao runner) mas não sondou, porque a janela já
// tinha sido sondada. Não conta como execução de monitoramento (atraso, intervalo) nem grava batimento.
export const RUN_OUTCOMES = Object.freeze(["ok", "alert_failed", "duplicate_window"]);
export const PROBING_OUTCOMES = Object.freeze(["ok", "alert_failed"]);
export function validateRun(r) {
  if (!isObj(r) || r.schema !== SCHEMA_RUN || !isIso(r.started_at) || typeof r.event !== "string" || typeof r.run_id !== "string") throw new Error("bad_run");
  for (const k of ["start_delay_s", "prev_gap_s"]) if (r[k] !== null && !isNum(r[k])) throw new Error("bad_run_" + k);
  if (r.event === "schedule" && (!isIso(r.sched_slot_at) || r.start_delay_s !== Math.round((msOf(r.started_at) - msOf(r.sched_slot_at)) / 1000))) throw new Error("run_delay_mismatch");
  if (!RUN_OUTCOMES.includes(r.outcome)) throw new Error("bad_run_outcome");
  // Campos do pedido externo (opcionais em linhas antigas; quando presentes, coerentes entre si).
  if (r.start_window_id !== undefined && r.start_window_id !== windowIdOf(msOf(r.started_at))) throw new Error("run_window_mismatch");
  if (r.window_id !== undefined && r.window_id !== null && parseWindowId(r.window_id) === null) throw new Error("bad_run_window_id");
  if (r.dispatched_at !== undefined && r.dispatched_at !== null) {
    if (!isIso(r.dispatched_at) || r.dispatch_to_start_s !== Math.round((msOf(r.started_at) - msOf(r.dispatched_at)) / 1000)) throw new Error("run_dispatch_mismatch");
  } else if (r.dispatch_to_start_s !== undefined && r.dispatch_to_start_s !== null) throw new Error("run_dispatch_mismatch");
  if (r.dispatch_source !== undefined && r.dispatch_source !== null && !DISPATCH_SOURCES.includes(r.dispatch_source)) throw new Error("bad_run_dispatch_source");
  if (r.outcome === "duplicate_window" && (r.decision !== "skip" || !Array.isArray(r.probes_at) || r.probes_at.length !== 0)) throw new Error("run_duplicate_probed");
  return r;
}

// Janela de 5 min (início alinhado ao minuto 0) e id textual p18w-AAAAMMDDTHHMMZ.
export function windowStartMs(ms) { const p = DISPATCH_WINDOW_MIN * 60000; return Math.floor(ms / p) * p; }
export function windowIdOf(ms) {
  const s = new Date(windowStartMs(ms)).toISOString();  // AAAA-MM-DDTHH:MM:00.000Z
  return "p18w-" + s.slice(0, 4) + s.slice(5, 7) + s.slice(8, 10) + "T" + s.slice(11, 13) + s.slice(14, 16) + "Z";
}
export function parseWindowId(id) {
  const m = typeof id === "string" ? /^p18w-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(id) : null;
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (Number.isNaN(ms) || windowIdOf(ms) !== id || windowStartMs(ms) !== ms) return null;  // data inválida ou fora do alinhamento
  return ms;
}
// Metadados do pedido (inputs do workflow_dispatch). Entrada inválida NUNCA derruba a sondagem: o id pedido é
// descartado (window_rejected) e a execução cai na janela do próprio início. Assim um id forjado não consegue
// suprimir a sondagem de uma janela futura (limite de +2 min) nem reabrir uma antiga além de 60 min.
export function resolveDispatch({ windowId = "", dispatchedAt = "", source = "", startedMs }) {
  const start_window_id = windowIdOf(startedMs);
  const src = DISPATCH_SOURCES.includes(source) ? source : null;
  const out = { window_id: null, start_window_id, dispatch_source: src, dispatched_at: null, dispatch_to_start_s: null, window_rejected: null };
  if (!windowId && !dispatchedAt) return out;
  const w = parseWindowId(windowId);
  if (w === null) return { ...out, window_rejected: "bad_window_id" };
  if (w > startedMs + DISPATCH_MAX_FUTURE_S * 1000) return { ...out, window_rejected: "window_in_future" };
  if (w < startedMs - DISPATCH_MAX_AGE_S * 1000) return { ...out, window_rejected: "window_too_old" };
  out.window_id = windowId;
  if (dispatchedAt) {
    const t = isIso(dispatchedAt) ? msOf(dispatchedAt) : NaN;
    // O pedido sai dentro da própria janela (com folga de 2 min) e nunca depois do início do runner (+ folga de relógio).
    if (Number.isNaN(t) || t < w || t > w + DISPATCH_WINDOW_MIN * 60000 + DISPATCH_MAX_FUTURE_S * 1000 || t > startedMs + DISPATCH_MAX_FUTURE_S * 1000) return { ...out, window_rejected: "bad_dispatched_at" };
    out.dispatched_at = new Date(t).toISOString();
    out.dispatch_to_start_s = Math.round((startedMs - t) / 1000);
  }
  return out;
}
// Janelas já sondadas: o id pedido e a janela do início de toda execução que sondou.
export function coveredWindows(runs) {
  const s = new Set();
  for (const r of runs) {
    if (!PROBING_OUTCOMES.includes(r.outcome)) continue;
    if (r.window_id) s.add(r.window_id);
    s.add(r.start_window_id || windowIdOf(msOf(r.started_at)));
  }
  return s;
}
export function isDuplicateWindow(runs, dispatch) {
  const c = coveredWindows(runs);
  return (dispatch.window_id !== null && c.has(dispatch.window_id)) || c.has(dispatch.start_window_id);
}
// p18/cf-dispatch.json: última execução pedida pela Cloudflare que INICIOU no runner (inclusive duplicada). É o
// batimento do caminho Cloudflare -> GitHub, lido pelo vigia do lado GitHub.
export function buildCfDispatch(run) {
  return { schema: SCHEMA_CF_DISPATCH, run_id: run.run_id, started_at: run.started_at, window_id: run.window_id, dispatched_at: run.dispatched_at,
    dispatch_to_start_s: run.dispatch_to_start_s, duplicate: run.outcome === "duplicate_window" };
}
export function evaluateCfDispatch(doc, nowMs, staleMin = CF_DISPATCH_STALE_MIN) {
  if (doc === null || doc === undefined) return { state: "MISSING", alert: true, age_s: null, started_at: null };
  if (!isObj(doc) || doc.schema !== SCHEMA_CF_DISPATCH || !isIso(doc.started_at)) return { state: "MALFORMED", alert: true, age_s: null, started_at: null };
  const age = Math.round((nowMs - msOf(doc.started_at)) / 1000);
  if (age < -120) return { state: "FUTURE", alert: true, age_s: age, started_at: doc.started_at };
  if (age > staleMin * 60) return { state: "STALE", alert: true, age_s: age, started_at: doc.started_at };
  return { state: "FRESH", alert: false, age_s: age, started_at: doc.started_at };
}

// ---------------------------------------------------------------------------------------------------------
// Incidentes (seção 9 auditada). O instante real da queda não é observável: fica limitado ao intervalo
// (last_ok_observed_at, first_failure_observed_at]. Por isso gravamos:
//   detection_seconds            = confirmed_at - first_failure_observed_at
//   latency_seconds              = alert_emitted_at - first_failure_observed_at   (medido, limite inferior)
//   upper_bound_latency_seconds  = alert_emitted_at - last_ok_observed_at         (limite superior da queda real ao alerta)
// s9: alerta não emitido ou latency > 600 s = NOT_MET (a queda é certamente anterior à 1ª falha observada);
//     sem última sondagem boa conhecida ou limite superior > 600 s = NOT_PROVEN; senão MET.
export function incidentMetrics(inc) {
  const emitted = inc.alert_emitted_at ?? null, lastOk = inc.last_ok_observed_at ?? null;
  const detection = secsBetween(inc.first_failure_observed_at, inc.confirmed_at);
  const latency = emitted ? secsBetween(inc.first_failure_observed_at, emitted) : null;
  const upper = emitted && lastOk ? secsBetween(lastOk, emitted) : null;
  let s9;
  if (latency === null || latency > S9_ALERT_LIMIT_S) s9 = "NOT_MET";
  else if (upper === null || upper > S9_ALERT_LIMIT_S) s9 = "NOT_PROVEN";
  else s9 = "MET";
  return { detection_seconds: detection, latency_seconds: latency, upper_bound_latency_seconds: upper, s9 };
}
export function finalizeIncident(inc, { alertEmittedAt = null, alertIssue = null, alertError = null } = {}) {
  const out = { ...inc, alert_emitted_at: alertEmittedAt, alert_issue: alertIssue, alert_error: alertError ? String(alertError).slice(0, 80) : null };
  return { ...out, ...incidentMetrics(out) };
}
export function withRecovery(inc, atIso) {
  return { ...inc, recovered_at: atIso, outage_observed_seconds: secsBetween(inc.first_failure_observed_at, atIso) };
}
export function validateIncident(x) {
  const isoOrNull = (v) => v === null || isIso(v);
  if (!isObj(x) || x.schema !== SCHEMA_INCIDENT || typeof x.incident_id !== "string" || !isIso(x.first_failure_observed_at) || !isIso(x.confirmed_at)
    || !isoOrNull(x.last_ok_observed_at) || !isoOrNull(x.alert_emitted_at) || !isoOrNull(x.recovered_at ?? null)) throw new Error("bad_incident");
  const t = (k) => (x[k] ? msOf(x[k]) : null);
  if ((t("last_ok_observed_at") !== null && t("last_ok_observed_at") >= t("first_failure_observed_at")) || t("confirmed_at") < t("first_failure_observed_at")
    || (t("alert_emitted_at") !== null && t("alert_emitted_at") < t("confirmed_at")) || (t("recovered_at") !== null && t("recovered_at") < t("confirmed_at"))) throw new Error("incident_time_order");
  const m = incidentMetrics(x);
  for (const k of Object.keys(m)) if (x[k] !== m[k]) throw new Error("incident_metrics_mismatch " + k);
  return x;
}
export function currentIncidents(lines) {
  const m = new Map();
  for (const l of lines) m.set(l.incident_id, l);  // append-only: a última linha de cada incidente vale
  return m;
}
export function openIncident(lines) {
  return [...currentIncidents(lines).values()].filter((i) => !i.recovered_at).at(-1) || null;
}

// Decisão sobre a sequência de sondagens (histórico + desta execução). "pending" = 1ª falha ainda não confirmada:
// o monitor re-sonda na MESMA execução após CONFIRM_DELAY_MS. Confirmação = >= 2 sondagens seguidas com falha, a
// última >= MIN_CONFIRM_SPACING_S depois da primeira (dentro da execução ou entre execuções).
export function decideIncident({ seq, open }) {
  const ps = [...seq].sort(byAt), cur = ps.at(-1);
  if (!cur) throw new Error("no_probe");
  if (cur.up) return open ? { action: "recover", incident: withRecovery(open, cur.at) } : { action: "none" };
  if (open) return { action: open.alert_emitted_at ? "update" : "alert_retry" };
  let k = ps.length - 1;
  while (k >= 0 && !ps[k].up) k -= 1;
  const streak = ps.slice(k + 1), first = streak[0];
  if (streak.length >= 2 && secsBetween(first.at, cur.at) >= MIN_CONFIRM_SPACING_S) {
    return { action: "confirm", incident: {
      schema: SCHEMA_INCIDENT, incident_id: "p18-" + first.at, last_ok_observed_at: k >= 0 ? ps[k].at : null,
      first_failure_observed_at: first.at, confirmed_at: cur.at, confirmed_by: cur.kind === "confirm" ? "in_run_reprobe" : "cross_run",
      down_targets: cur.targets.filter((t) => !t.ok).map((t) => t.id + ":" + t.status), recovered_at: null,
    } };
  }
  return { action: "pending", first_failure_observed_at: first.at };
}

// Campo diário P18 alert_latency: latências dos incidentes confirmados no dia, atraso do agendador e veredito da
// seção 9. NOT_PROVEN quando a maior lacuna entre verificações passa de 10 min, ou quando lacuna + orçamento de
// confirmação (CONFIRM_BUDGET_S) passa de 10 min: uma queda logo após a última sondagem boa não teria alerta a tempo.
export function aggregateLatency({ probes, runs, incidents, day }) {
  const maxGap = checkGaps(probes, day).max_gap_s;
  const allDayRuns = runs.filter((r) => dayOf(r.started_at) === day);
  const dayRuns = allDayRuns.filter((r) => r.outcome !== "duplicate_window");  // duplicadas não sondaram
  const dispatched = allDayRuns.filter((r) => isNum(r.dispatch_to_start_s)), d2s = dispatched.map((r) => r.dispatch_to_start_s);
  const sched = dayRuns.filter((r) => r.event === "schedule" && isNum(r.start_delay_s));
  const incs = [...currentIncidents(incidents).values()].filter((i) => dayOf(i.confirmed_at) === day);
  const emitted = incs.filter((i) => i.alert_emitted_at);
  const lat = emitted.map((i) => i.latency_seconds), ub = emitted.map((i) => i.upper_bound_latency_seconds).filter(isNum);
  const delays = sched.map((r) => r.start_delay_s), gaps = dayRuns.map((r) => r.prev_gap_s).filter(isNum);
  const capability = maxGap + CONFIRM_BUDGET_S;
  const reasons = [];
  let notMet = false;
  if (maxGap > S9_ALERT_LIMIT_S) reasons.push(`check_gap_over_10min max=${maxGap}s`);
  else if (capability > S9_ALERT_LIMIT_S) reasons.push(`gap_plus_confirmation_over_10min ${maxGap}s+${CONFIRM_BUDGET_S}s`);
  for (const i of incs) {
    if (i.s9 === "NOT_MET") { notMet = true; reasons.push(`incident_not_met ${i.incident_id} ${i.alert_emitted_at ? "latency=" + i.latency_seconds + "s" : "alert_not_emitted"}`); }
    else if (i.s9 === "NOT_PROVEN") reasons.push(`incident_not_proven ${i.incident_id} upper_bound=${i.upper_bound_latency_seconds ?? "unknown"}`);
  }
  const max = (xs) => (xs.length ? Math.max(...xs) : null);
  return {
    s9_10min: notMet ? "NOT_MET" : reasons.length ? "NOT_PROVEN" : "MET", s9_reasons: reasons,
    incidents: incs.length, alerts_emitted: emitted.length, alerts_missing: incs.length - emitted.length,
    max_alert_latency_s: max(lat), p95_alert_latency_s: percentile(lat, 0.95), max_upper_bound_latency_s: max(ub),
    runs: dayRuns.length, scheduled_runs: sched.length,
    dispatched_runs: dispatched.length, duplicate_runs: allDayRuns.length - dayRuns.length,
    max_dispatch_to_start_s: max(d2s), p95_dispatch_to_start_s: percentile(d2s, 0.95),
    max_start_delay_s: max(delays), p95_start_delay_s: percentile(delays, 0.95), max_run_gap_s: max(gaps), p95_run_gap_s: percentile(gaps, 0.95),
    max_check_gap_s: maxGap, capability_bound_s: capability,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Batimento do monitor (p18/heartbeat.json no ramo de evidência) e vigia. Só a execução que terminou inteira
// (sondagem, evidência e alerta) grava o batimento; a publicação no ramo é o que o torna visível ao vigia.
export function buildHeartbeat({ nowMs, runId, run, cur, open }) {
  return { schema: SCHEMA_HEARTBEAT, last_success_at: new Date(nowMs).toISOString(), run_id: String(runId || ""), run_started_at: run.started_at,
    last_probe_at: cur.at, up: cur.up, open_incident: open ? open.incident_id : null, stale_after_min: HEARTBEAT_STALE_MIN,
    event: run.event ?? null, window_id: run.window_id ?? null, start_window_id: run.start_window_id ?? null, dispatch_source: run.dispatch_source ?? null,
    dispatched_at: run.dispatched_at ?? null, dispatch_to_start_s: run.dispatch_to_start_s ?? null };
}
export function evaluateHeartbeat(hb, nowMs, staleMin = HEARTBEAT_STALE_MIN) {
  if (hb === null || hb === undefined) return { state: "MISSING", alert: true, age_s: null, last_success_at: null };
  if (!isObj(hb) || hb.schema !== SCHEMA_HEARTBEAT || !isIso(hb.last_success_at)) return { state: "MALFORMED", alert: true, age_s: null, last_success_at: null };
  const age = Math.round((nowMs - msOf(hb.last_success_at)) / 1000);
  if (age < -120) return { state: "FUTURE", alert: true, age_s: age, last_success_at: hb.last_success_at };
  if (age > staleMin * 60) return { state: "STALE", alert: true, age_s: age, last_success_at: hb.last_success_at };
  return { state: "FRESH", alert: false, age_s: age, last_success_at: hb.last_success_at };
}

// ---------------------------------------------------------------------------------------------------------
// Alertas por issue do GitHub. O monitor e o vigia usam títulos distintos (canais separados).
export const ALERT_TITLE = "[P18] Vendas fora do ar — monitor externo";
export const WATCHDOG_TITLE = "[P18-VIGIA] Monitor externo parado — sem batimento";
export const WATCHDOG_CF_TITLE = "[P18-VIGIA] Gatilho Cloudflare parado — nenhuma execução pedida pela Cloudflare iniciou";
export function watchdogCfBody(ev, runUrl) {
  return [`Vigia do P18: a última execução do monitor **pedida pelo cron do Worker de controle (Cloudflare)** que iniciou no runner está ${ev.state === "STALE" ? `há ${Math.round(ev.age_s / 60)} min (limite ${CF_DISPATCH_STALE_MIN} min)` : `indisponível (${ev.state})`}.`,
    "", `Último início pedido pela Cloudflare: ${ev.started_at ?? "nenhum"}`, "",
    "Causas possíveis: Cloudflare fora do ar ou cron do Worker parado, token de dispatch expirado/revogado (401/403), limite da API (429) ou fila do GitHub.",
    "O alerta da Cloudflare (KV + resumo por e-mail) cobre as falhas que o Worker enxerga; este cobre a Cloudflare inteira parada, quando o GitHub roda o vigia.",
    `Execução do vigia: ${runUrl}`, "", "Fecha sozinho quando uma execução pedida pela Cloudflare voltar a iniciar."].join("\n");
}
export function findOpenAlert(issues, title = ALERT_TITLE) {
  return (Array.isArray(issues) ? issues : []).find((i) => isObj(i) && i.title === title && !i.pull_request && i.state !== "closed") || null;
}
export function alertBody(cur, runUrl, inc = null) {
  const down = cur.targets.filter((t) => !t.ok).map((t) => `- \`${t.id}\`: HTTP ${t.status}${t.error ? " (" + t.error + ")" : ""}`);
  const times = inc ? ["", `Última sondagem boa: ${inc.last_ok_observed_at ?? "desconhecida"}`, `1ª falha observada: ${inc.first_failure_observed_at}`, `Confirmada: ${inc.confirmed_at} (${inc.confirmed_by})`] : [];
  return [`Monitor externo P18 (fora da Cloudflare): **2 sondagens seguidas com falha, a 2ª >= ${MIN_CONFIRM_SPACING_S} s depois da 1ª**.`, ...times, "", `Última sondagem: ${cur.at}`, "", ...down, "", `Execução: ${runUrl}`, "",
    "Fecha sozinho quando uma sondagem passar. Somente leitura (GET); nenhuma chamada de checkout ou pagamento. Sem dados pessoais."].join("\n");
}
export function watchdogBody(ev, runUrl) {
  return [`Vigia do P18: a última execução **bem-sucedida** do monitor externo está ${ev.state === "STALE" ? `há ${Math.round(ev.age_s / 60)} min (limite ${HEARTBEAT_STALE_MIN} min)` : `indisponível (${ev.state})`}.`,
    "", `Último batimento: ${ev.last_success_at ?? "nenhum"}`, "",
    "Enquanto isso, a seção 9 (alerta em até 10 min) fica NOT_PROVEN: o monitor pode estar atrasado pelo agendador do GitHub, desativado ou falhando.",
    `Execução do vigia: ${runUrl}`, "", "Fecha sozinho quando o batimento voltar a ficar fresco."].join("\n");
}
