// ZEVANORY | P20 (Roteiro Mestre v4.7, seção 9.1): lógica pura do ensaio MENSAL de restauração completa.
// Sem rede, sem banco, sem segredos. Testado em tests/p20-restore-drill.test.mjs (e por mutantes).
//
// O que o ensaio prova, nesta ordem (fail-closed; qualquer dúvida derruba):
//  1. a cópia mais recente do backup Neon -> KV está íntegra: relatório consolidado ok, as 3 partes do mesmo dia,
//     cada bundle no endereço que a parte declara, o SHA-256 de CADA tabela igual ao do manifesto da parte
//     (fp.tables[t].sha, gravado pelo Worker) e o resumo do manifesto (neon.manifest) recalculado igual;
//  2. a restauração COMPLETA num Postgres efêmero (nunca produção) bate contagem e hash de conteúdo por tabela;
//  3. RPO = instante da falha simulada (início do ensaio) - início mais antigo das partes da cópia;
//     RTO (dados) = início do ensaio -> restauração conferida.
// Rótulos (seção 6.4): ENSAIO_EM_PRODUCAO só quando a cópia REAL de produção foi lida; SINTETICA para fixture;
// sem leitura = null + NOT_AVAILABLE. Nada aqui imprime ou grava dado de linha: só nomes de tabela, contagens,
// booleanos e prefixos de 16 hex do manifesto (iguais aos que o Worker já publica).
// Cifragem (docs/p20/cifragem-backup.md): cada bundle pode ser um envelope AES-256-GCM (formato zevanory-backup-enc/v1)
// ou legado em texto claro. O ensaio lê os dois, decifra com o conjunto de chaves (P20_BACKUP_KEYS), registra
// copia_cifrada por parte e só tira "copia_cifrada" de not_covered quando TODAS as partes do dia estão cifradas.
// Cópia KV -> Neon (seção 9.1, "Trava de vendas, prova financeira, estado comercial"): o Worker grava, junto com o
// backup, as linhas do dia de zevanory_kv_backup RELIDAS DO NEON num envelope próprio (zpc:backup:v1:kv:<dia>) e o
// manifesto da FONTE (KV) no relatório da parte 0 (kv.entries_manifest: SHA-256 do valor + TTL + metadados por chave).
// O ensaio confere essa cópia, restaura as linhas na tabela zevanory_kv_backup do Postgres efêmero, RELÊ do Postgres,
// reconstrói um KV em memória com a mesma semântica do Cloudflare (valor, expiração absoluta, metadados) e confere
// chave a chave contra o manifesto da fonte. Só com essa prova completa "copia_kv_para_neon" sai de not_covered.
// Nenhuma credencial do Neon no CI: a leitura continua sendo só GET em zpc:backup:v1:* no KV.
import { createHash } from "node:crypto";
import { openBundleText } from "./backup-envelope.mjs";

export const SCHEMA_RECORD = "zevanory.p20.restore-drill.v1";
export const SCHEMA_INVENTORY = "zevanory.p20.inventario.v1";
export const REPORT_KEY = "zpc:backup:v1:report";
export const PARTS = 3;
export const partReportKey = (p) => `${REPORT_KEY}:part:${p}`;
export const bundleKeyFor = (day, p) => `zpc:backup:v1:neon:${day}:part:${p}`;
export const VERDICTS = Object.freeze(["APROVADO", "REPROVADO", "NOT_AVAILABLE"]);
export const LABELS = Object.freeze(["SINTETICA", "ENSAIO_EM_PRODUCAO"]);
export const MAX_AGE_H = 26;      // seção 9.1: 24 h + 2 h de tolerância
export const CRITICAL_AGE_H = 48; // seção 9.1: falha crítica de P20
// Partes da seção 9.1 que este ensaio NÃO cobre (escopo honesto; nunca some daqui sem prova nova).
export const NOT_COVERED = Object.freeze([
  "copia_kv_para_neon: restauração completa em CI exige a credencial do Neon (só o Worker a tem); coberta só pelo ensaio diário por amostra do Worker",
  "conciliacao_pedidos_x_provedor: vendas fechadas e nenhuma credencial somente leitura do provedor no Environment do ensaio",
  "diario_d1: reconstrução pelo diário D1 não provada neste ensaio",
  "copia_cifrada: a cópia Neon -> KV fica em texto claro no KV (a seção 9.1 pede cifrada)",
]);
export const COPIA_CIFRADA_ID = "copia_cifrada";
const isCopiaCifrada = (s) => typeof s === "string" && s.startsWith(COPIA_CIFRADA_ID + ":");
export const COPIA_KV_ID = "copia_kv_para_neon";
const isCopiaKv = (s) => typeof s === "string" && s.startsWith(COPIA_KV_ID + ":");
// not_covered do registro: cada lacuna só sai com a SUA prova. "copia_cifrada": todas as PARTS partes lidas,
// decifradas e cifradas. "copia_kv_para_neon": kvCopyProven (prova completa da restauração do KV, ensaio APROVADO).
// "diario_d1": diarioProvado (prova completa do diário, ensaio APROVADO). Sem prova, a linha do diário fica com o motivo
// medido neste ensaio (ex.: token ausente, cadeia quebrada, conjunto divergente). As três lacunas são independentes.
export function notCoveredFor(allPartsEncrypted, kvCopyProven = false, diario = null) {
  const provado = diarioProvado(diario);
  return NOT_COVERED.filter((s) => !(allPartsEncrypted === true && isCopiaCifrada(s)) && !(kvCopyProven === true && isCopiaKv(s)))
    .filter((s) => !(provado && isDiarioD1(s)))
    .map((s) => (isDiarioD1(s) && isObj(diario) && diario.motivo ? `${DIARIO_D1_ID}: ${limpo(diario.motivo)}` : s));
}

// ---------------------------------------------------------------------------------------------------------
// Cópia KV -> Neon. Contrato com worker/data-backup.mjs (implementação independente; testadas juntas).
export const KV_PREFIXES = Object.freeze(["zpc:sales:", "zpc:cp:", "sales:open:v1"]);
export const KV_COPY_TABLE = "zevanory_kv_backup";
export const KV_COPY_FORMAT = "zevanory-kv-copy/v1";
export const kvCopyKeyFor = (day) => `zpc:backup:v1:kv:${day}`;
// Semântica do Cloudflare KV que a restauração respeita: expiração absoluta >= agora + 60 s; metadados JSON <= 1024 B.
export const KV_MIN_TTL_S = 60;
export const KV_METADATA_MAX_BYTES = 1024;
export const kvEntryDigest = ({ sha, expiration, metadata }) => `${sha}|${expiration == null ? "" : String(expiration)}|${metadata == null ? "" : sha256(metadata)}`;
const kvKeyAllowed = (k) => typeof k === "string" && k.length > 0 && k.length <= 512 && KV_PREFIXES.some((p) => k.startsWith(p)) && !k.startsWith("zpc:restore-drill:");
const isExp = (v) => v === null || (Number.isSafeInteger(v) && v > 0);

// Confere UMA linha da cópia (mesmo formato no bundle e na releitura do Postgres). Devolve o motivo ou null.
function kvRowProblem(r, day) {
  if (!isObj(r) || typeof r.key !== "string" || typeof r.value !== "string" || typeof r.sha256 !== "string" || !HEX64.test(r.sha256)) return "row_malformed";
  if (r.snapshot_day !== day) return "row_other_day";
  if (!isExp(r.expiration ?? null) || !(r.metadata == null || typeof r.metadata === "string")) return "row_malformed";
  if (!kvKeyAllowed(r.key)) return "key_outside_prefixes";
  if (sha256(r.value) !== r.sha256) return "value_hash_mismatch";
  return null;
}

// Confere um conjunto de linhas da cópia contra o manifesto da fonte: forma, dia, prefixo, hash do valor por chave,
// chave duplicada, contagem e o manifesto de entradas (valor + TTL + metadados). failures com prefixo dado.
export function checkKvRows(rows, { day, keys, entriesManifest, prefix }) {
  const failures = [];
  if (!Array.isArray(rows)) return { failures: [prefix + "_not_array"], digests: {} };
  const digests = {}, bad = {};
  for (const r of rows) {
    const why = kvRowProblem(r, day);
    if (why) { bad[why] = (bad[why] || 0) + 1; continue; }
    if (r.key in digests) { bad.duplicate_key = (bad.duplicate_key || 0) + 1; continue; }
    digests[r.key] = kvEntryDigest({ sha: r.sha256, expiration: r.expiration ?? null, metadata: r.metadata ?? null });
  }
  for (const [why, n] of Object.entries(bad).sort()) failures.push(`${prefix}_${why}:${n}`);
  if (rows.length !== keys) failures.push(`${prefix}_row_count_mismatch`);
  if (manifestHash(digests) !== entriesManifest) failures.push(`${prefix}_manifest_mismatch`);
  return { failures, digests };
}

// Avalia a cópia do KV lida do KV de produção (envelope próprio + relatório da parte 0). Não restaura nada.
// present=false: o Worker ainda não grava a cópia (versão anterior): a lacuna continua, sem falha.
export function assessKvCopy(readings, { day, keyring = new Map() } = {}) {
  const out = { present: false, failures: [], day, keys: 0, json: null, copia_cifrada: false };
  const p0 = parse(readings?.parts?.[0]);
  const kv = p0.ok && isObj(p0.v) ? p0.v.kv : null;
  if (!isObj(kv) || kv.copy === undefined) return out;
  out.present = true;
  const fail = (w) => out.failures.push(w);
  const c = kv.copy;
  if (!isDay(day) || !isObj(c) || c.format !== KV_COPY_FORMAT || c.bundleKey !== kvCopyKeyFor(day) || !isInt(kv.keys) || kv.keys < 1 || c.rows !== kv.keys
    || typeof c.sha !== "string" || !HEX64.test(c.sha) || typeof kv.entries_manifest !== "string" || !HEX64.test(kv.entries_manifest)) { fail("kv_copy_report_malformed"); return out; }
  out.keys = kv.keys; out.entries_manifest = kv.entries_manifest;
  const raw = readings?.kv_copy;
  if (raw == null) { fail("kv_copy_bundle_missing"); return out; }
  let opened;
  try { opened = openBundleText(raw, { day, part: 0, bundleKey: c.bundleKey }, keyring); }
  catch (e) { fail(`kv_copy_bundle_${String(e?.code || "unreadable").replace(/[^a-z_]/g, "")}`); return out; }
  if (isObj(p0.v.encryption) && p0.v.encryption.state === "cifrado" && !opened.encrypted) { fail("kv_copy_encryption_downgrade"); return out; }
  out.copia_cifrada = opened.encrypted === true;
  if (sha256(opened.text) !== c.sha) { fail("kv_copy_hash_mismatch"); return out; }
  const rows = parse(opened.text);
  if (!rows.ok || !Array.isArray(rows.v)) { fail("kv_copy_malformed"); return out; }
  out.failures.push(...checkKvRows(rows.v, { day, keys: kv.keys, entriesManifest: kv.entries_manifest, prefix: "kv_copy" }).failures);
  if (!out.failures.length) out.json = opened.text;
  return out;
}

// A reconstrução do KV em memória (kvRestoreDrill, planKvRestore, memKvReplay) vive em scripts/p20/kv-memory-replay.mjs:
// é uma estrutura em memória do ensaio, não um escritor de KV, e recebe os prefixos críticos por parâmetro (KV_PREFIXES).

// Prova completa da restauração do KV (o que validateRecord exige para a lacuna sair de not_covered).
export function kvProofComplete(k, backupDay) {
  return isObj(k) && isDay(k.day) && k.day === backupDay && isInt(k.keys) && k.keys >= 1 && isInt(k.restored) && isInt(k.expired_at_restore)
    && k.restored + k.expired_at_restore === k.keys && isInt(k.with_ttl) && isInt(k.with_metadata)
    && k.pg_rows_ok === true && k.values_hash_ok === true && k.ttl_metadata_ok === true && k.entries_manifest_ok === true && typeof k.copia_cifrada === "boolean";
}
export const DIARIO_D1_ID = "diario_d1";
const isDiarioD1 = (s) => typeof s === "string" && s.startsWith(DIARIO_D1_ID + ":");
export const TABELA_RECONSTRUCAO = "p20_diario_reconstruido";
const limpo = (s) => String(s || "").replace(/[^A-Za-z0-9_.:,= -]/g, "").slice(0, 120);
// Leitura do diário que não houve (ausente, sem token, incompleta, com erro): estado "nao_lido" com o motivo. Pura, sem
// o módulo do diário: o ensaio e os testes que não leem o diário não carregam worker/diario-* (cópias mínimas dos
// mutantes B0/P18/P19, checkout esparso). Devolve null quando a leitura foi feita ("lido").
export function diarioNaoLido(leitura, fase) {
  if (isObj(leitura) && leitura.estado === "lido") return null;
  const motivo = !isObj(leitura) ? "leitura_ausente" : leitura.estado === "sem_token" ? "token CF_TOKEN_D1_DIARIO_READ ausente no ensaio"
    : "leitura_" + limpo(leitura.estado).slice(0, 40) + (leitura.motivo ? ":" + limpo(leitura.motivo).slice(0, 60) : "");
  return { fase, tabela: TABELA_RECONSTRUCAO, rpo_critico_medido_s: null, estado: "nao_lido", motivo };
}
// Estados do diário que passam fora da sombra: lista POSITIVA (qualquer outro estado reprova).
export const DIARIO_ESTADOS_APROVADOS = Object.freeze(["provado"]);
// A prova é exigida em qualquer fase que não seja exatamente "sombra" (valor desconhecido = lado estrito).
export const diarioExigido = (d) => !(isObj(d) && d.fase === "sombra");
export const diarioAprovado = (d) => isObj(d) && DIARIO_ESTADOS_APROVADOS.includes(d.estado) && diarioProvado(d);
// Prova estrita do diário (a mesma regra na construção e na releitura do registro).
export function diarioProvado(d) {
  return isObj(d) && d.estado === "provado" && d.motivo === null && d.cadeia_ok === true && d.reconstrucao_ok === true && d.conjunto_igual === true
    && d.faltando === 0 && d.sobrando === 0 && isInt(d.reconstruidos) && isInt(d.head_seq) && isInt(d.linhas) && d.linhas === d.head_seq
    && d.tabela === TABELA_RECONSTRUCAO && isIso(d.lido_em) && isIso(d.corte) && isNum(d.rpo_critico_medido_s) && d.rpo_critico_medido_s >= 0;
}
const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v) && v >= 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const isIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
export const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;

export const sha256 = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");
// Igual a worker/data-backup.mjs manifestHash: sha256 das linhas "tabela=sha" em ordem.
export const manifestHash = (entries) => sha256(Object.keys(entries).sort().map((k) => k + "=" + entries[k]).join("\n"));
const parse = (s) => { if (typeof s !== "string") return { ok: false }; try { return { ok: true, v: JSON.parse(s) }; } catch { return { ok: false }; } };

// ---------------------------------------------------------------------------------------------------------
// Alvo da restauração: SÓ um Postgres local e descartável. Qualquer sinal de banco real recusa (antes de conectar).
export const EPHEMERAL_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);
export function assertEphemeralTarget(env = {}) {
  const host = String(env.PGHOST || "");
  if (!EPHEMERAL_HOSTS.includes(host)) throw new Error("TARGET_NOT_EPHEMERAL host");
  if (env.PGHOSTADDR && !EPHEMERAL_HOSTS.includes(String(env.PGHOSTADDR))) throw new Error("TARGET_NOT_EPHEMERAL hostaddr");
  for (const k of ["DATABASE_URL", "RESTORE_TARGET_DATABASE_URL", "CERTIFICATION_DATABASE_URL", "PGSERVICE", "PGSERVICEFILE"]) {
    if (env[k]) throw new Error("TARGET_NOT_EPHEMERAL " + k);
  }
  if (!/^p20_drill[a-z0-9_]{0,40}$/.test(String(env.PGDATABASE || ""))) throw new Error("TARGET_NOT_EPHEMERAL database");
  return true;
}

// Rótulo da seção 6.4. Produção só conta se a cópia real foi efetivamente lida.
export function decideLabel(mode, sourceRead) {
  if (mode === "sintetica") return "SINTETICA";
  if (mode === "producao" && sourceRead === true) return "ENSAIO_EM_PRODUCAO";
  return null;
}

export function rpoHours(partStartedAts, failureAtIso) {
  if (!Array.isArray(partStartedAts) || partStartedAts.length === 0 || !partStartedAts.every(isIso) || !isIso(failureAtIso)) return null;
  const oldest = Math.min(...partStartedAts.map((t) => Date.parse(t)));
  const h = (Date.parse(failureAtIso) - oldest) / 36e5;
  return h < 0 ? null : Math.round(h * 100) / 100;
}

// ---------------------------------------------------------------------------------------------------------
// Avaliação da cópia (relatórios + bundles já lidos do KV). Não restaura nada.
// readings = { combined: string|null, parts: [string|null x PARTS], bundles: { key: string|null } }
// Retorna { readable, failures[], day, parts[], tables_json{t: js}, manifest_rows{t:{rows}}, datasets[], totals }.
// readable=false só quando a fonte não pôde ser lida/entendida (NOT_AVAILABLE); integridade ruim = failures.
export function assessBackup(readings, { keyring = new Map() } = {}) {
  const out = { readable: false, failures: [], day: null, parts: [], tables_json: {}, manifest_rows: {}, datasets: [], totals: { tables: 0, rows: 0 }, excluded: [] };
  const fail = (w) => out.failures.push(w);
  const c = parse(readings?.combined);
  if (!c.ok || !isObj(c.v)) { out.reason = "combined_report_unreadable"; return out; }
  const R = c.v;
  if (R.schema !== "zevanory-backup/v1" || !isDay(R.day) || R.parts !== PARTS || typeof R.ok !== "boolean" || !isObj(R.neon) || !isInt(R.neon.tables) || !isInt(R.neon.rows) || !Array.isArray(R.neon.excluded)) {
    out.reason = "combined_report_malformed"; return out;
  }
  out.day = R.day;
  out.excluded = R.neon.excluded.filter((e) => isObj(e) && typeof e.table === "string" && TABLE_RE.test(e.table)).map((e) => e.table).sort();
  if (out.excluded.length !== R.neon.excluded.length) fail("excluded_list_malformed");
  if (R.ok !== true) fail("combined_report_not_ok");
  if (Array.isArray(R.failures) && R.failures.length) fail("combined_report_failures:" + R.failures.length);
  if (!Array.isArray(readings.parts) || readings.parts.length !== PARTS) { out.reason = "parts_unreadable"; return out; }
  const seen = new Set();
  for (let p = 0; p < PARTS; p++) {
    const pr = parse(readings.parts[p]);
    if (!pr.ok || !isObj(pr.v)) { out.reason = "part_report_unreadable:" + p; return out; }
    const P = pr.v;
    const fp = P.fp;
    if (P.schema !== "zevanory-backup/v1" || P.part !== p || !isDay(P.day) || !isIso(P.startedAt) || !isObj(P.neon) || !isInt(P.neon.tables) || !isInt(P.neon.rows)
      || typeof P.neon.manifest !== "string" || !isObj(fp) || typeof fp.bundleKey !== "string" || !isObj(fp.tables)) {
      out.reason = "part_report_malformed:" + p; return out;
    }
    const info = { part: p, day: P.day, started_at: P.startedAt, finished_at: isIso(P.finishedAt) ? P.finishedAt : null, tables: 0, rows: 0, manifest_ok: false, bundle_read: false, copia_cifrada: false };
    out.parts.push(info);
    if (P.day !== R.day) fail(`part_day_mismatch:${p}`);
    if (P.ok !== true || (Array.isArray(P.failures) && P.failures.length)) fail(`part_not_ok:${p}`);
    if (fp.bundleKey !== bundleKeyFor(R.day, p)) { fail(`bundle_key_mismatch:${p}`); continue; }
    if (!HEX16.test(P.neon.manifest)) fail(`part_manifest_digest_malformed:${p}`);
    const raw = readings.bundles?.[fp.bundleKey];
    if (raw == null) { fail(`bundle_missing:${p}`); continue; }
    let opened;
    try { opened = openBundleText(raw, { day: R.day, part: p, bundleKey: fp.bundleKey }, keyring); }
    catch (e) { fail(`bundle_${String(e?.code || "unreadable").replace(/[^a-z_]/g, "")}:${p}`); continue; }
    // Rebaixamento: a parte declara cópia cifrada e o bundle chegou em claro (alguém trocou o valor no KV).
    if (isObj(P.encryption) && P.encryption.state === "cifrado" && !opened.encrypted) { fail(`bundle_encryption_downgrade:${p}`); continue; }
    info.copia_cifrada = opened.encrypted === true;
    const b = parse(opened.text);
    if (!b.ok || !isObj(b.v)) { fail(`bundle_malformed:${p}`); continue; }
    info.bundle_read = true;
    const bundle = b.v;
    const manifest = fp.tables;
    const names = Object.keys(bundle).sort(), mnames = Object.keys(manifest).sort();
    for (const t of mnames) if (!(t in bundle)) fail(`table_in_manifest_missing_from_bundle:${t}`);
    const shaOf = {};
    let partRows = 0, partOk = true;
    for (const t of names) {
      const js = bundle[t];
      const m = manifest[t];
      const ds = { table: t, part: p, rows: null, hash_ok: false, in_manifest: isObj(m) };
      out.datasets.push(ds);
      if (!TABLE_RE.test(t)) { fail("table_name_invalid"); partOk = false; continue; }
      if (seen.has(t)) { fail(`duplicate_table:${t}`); partOk = false; continue; }
      seen.add(t);
      if (typeof js !== "string") { fail(`table_not_string:${t}`); partOk = false; continue; }
      if (!isObj(m) || typeof m.sha !== "string" || !HEX64.test(m.sha)) { fail(`table_without_manifest_hash:${t}`); partOk = false; continue; }
      const h = sha256(js);
      shaOf[t] = h;
      if (h !== m.sha) { fail(`hash_mismatch:${t}`); partOk = false; continue; }
      const rows = parse(js);
      if (!rows.ok || !Array.isArray(rows.v)) { fail(`table_not_array:${t}`); partOk = false; continue; }
      ds.rows = rows.v.length; ds.hash_ok = true;
      partRows += rows.v.length;
      out.tables_json[t] = js;
      out.manifest_rows[t] = { rows: rows.v.length };
    }
    info.tables = names.length; info.rows = partRows;
    info.manifest_ok = partOk && names.length === mnames.length && manifestHash(shaOf).slice(0, 16) === P.neon.manifest;
    if (!info.manifest_ok) fail(`part_manifest_digest_mismatch:${p}`);
    if (names.length !== P.neon.tables) fail(`part_table_count_mismatch:${p}`);
    if (partRows !== P.neon.rows) fail(`part_row_count_mismatch:${p}`);
  }
  out.readable = true;
  out.totals = { tables: Object.keys(out.tables_json).length, rows: Object.values(out.manifest_rows).reduce((s, m) => s + m.rows, 0) };
  if (out.datasets.length !== R.neon.tables) fail("total_table_count_mismatch");
  if (out.datasets.every((d) => d.hash_ok) && out.totals.rows !== R.neon.rows) fail("total_row_count_mismatch");
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Inventário da seção 9.1 (docs/p20/inventario-estado-critico.json). Malformado derruba.
export function validateInventory(doc) {
  if (!isObj(doc) || doc.schema !== SCHEMA_INVENTORY || !Array.isArray(doc.classes) || doc.classes.length === 0) throw new Error("INVENTORY_MALFORMED header");
  if (doc.status === "PROPOSTA" ? (doc.approved_by != null || doc.approved_at != null) : !(doc.status === "APPROVED" && typeof doc.approved_by === "string" && isDay(doc.approved_at))) {
    throw new Error("INVENTORY_MALFORMED approval");
  }
  const owner = new Map();
  for (const c of doc.classes) {
    if (!isObj(c) || typeof c.id !== "string" || typeof c.fonte_da_verdade !== "string" || typeof c.backup !== "string" || !Array.isArray(c.tables)) throw new Error("INVENTORY_MALFORMED class");
    for (const k of ["rpo_objetivo_h", "rto_objetivo_h"]) if (!(c[k] === null || (isNum(c[k]) && c[k] >= 0))) throw new Error("INVENTORY_MALFORMED " + k + " " + c.id);
    // RPO 0 só vale por origem versionada (SHA publicado = SHA do Git), nunca por tabela do backup do Neon: uma tabela
    // gravada em runtime numa classe de RPO 0 herdaria um objetivo que o backup diário não cumpre.
    if (c.rpo_objetivo_h === 0 && (c.tables.length !== 0 || c.rpo_base !== "origem_versionada")) throw new Error("INVENTORY_MALFORMED rpo_zero_sem_origem_versionada " + c.id);
    for (const t of c.tables) {
      if (!TABLE_RE.test(t)) throw new Error("INVENTORY_MALFORMED table " + t);
      if (owner.has(t)) throw new Error("INVENTORY_MALFORMED duplicate " + t);
      owner.set(t, c.id);
    }
  }
  return doc;
}

// Agrupa as tabelas restauradas por classe do inventário. Tabela sem classe é listada (nunca escondida).
export function byClass(datasets, restoredTables, inventory, measuredRpoH) {
  const owner = new Map();
  for (const c of inventory.classes) for (const t of c.tables) owner.set(t, c.id);
  const restored = new Set(restoredTables || []);
  const classes = {};
  for (const c of inventory.classes) {
    if (!c.tables.length || c.fora_do_backup_por_politica) continue;
    const ds = datasets.filter((d) => owner.get(d.table) === c.id);
    classes[c.id] = {
      tables_in_backup: ds.length,
      tables_hash_ok: ds.filter((d) => d.hash_ok).length,
      tables_restored: ds.filter((d) => restored.has(d.table)).length,
      rows: ds.reduce((s, d) => s + (d.rows || 0), 0),
      rpo_objetivo_h: c.rpo_objetivo_h, rto_objetivo_h: c.rto_objetivo_h,
      rpo_medido_h: ds.length && ds.every((d) => restored.has(d.table)) ? measuredRpoH : null,
    };
  }
  const unclassified = datasets.map((d) => d.table).filter((t) => !owner.has(t)).sort();
  return { classes, unclassified };
}

// ---------------------------------------------------------------------------------------------------------
// Registro de evidência (uma linha JSONL em p20/restore-drills-v1.jsonl do ramo evidence/b0-baseline).
// diarioFase: a fase do ensaio (runDrill sempre a passa). Ausente (chamadas antigas, registro NOT_AVAILABLE): vale a
// fase declarada no próprio diario e, sem diario, a sombra implícita dos registros antigos.
export function buildRecord({ mode, sourceRead, assessment, restore, startedAt, finishedAt, rtoSeconds, runId, sha, inventory, notAvailableReason, kvCopy = null, diario = null, diarioFase }) {
  const label = decideLabel(mode, sourceRead);
  const a = assessment || { readable: false, failures: [], datasets: [], parts: [], totals: { tables: 0, rows: 0 }, excluded: [] };
  // Fora da sombra, um diario ausente ou que não é objeto (null, lista, texto: implementação que não devolveu prova) é
  // registrado como estado "ausente" e cai na regra abaixo (reprova); o registro fica autodescritivo para a releitura
  // (validateRecord recusa um APROVADO com esse diario fora da sombra).
  const fase = diarioFase !== undefined ? diarioFase : isObj(diario) ? diario.fase : "sombra";
  if (a.readable && fase !== "sombra" && !isObj(diario)) diario = { fase, tabela: TABELA_RECONSTRUCAO, rpo_critico_medido_s: null, estado: "ausente", motivo: "diario_nao_devolvido" };
  const restoreOk = !!(restore && restore.ok === true);
  const failures = [...(a.failures || [])];
  if (a.readable && !failures.length && !restoreOk) failures.push("restore_failed:" + String(restore?.error || "not_run").replace(/[^A-Za-z0-9_.:,= -]/g, "").slice(0, 120));
  // Falhas da restauração do KV (kvRestoreDrill) reprovam o ensaio. As da cópia (assessKvCopy) já chegam em
  // a.failures e impedem a restauração. Cópia ausente (Worker anterior) não falha: só mantém a lacuna.
  if (a.readable && kvCopy && Array.isArray(kvCopy.failures)) for (const f of kvCopy.failures) if (!failures.includes(f)) failures.push(f);
  const rpo = a.readable ? rpoHours(a.parts.map((p) => p.started_at), startedAt) : null;
  if (a.readable && rpo == null) failures.push("rpo_not_computable");
  // NC-PR6-01: fora da fase "sombra" (fase "ativo" ou qualquer valor desconhecido), SÓ o estado "provado" com a prova
  // completa passa (lista positiva). nao_lido (token ausente, leitura ausente, incompleta ou com erro), nao_provado
  // (cadeia, reaplicação, conjunto) ou qualquer outro estado reprova o ensaio. Em "sombra" (padrão), só fica registrado.
  if (a.readable && isObj(diario) && diarioExigido(diario) && !diarioAprovado(diario)) failures.push("diario_sem_prova:" + limpo(diario.estado) + (diario.motivo ? ":" + limpo(diario.motivo) : ""));
  let verdict;
  if (!label || !a.readable) verdict = "NOT_AVAILABLE";
  else verdict = failures.length === 0 && restoreOk ? "APROVADO" : "REPROVADO";
  const restoredTables = restoreOk ? Object.keys(restore.tables || {}) : [];
  const cls = inventory ? byClass(a.datasets || [], restoredTables, inventory, rpo) : { classes: {}, unclassified: [] };
  const allEncrypted = !!(a.readable && a.parts.length === PARTS && a.parts.every((p) => p.copia_cifrada === true));
  const rec = {
    schema: SCHEMA_RECORD,
    label: verdict === "NOT_AVAILABLE" ? null : label, mode, verdict,
    started_at: startedAt, finished_at: finishedAt,
    run_id: String(runId || ""), sha: String(sha || ""),
    backup: a.readable ? {
      day: a.day,
      parts: a.parts.map((p) => ({ part: p.part, day: p.day, started_at: p.started_at, finished_at: p.finished_at, tables: p.tables, rows: p.rows, manifest_ok: p.manifest_ok, copia_cifrada: p.copia_cifrada === true })),
      tables: (a.datasets || []).length, rows: a.totals.rows, excluded_by_policy: a.excluded,
      copia_cifrada: allEncrypted,
    } : null,
    integrity: a.readable ? {
      tables_checked: (a.datasets || []).length,
      tables_hash_ok: (a.datasets || []).filter((d) => d.hash_ok).length,
      tables_hash_failed: (a.datasets || []).filter((d) => !d.hash_ok).map((d) => d.table).sort(),
    } : null,
    restore: restoreOk ? {
      target: "postgres efemero do runner (service container), banco descartavel",
      tables: restoredTables.length,
      rows: Object.values(restore.tables).reduce((s, v) => s + (isInt(v) ? v : 0), 0),
      content_hash_ok: true,
      preserved_without_schema: Array.isArray(restore.preserved_without_schema) ? restore.preserved_without_schema.slice().sort() : [],
      worker_schema_ready: restore.worker_schema_ready === true,
    } : { executed: !!restore, ok: false },
    rpo_hours: verdict === "NOT_AVAILABLE" ? null : rpo,
    rpo_over_26h: verdict === "NOT_AVAILABLE" || rpo == null ? null : rpo > MAX_AGE_H,
    rpo_over_48h_critical: verdict === "NOT_AVAILABLE" || rpo == null ? null : rpo > CRITICAL_AGE_H,
    rto_seconds: verdict === "APROVADO" && isNum(rtoSeconds) ? Math.round(rtoSeconds * 10) / 10 : null,
    rto_scope: "dados: leitura da copia + conferencia de hash + esquema + carga + conferencia num Postgres efemero; NAO inclui troca de DNS, reconfiguracao do Worker nem o tempo de aprovacao do Environment",
    by_class: cls.classes,
    unclassified_tables: cls.unclassified,
    kv_copy: a.readable && kvCopy?.proof ? kvCopy.proof : null,
    diario: verdict === "NOT_AVAILABLE" || !isObj(diario) ? null : diario,
    rpo_critico_medido_s: verdict === "APROVADO" && diarioProvado(diario) ? diario.rpo_critico_medido_s : null,
    not_covered: notCoveredFor(allEncrypted && verdict !== "NOT_AVAILABLE", verdict === "APROVADO" && !!kvCopy && kvCopy.failures.length === 0 && kvProofComplete(kvCopy.proof, a.day),
      verdict === "APROVADO" ? diario : (isObj(diario) && !diarioProvado(diario) ? diario : null)),
    scope_complete_9_1: false,
    failures: failures.slice(0, 50),
  };
  if (verdict === "NOT_AVAILABLE") rec.reason = String(notAvailableReason || a.reason || "source_not_read").replace(/[^A-Za-z0-9_.:,= -]/g, "").slice(0, 160);
  rec.scope_complete_9_1 = rec.not_covered.length === 0 && verdict === "APROVADO";
  return rec;
}

// Releitura estrita (publicação e coletor B0). Rótulo e veredito coerentes; nada de dado de linha.
export function validateRecord(r) {
  if (!isObj(r) || r.schema !== SCHEMA_RECORD) throw new Error("bad_schema");
  if (!VERDICTS.includes(r.verdict)) throw new Error("bad_verdict");
  if (!(r.label === null || LABELS.includes(r.label))) throw new Error("bad_label");
  if (!["producao", "sintetica"].includes(r.mode)) throw new Error("bad_mode");
  if (r.label === "ENSAIO_EM_PRODUCAO" && r.mode !== "producao") throw new Error("label_mode_mismatch");
  if (r.label === "SINTETICA" && r.mode !== "sintetica") throw new Error("label_mode_mismatch");
  if (r.label === null && r.verdict !== "NOT_AVAILABLE") throw new Error("unlabelled_measurement");
  if (r.label !== null && r.verdict === "NOT_AVAILABLE") throw new Error("labelled_not_available");
  if (!isIso(r.started_at) || !isIso(r.finished_at) || Date.parse(r.finished_at) < Date.parse(r.started_at)) throw new Error("bad_times");
  if (!Array.isArray(r.not_covered) || typeof r.scope_complete_9_1 !== "boolean" || (r.scope_complete_9_1 && r.not_covered.length)) throw new Error("bad_scope");
  if (!Array.isArray(r.failures)) throw new Error("bad_failures");
  const ccPending = r.not_covered.some(isCopiaCifrada);
  if (r.verdict === "NOT_AVAILABLE" && !ccPending) throw new Error("copia_cifrada_unproven");
  const kvPending = r.not_covered.some(isCopiaKv);
  if (r.verdict === "NOT_AVAILABLE" && !kvPending) throw new Error("copia_kv_unproven");
  // diario_d1 só sai de not_covered com a prova completa do diário num ensaio APROVADO; registros antigos (sem o campo
  // diario) continuam válidos enquanto a lacuna estiver listada.
  const ddPending = r.not_covered.some(isDiarioD1);
  if (!ddPending && !(r.verdict === "APROVADO" && diarioProvado(r.diario) && r.rpo_critico_medido_s === r.diario.rpo_critico_medido_s)) throw new Error("diario_d1_unproven");
  if (ddPending && r.rpo_critico_medido_s != null) throw new Error("diario_d1_rpo_sem_prova");
  // Fora da sombra, um ensaio APROVADO precisa da prova do diário (registros antigos sem o campo diario: sombra implícita).
  if (r.verdict === "APROVADO" && isObj(r.diario) && diarioExigido(r.diario) && !diarioAprovado(r.diario)) throw new Error("diario_ativo_sem_prova");
  if (r.verdict === "NOT_AVAILABLE") {
    if (r.rpo_hours !== null || r.rto_seconds !== null || typeof r.reason !== "string") throw new Error("not_available_with_values");
    return r;
  }
  const b = r.backup, i = r.integrity;
  if (!isObj(b) || !isDay(b.day) || !Array.isArray(b.parts) || b.parts.length !== PARTS || !isInt(b.tables) || !isInt(b.rows)) throw new Error("bad_backup");
  // Registros antigos não têm copia_cifrada (ausente = false); retirar a lacuna exige todas as partes cifradas.
  if (!ccPending && !(b.copia_cifrada === true && b.parts.every((p) => isObj(p) && p.copia_cifrada === true))) throw new Error("copia_cifrada_unproven");
  // Lacuna da cópia KV -> Neon só some com a prova completa, num ensaio APROVADO, do mesmo dia da cópia, e cifrada
  // quando a cópia do dia é cifrada (registros antigos não têm kv_copy: a lacuna precisa estar presente).
  if (!kvPending && !(r.verdict === "APROVADO" && kvProofComplete(r.kv_copy, b.day) && (b.copia_cifrada !== true || r.kv_copy.copia_cifrada === true))) throw new Error("copia_kv_unproven");
  if (!isObj(i) || !isInt(i.tables_checked) || !isInt(i.tables_hash_ok) || i.tables_hash_ok > i.tables_checked || !Array.isArray(i.tables_hash_failed)) throw new Error("bad_integrity");
  if (!(isNum(r.rpo_hours) && r.rpo_hours >= 0) && !(r.verdict === "REPROVADO" && r.rpo_hours === null && r.failures.includes("rpo_not_computable"))) throw new Error("bad_rpo");
  if (r.verdict === "APROVADO") {
    if (r.failures.length || i.tables_hash_ok !== i.tables_checked || i.tables_hash_failed.length) throw new Error("approved_with_failures");
    if (!isObj(r.restore) || r.restore.content_hash_ok !== true || !isInt(r.restore.tables) || r.restore.tables !== i.tables_checked) throw new Error("approved_without_full_restore");
    if (!isNum(r.rto_seconds) || r.rto_seconds <= 0) throw new Error("approved_without_rto");
  } else if (!r.failures.length) throw new Error("rejected_without_failure");
  return r;
}

export function parseDrillHistory(text) {
  const out = [];
  String(text || "").replace(/\r\n/g, "\n").split("\n").forEach((line, n) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { throw new Error(`DRILL_HISTORY_MALFORMED line ${n + 1}: invalid_json`); }
    try { out.push(validateRecord(o)); } catch (e) { throw new Error(`DRILL_HISTORY_MALFORMED line ${n + 1}: ${e.message}`); }
  });
  return out;
}
